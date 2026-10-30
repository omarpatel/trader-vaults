// ── pulse: lifecycle discovery board ───────────────────────────────
// Three columns of real market data, one 20s-cached board:
//   new        → pump.fun frontend API, newest bonding-curve launches
//   graduating → pump.fun coins furthest along their bonding curve
//   migrated   → GeckoTerminal new_pools filtered to post-graduation
//                AMM pools (pumpswap / raydium / meteora)
// pump.fun hosts rotate (v3 → v2 → v1); if all are unreachable the
// pump columns fall back to GeckoTerminal (new_pools / trending_pools).
// Every upstream call has a 5s timeout and each column is independently
// try/caught — a failed column renders as [] instead of failing the
// board. Nothing here is ever fabricated: cards only carry fields the
// upstream actually returned (or arithmetic derived from them).

import type { PulseBoard, PulseCard, PulseColumnId } from "@trader-vaults/shared";
import { getOrSet } from "../cache.js";
import { gtFetch } from "./gtBudget.js";

const GT_BASE = "https://api.geckoterminal.com/api/v2";
const PUMP_HOSTS = [
  "https://frontend-api-v3.pump.fun",
  "https://frontend-api-v2.pump.fun",
  "https://frontend-api.pump.fun",
];

const FETCH_TIMEOUT_MS = 5_000;
const BOARD_TTL_MS = 20_000;
const COLUMN_LIMIT = 24;
// pump.fun caps this endpoint at ~70 rows/request regardless of `limit`
const PUMP_PAGE = 70;

/** pump.fun only — GeckoTerminal calls go through gtJson/the budgeter. */
async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

// The board is a background/burst surface, so its GT calls run at low
// priority: when the shared bucket is dry they fail fast (BudgetExhausted)
// and the affected column degrades to [] instead of stealing budget from
// charts and stats.
async function gtJson(url: string): Promise<unknown> {
  const res = await gtFetch(url, { priority: "low", timeoutMs: FETCH_TIMEOUT_MS });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// ── pump.fun ───────────────────────────────────────────────────────

interface PumpCoin {
  mint?: string;
  symbol?: string;
  name?: string;
  image_uri?: string | null;
  /** epoch ms */
  created_timestamp?: number;
  complete?: boolean;
  usd_market_cap?: number;
  real_token_reserves?: number;
  total_supply?: number;
}

/**
 * Fetch a /coins page, rotating across the known frontend hosts so a
 * Cloudflare block or host retirement degrades to the next host, not
 * to a dead column. Remembers the first host that answered (10 min).
 */
let workingPumpHost: string | null = null;
async function pumpCoins(query: string): Promise<PumpCoin[]> {
  const hosts = workingPumpHost
    ? [workingPumpHost, ...PUMP_HOSTS.filter((h) => h !== workingPumpHost)]
    : PUMP_HOSTS;
  let lastErr: unknown = new Error("no pump.fun hosts configured");
  for (const host of hosts) {
    try {
      const body = await fetchJson(`${host}/coins?${query}`);
      if (!Array.isArray(body)) throw new Error(`unexpected body from ${host}`);
      workingPumpHost = host;
      return body as PumpCoin[];
    } catch (err) {
      lastErr = err;
      if (host === workingPumpHost) workingPumpHost = null;
    }
  }
  throw lastErr;
}

/** Which pump.fun host served the last successful request (for logs/report). */
export function currentPumpHost(): string | null {
  return workingPumpHost;
}

// Every standard pump.fun launch starts with 793.1M sellable tokens
// (793.1e12 base units at 6 decimals) in real_token_reserves, out of a
// 1e15 total supply; the coin graduates when the curve sells out.
const PUMP_INITIAL_REAL_TOKEN_RESERVES = 793_100_000_000_000;
const PUMP_STANDARD_TOTAL_SUPPLY = 1_000_000_000_000_000;

/**
 * Bonding-curve progress 0-100.
 *
 * Primary formula: share of the initial sellable reserve already sold —
 *   pct = 100 × (1 − real_token_reserves / 793.1e12)
 * This is the formula pump.fun's own frontend uses and it is price-
 * independent: a USD-market-cap ratio against the "~$69k graduation cap"
 * drifts with the SOL price (live data shows curves finishing well under
 * $20k mcap when SOL is cheap), while token-reserve progress is exact.
 *
 * Fallback (reserves missing or nonstandard supply): scale usd_market_cap
 * toward the nominal $69k graduation cap, pinned below 100 so only a
 * `complete` flag can claim a finished curve.
 */
function curveProgressPct(c: PumpCoin): number | undefined {
  const reserves = c.real_token_reserves;
  const standardSupply =
    c.total_supply === undefined || c.total_supply === PUMP_STANDARD_TOTAL_SUPPLY;
  if (typeof reserves === "number" && Number.isFinite(reserves) && reserves >= 0 && standardSupply) {
    const pct = 100 * (1 - reserves / PUMP_INITIAL_REAL_TOKEN_RESERVES);
    return Math.min(100, Math.max(0, pct));
  }
  return undefined;
}

function bondingPct(c: PumpCoin): number | undefined {
  if (c.complete) return 100;
  const exact = curveProgressPct(c);
  if (exact !== undefined) return exact;
  const mcap = c.usd_market_cap;
  if (typeof mcap === "number" && mcap > 0) {
    return Math.min(99, (mcap / 69_000) * 100);
  }
  return undefined;
}

function pumpCard(c: PumpCoin, now: number): PulseCard | null {
  const mint = c.mint;
  if (!mint) return null;
  const mcapUsd = num(c.usd_market_cap);
  // pump.fun quotes mcap over the full (fixed) supply, so implied price
  // is mcap ÷ total tokens (total_supply is base units at 6 decimals).
  const totalTokens =
    typeof c.total_supply === "number" && c.total_supply > 0
      ? c.total_supply / 1e6
      : undefined;
  const priceUsd =
    mcapUsd !== undefined && totalTokens ? mcapUsd / totalTokens : undefined;
  const created = num(c.created_timestamp);
  return {
    mint,
    symbol: c.symbol || mint.slice(0, 4),
    name: c.name || c.symbol || "Unknown token",
    ...(c.image_uri ? { imageUrl: c.image_uri } : {}),
    ...(created !== undefined
      ? { ageSec: Math.max(0, Math.round((now - created) / 1000)) }
      : {}),
    ...(priceUsd !== undefined ? { priceUsd } : {}),
    ...(mcapUsd !== undefined ? { mcapUsd } : {}),
    ...(bondingPct(c) !== undefined ? { bondingPct: bondingPct(c) } : {}),
    source: "pumpfun",
  };
}

/** Newest pump.fun launches, newest first. */
async function pumpNewColumn(now: number): Promise<PulseCard[]> {
  const coins = await pumpCoins(
    `offset=0&limit=${COLUMN_LIMIT}&sort=created_timestamp&order=DESC&includeNsfw=false`,
  );
  return coins
    .map((c) => pumpCard(c, now))
    .filter((c): c is PulseCard => c !== null)
    .slice(0, COLUMN_LIMIT);
}

// "Final stretch" selection: the obvious `sort=market_cap` query is
// unusable live — it returns hundreds of stale not-complete rows with
// $100k+ market caps (many with an untouched curve), and the USD
// graduation band moves with SOL anyway. Instead we page the most
// recently *traded* incomplete coins (2 × 70 rows) and keep the ones
// ≥50% along their bonding curve, sorted by progress — coins that are
// actually trading and measurably close to graduating.
const GRADUATING_MIN_PCT = 50;

async function pumpGraduatingColumn(now: number): Promise<PulseCard[]> {
  const query = (offset: number) =>
    `offset=${offset}&limit=${PUMP_PAGE}&sort=last_trade_timestamp&order=DESC&includeNsfw=false&complete=false`;
  const pages = await Promise.all([pumpCoins(query(0)), pumpCoins(query(PUMP_PAGE))]);
  const seen = new Set<string>();
  const rows: Array<{ coin: PumpCoin; pct: number }> = [];
  for (const coin of pages.flat()) {
    if (!coin.mint || coin.complete !== false || seen.has(coin.mint)) continue;
    seen.add(coin.mint);
    // Reserve-derived progress ONLY here: the mcap fallback would pin
    // stale reserve-less rows at 99 and float them to the top.
    const pct = curveProgressPct(coin);
    // pct === 100 while complete=false is a lagging flag (curve already
    // sold out) — that belongs in "migrated", not here.
    if (pct === undefined || pct < GRADUATING_MIN_PCT || pct >= 100) continue;
    rows.push({ coin, pct });
  }
  rows.sort((a, b) => b.pct - a.pct);
  return rows
    .slice(0, COLUMN_LIMIT)
    .map(({ coin }) => pumpCard(coin, now))
    .filter((c): c is PulseCard => c !== null);
}

// ── GeckoTerminal ──────────────────────────────────────────────────

interface GtPool {
  attributes?: {
    address?: string;
    pool_created_at?: string;
    base_token_price_usd?: string;
    fdv_usd?: string;
    reserve_in_usd?: string;
    price_change_percentage?: { m5?: string };
    transactions?: { m5?: { buys?: number; sells?: number } };
    volume_usd?: { h24?: string };
  };
  relationships?: {
    base_token?: { data?: { id?: string } };
    dex?: { data?: { id?: string } };
  };
}

interface GtIncluded {
  id?: string;
  type?: string;
  attributes?: { address?: string; symbol?: string; name?: string; image_url?: string | null };
}

interface GtPoolPage {
  data?: GtPool[];
  included?: GtIncluded[];
}

/** Pool quote sides we never want to present as the card's token. */
const QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112", // wSOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

/** Post-graduation venues: pump.fun's AMM plus the raydium/meteora pools
 *  bonding-curve tokens migrate into. `pump-fun` itself is the curve. */
// Platform mandate: pump.fun tokens only. A graduated pump token lives on
// pumpswap, or (pre-pumpswap era / re-pooled) carries the "pump" mint
// suffix wherever it trades.
const isPumpMint = (mint: string) => mint.toLowerCase().endsWith("pump");

function isPumpPool(pool: GtPool): boolean {
  const dex = pool.relationships?.dex?.data?.id ?? "";
  const mint = (pool.relationships?.base_token?.data?.id ?? "").replace(/^solana_/, "");
  return dex === "pumpswap" || dex === "pump-fun" || isPumpMint(mint);
}

function gtPoolCard(
  pool: GtPool,
  tokensById: Map<string, GtIncluded>,
  now: number,
): PulseCard | null {
  const attrs = pool.attributes ?? {};
  const tokenId = pool.relationships?.base_token?.data?.id;
  if (!tokenId) return null;
  const token = tokensById.get(tokenId)?.attributes;
  // token id is "solana_<mint>" — attributes.address is authoritative
  const mint = token?.address ?? tokenId.replace(/^solana_/, "");
  if (!mint || QUOTE_MINTS.has(mint)) return null;
  const createdMs = attrs.pool_created_at ? Date.parse(attrs.pool_created_at) : NaN;
  const imageUrl = token?.image_url;
  const buys = num(attrs.transactions?.m5?.buys);
  const sells = num(attrs.transactions?.m5?.sells);
  const priceUsd = num(attrs.base_token_price_usd);
  const mcapUsd = num(attrs.fdv_usd);
  const liquidityUsd = num(attrs.reserve_in_usd);
  const volume24hUsd = num(attrs.volume_usd?.h24);
  const change5mPct = num(attrs.price_change_percentage?.m5);
  return {
    mint,
    symbol: token?.symbol ?? mint.slice(0, 4),
    name: token?.name ?? token?.symbol ?? "Unknown token",
    ...(imageUrl && !imageUrl.includes("missing.png") ? { imageUrl } : {}),
    ...(Number.isFinite(createdMs)
      ? { ageSec: Math.max(0, Math.round((now - createdMs) / 1000)) }
      : {}),
    ...(priceUsd !== undefined ? { priceUsd } : {}),
    ...(mcapUsd !== undefined ? { mcapUsd } : {}),
    ...(liquidityUsd !== undefined ? { liquidityUsd } : {}),
    ...(volume24hUsd !== undefined ? { volume24hUsd } : {}),
    ...(change5mPct !== undefined ? { change5mPct } : {}),
    ...(buys !== undefined && sells !== undefined
      ? { txns5m: { buys, sells } }
      : {}),
    ...(attrs.address ? { pairAddress: attrs.address } : {}),
    source: "geckoterminal",
  };
}

function indexIncluded(pages: GtPoolPage[]): Map<string, GtIncluded> {
  const byId = new Map<string, GtIncluded>();
  for (const page of pages) {
    for (const inc of page.included ?? []) {
      if (inc?.id && inc.type === "token") byId.set(inc.id, inc);
    }
  }
  return byId;
}

/** new_pools pages 1-3 (20 pools each), fetched once per board build. */
async function gtNewPoolPages(): Promise<GtPoolPage[]> {
  return Promise.all(
    [1, 2, 3].map(
      (page) =>
        gtJson(
          `${GT_BASE}/networks/solana/new_pools?page=${page}&include=base_token,dex`,
        ) as Promise<GtPoolPage>,
    ),
  );
}

function gtCardsFrom(
  pages: GtPoolPage[],
  now: number,
  keep: (pool: GtPool) => boolean,
): PulseCard[] {
  const tokensById = indexIncluded(pages);
  const out: PulseCard[] = [];
  const seen = new Set<string>();
  for (const pool of pages.flatMap((p) => p.data ?? [])) {
    if (out.length >= COLUMN_LIMIT) break;
    if (!keep(pool)) continue;
    const card = gtPoolCard(pool, tokensById, now);
    if (!card || seen.has(card.mint)) continue;
    seen.add(card.mint);
    out.push(card);
  }
  return out;
}

/** trending_pools mapped to cards — fallback when pump.fun is blocked. */
async function gtTrendingColumn(now: number): Promise<PulseCard[]> {
  const page = (await gtJson(
    `${GT_BASE}/networks/solana/trending_pools?page=1&include=base_token,dex`,
  )) as GtPoolPage;
  return gtCardsFrom([page], now, () => true);
}

// ── board assembly ─────────────────────────────────────────────────

export async function getPulseBoard(): Promise<PulseBoard> {
  return getOrSet("pulse:board", BOARD_TTL_MS, buildBoard);
}

async function buildBoard(): Promise<PulseBoard> {
  const now = Date.now();

  const [pumpNew, pumpGraduating, gtPages] = await Promise.allSettled([
    pumpNewColumn(now),
    pumpGraduatingColumn(now),
    gtNewPoolPages(),
  ]);
  const pumpOk = pumpNew.status === "fulfilled";
  const newPoolPages = gtPages.status === "fulfilled" ? gtPages.value : [];

  // "new": pump.fun primary; GeckoTerminal new pools when it's blocked.
  let newCards: PulseCard[] = [];
  if (pumpOk) {
    newCards = pumpNew.value;
  } else {
    try {
      newCards = gtCardsFrom(newPoolPages, now, () => true);
    } catch {
      newCards = [];
    }
  }

  // "graduating": pump.fun curve progress; GT trending when blocked.
  let graduatingTitle = "Final stretch";
  let graduatingCards: PulseCard[] = [];
  if (pumpGraduating.status === "fulfilled") {
    graduatingCards = pumpGraduating.value;
  } else {
    graduatingTitle = "Trending";
    try {
      graduatingCards = await gtTrendingColumn(now);
    } catch {
      graduatingCards = [];
    }
  }

  // "migrated": newest pools on post-graduation AMMs. If the dex filter
  // yields nothing (or GT was down), degrade to the raw newest list.
  let migratedTitle = "Migrated";
  let migratedCards: PulseCard[] = [];
  try {
    // pump.fun tokens only — even in the degraded no-pump.fun-API case
    // the column never shows non-pump pools.
    migratedCards = gtCardsFrom(newPoolPages, now, isPumpPool);
  } catch {
    migratedCards = [];
  }

  const columns: PulseBoard["columns"] = [
    { id: "new" satisfies PulseColumnId, title: "New pairs", cards: newCards },
    { id: "graduating", title: graduatingTitle, cards: graduatingCards },
    { id: "migrated", title: migratedTitle, cards: migratedCards },
  ];
  return { columns, fetchedAt: now };
}
