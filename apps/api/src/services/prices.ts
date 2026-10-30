// ── multi-tier price oracle ────────────────────────────────────────
// P0 ships 3 of the 4 planned tiers:
//   1. Jupiter Price v3   — fast, keyless at low rate, batchable
//   2. Birdeye            — only if BIRDEYE_API_KEY is set
//   3. DexScreener        — keyless; also our metadata source
//   4. (future) on-chain pool read via SOLANA_RPC_URL
// Every tier is wrapped in try/catch with a 4s abort. On total failure
// we return source:"none" with zeroed numbers — we NEVER fabricate a
// price. Token marks cache 5s, metadata 300s, SOL/USD 15s.

import type { TokenInfo } from "@trader-vaults/shared";
import { cacheGet, cacheSet, getOrSet, recallGood, rememberGood } from "../cache.js";
import { env } from "../env.js";

export const SOL_MINT = "So11111111111111111111111111111111111111112";

const FETCH_TIMEOUT_MS = 4_000;
const TOKEN_TTL_MS = 5_000;
const META_TTL_MS = 300_000;
const SOL_PRICE_TTL_MS = 15_000;

interface TierPrice {
  priceUsd: number;
  change24hPct?: number;
  source: "jupiter" | "birdeye" | "pumpfun";
}

interface DexScreenerMeta {
  symbol?: string;
  name?: string;
  imageUrl?: string;
  dex?: string;
  pairAddress?: string;
  priceUsd?: number;
  mcapUsd?: number;
  liquidityUsd?: number;
  volume24hUsd?: number;
  change24hPct?: number;
}

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

// ── tier 1: Jupiter Price v3 ───────────────────────────────────────
// GET https://api.jup.ag/price/v3?ids=<mint,...>
// Response maps mint → { usdPrice, decimals, priceChange24h, ... }.
// IMPORTANT: mints not traded in ~7 days are simply OMITTED from the
// response — absence means "unreliable", so callers fall through to
// the next tier rather than treating it as price 0.

async function jupiterPrices(mints: string[]): Promise<Map<string, TierPrice>> {
  const out = new Map<string, TierPrice>();
  if (mints.length === 0) return out;
  const headers: Record<string, string> = {};
  if (env.jupiterApiKey) headers["x-api-key"] = env.jupiterApiKey;
  try {
    const body = (await fetchJson(
      `https://api.jup.ag/price/v3?ids=${mints.map(encodeURIComponent).join(",")}`,
      headers,
    )) as Record<string, { usdPrice?: number; priceChange24h?: number } | undefined>;
    for (const mint of mints) {
      const row = body?.[mint];
      const priceUsd = Number(row?.usdPrice);
      if (Number.isFinite(priceUsd) && priceUsd > 0) {
        out.set(mint, {
          priceUsd,
          change24hPct: Number.isFinite(Number(row?.priceChange24h))
            ? Number(row?.priceChange24h)
            : undefined,
          source: "jupiter",
        });
      }
    }
  } catch {
    // tier down or rate-limited — fall through
  }
  return out;
}

// ── tier 2: Birdeye (keyed only) ───────────────────────────────────

async function birdeyePrice(mint: string): Promise<TierPrice | undefined> {
  const key = env.birdeyeApiKey;
  if (!key) return undefined;
  try {
    const body = (await fetchJson(
      `https://public-api.birdeye.so/defi/price?address=${encodeURIComponent(mint)}`,
      { "X-API-KEY": key, "x-chain": "solana" },
    )) as { success?: boolean; data?: { value?: number; priceChange24h?: number } };
    const priceUsd = Number(body?.data?.value);
    if (body?.success && Number.isFinite(priceUsd) && priceUsd > 0) {
      return {
        priceUsd,
        change24hPct: Number.isFinite(Number(body?.data?.priceChange24h))
          ? Number(body?.data?.priceChange24h)
          : undefined,
        source: "birdeye",
      };
    }
  } catch {
    // fall through
  }
  return undefined;
}

// ── tier 3: DexScreener (keyless; price + metadata) ────────────────
// Pair selection: only pairs whose BASE token is the requested mint
// (quote-side pairs price the other token), preferring pairs quoted in
// a trusted quote (wSOL/USDC/USDT) before ranking by liquidity.usd.
// The trusted-quote gate matters: poisoned pools quoted in a worthless
// token report fabricated liquidity (live BONK example: a "Bonk/LTGA"
// orca pool claimed $236k liquidity on $0.05 of volume and priced BONK
// at a ~$1T market cap) and would otherwise win the liquidity sort.

/** Quotes whose USD valuation we trust for liquidity/price ranking. */
export const TRUSTED_QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112", // wSOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

/** Anything above this is upstream garbage, not a market cap. */
export const MCAP_SANITY_MAX_USD = 500_000_000_000; // $500B

interface DexScreenerPair {
  dexId?: string;
  pairAddress?: string;
  priceUsd?: string;
  fdv?: number;
  marketCap?: number;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  baseToken?: { address?: string; symbol?: string; name?: string };
  quoteToken?: { address?: string; symbol?: string };
  info?: { imageUrl?: string };
}

async function dexScreenerLookup(mint: string): Promise<DexScreenerMeta | undefined> {
  try {
    const body = (await fetchJson(
      `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`,
    )) as { pairs?: DexScreenerPair[] | null };
    const pairs = (body?.pairs ?? []).filter(
      (p) => p?.baseToken?.address === mint && (p.marketCap ?? p.fdv) !== undefined,
    );
    if (pairs.length === 0) return undefined;
    const trusted = pairs.filter((p) => TRUSTED_QUOTE_MINTS.has(p.quoteToken?.address ?? ""));
    const ranked = trusted.length > 0 ? trusted : pairs;
    ranked.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const best = ranked[0]!;
    const priceUsd = Number(best.priceUsd);
    // prefer circulating marketCap, fall back to fdv; drop garbage
    const rawMcap = best.marketCap ?? best.fdv;
    const mcapUsd =
      rawMcap !== undefined && rawMcap > 0 && rawMcap <= MCAP_SANITY_MAX_USD
        ? rawMcap
        : undefined;
    return {
      // upstream metadata carries stray whitespace ("Fartcoin ") — trim at
      // the source so it never reaches symbols, tapes, or activity strings
      symbol: best.baseToken?.symbol?.trim() || undefined,
      name: best.baseToken?.name?.trim() || undefined,
      imageUrl: best.info?.imageUrl,
      dex: best.dexId,
      pairAddress: best.pairAddress,
      priceUsd: Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : undefined,
      mcapUsd,
      liquidityUsd: best.liquidity?.usd,
      volume24hUsd: best.volume?.h24,
      change24hPct: best.priceChange?.h24,
    };
  } catch {
    return undefined;
  }
}


// ── pump.fun metadata (pre-graduation tier) ────────────────────────
// DexScreener and Jupiter only know a token once it has an indexed pool,
// so a coin minted seconds ago renders as "<4-char mint> / Unknown token"
// with no market cap — exactly the tokens Pulse exists to surface. The
// launchpad itself knows them from block zero, and this platform is
// pump.fun-only, so ask the source.

const PUMP_COIN_BASE = "https://frontend-api-v3.pump.fun/coins";

interface PumpCoin {
  name?: string;
  symbol?: string;
  image_uri?: string;
  usd_market_cap?: number;
  complete?: boolean;
}

async function pumpFunLookup(mint: string): Promise<DexScreenerMeta | undefined> {
  try {
    const res = await fetch(`${PUMP_COIN_BASE}/${encodeURIComponent(mint)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const c = (await res.json()) as PumpCoin;
    const symbol = c.symbol?.trim();
    const name = c.name?.trim();
    if (!symbol && !name) return undefined;
    const mcap = Number(c.usd_market_cap);
    return {
      ...(symbol ? { symbol } : {}),
      ...(name ? { name } : {}),
      ...(c.image_uri ? { imageUrl: c.image_uri } : {}),
      ...(Number.isFinite(mcap) && mcap > 0 && mcap <= MCAP_SANITY_MAX_USD
        ? { mcapUsd: mcap }
        : {}),
      dex: c.complete ? "pumpswap" : "pump.fun",
    };
  } catch {
    return undefined;
  }
}


// ── tier 3.5: pump.fun last trade (pre-graduation price) ───────────
// Jupiter/Birdeye/DexScreener only price pool-indexed tokens, so a coin
// on its bonding curve has no mark and every trade against it is refused
// (422) — including Pulse's quick-buy, which exists to trade exactly
// these. pump.fun's own candle close IS the authoritative last trade and
// is the same series the chart renders, so the mark and the chart agree.
// This is a real observed price, not a derivation.

async function pumpFunPrice(mint: string): Promise<number | undefined> {
  try {
    const res = await fetch(
      `https://swap-api.pump.fun/v1/coins/${encodeURIComponent(mint)}/candles?interval=1m&limit=1&currency=USD`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!res.ok) return undefined;
    const rows = (await res.json()) as { close?: string | number }[];
    const close = Number(rows?.[rows.length - 1]?.close);
    return Number.isFinite(close) && close > 0 ? close : undefined;
  } catch {
    return undefined;
  }
}

/** Metadata (symbol/name/image/pair) — slow-moving, cached 300s. */
async function tokenMeta(mint: string): Promise<DexScreenerMeta> {
  return getOrSet(`meta:${mint}`, META_TTL_MS, async () => {
    const dex = await dexScreenerLookup(mint);
    // A pool-indexed token is fully described by DexScreener. Anything
    // missing an identity is either brand new or unindexed — ask the
    // launchpad, and let each source fill the other's gaps.
    if (dex?.symbol && dex.name && dex.mcapUsd !== undefined) return dex;
    const pump = await pumpFunLookup(mint);
    if (!pump) return dex ?? {};
    return { ...pump, ...Object.fromEntries(Object.entries(dex ?? {}).filter(([, v]) => v !== undefined)) };
  });
}

// ── SOL/USD (for priceSol conversion) ──────────────────────────────

export async function solPriceUsd(): Promise<number> {
  const cached = cacheGet<number>("solUsd");
  if (cached !== undefined) return cached;
  const jup = await jupiterPrices([SOL_MINT]);
  let price = jup.get(SOL_MINT)?.priceUsd ?? 0;
  if (price <= 0) {
    // fallback: DexScreener wSOL pairs
    const meta = await dexScreenerLookup(SOL_MINT);
    price = meta?.priceUsd ?? 0;
  }
  if (price > 0) {
    rememberGood("solUsd", price);
    return cacheSet("solUsd", price, SOL_PRICE_TTL_MS);
  }
  // both tiers failed — a zero here would zero priceSol for EVERY token,
  // so fall back to the last good SOL price instead
  return recallGood<number>("solUsd")?.value ?? 0;
}

// ── composition ────────────────────────────────────────────────────

function compose(
  mint: string,
  price: TierPrice | undefined,
  meta: DexScreenerMeta,
  solUsd: number,
): TokenInfo {
  // Tier 3 acts as the price source when tiers 1–2 had nothing.
  const priceUsd = price?.priceUsd ?? meta.priceUsd ?? 0;
  const source: TokenInfo["source"] =
    price?.source ?? (meta.priceUsd !== undefined ? "dexscreener" : "none");
  // second sanity gate at the display boundary: an absurd mcap is
  // dropped entirely — undefined beats confidently-wrong.
  const mcapUsd =
    meta.mcapUsd !== undefined && meta.mcapUsd > 0 && meta.mcapUsd <= MCAP_SANITY_MAX_USD
      ? meta.mcapUsd
      : undefined;
  return {
    mint,
    symbol: meta.symbol ?? (mint === SOL_MINT ? "SOL" : mint.slice(0, 4)),
    name: meta.name ?? (mint === SOL_MINT ? "Solana" : "Unknown token"),
    priceUsd: source === "none" ? 0 : priceUsd,
    // never divide by a zero/NaN SOL price (solUsd is 15s-fresh at most)
    priceSol: source === "none" || !(solUsd > 0) ? 0 : priceUsd / solUsd,
    mcapUsd,
    liquidityUsd: meta.liquidityUsd,
    change24hPct: price?.change24hPct ?? meta.change24hPct,
    volume24hUsd: meta.volume24hUsd,
    imageUrl: meta.imageUrl,
    dex: meta.dex,
    pairAddress: meta.pairAddress,
    source,
    fetchedAt: Math.floor(Date.now() / 1000),
  };
}

async function resolveOne(
  mint: string,
  jupiter: Map<string, TierPrice>,
  solUsd: number,
): Promise<TokenInfo> {
  const cached = cacheGet<TokenInfo>(`token:${mint}`);
  if (cached) return cached;

  let price: TierPrice | undefined = jupiter.get(mint); // tier 1
  if (!price) price = await birdeyePrice(mint); // tier 2
  const meta = await tokenMeta(mint); // tier 3 doubles as metadata

  // tier 3.5 — bonding-curve tokens have no pool and therefore no mark
  // from any aggregator; the launchpad's own last trade is authoritative
  if (!price && meta.priceUsd === undefined) {
    const pumpUsd = await pumpFunPrice(mint);
    if (pumpUsd !== undefined) price = { priceUsd: pumpUsd, source: "pumpfun" };
  }

  const info = compose(mint, price, meta, solUsd);
  return cacheSet(`token:${mint}`, info, TOKEN_TTL_MS);
}

/** Oracle entry point for a single mint. */
export async function getTokenInfo(mint: string): Promise<TokenInfo> {
  const [infos] = [await getTokenInfos([mint])];
  return infos[0]!;
}

/** Batch entry point — one Jupiter call for every uncached mint. */
export async function getTokenInfos(mints: string[]): Promise<TokenInfo[]> {
  const unique = [...new Set(mints)];
  const solUsd = await solPriceUsd();
  const uncached = unique.filter((m) => cacheGet<TokenInfo>(`token:${m}`) === undefined);
  const jupiter = await jupiterPrices(uncached);
  const byMint = new Map<string, TokenInfo>();
  await Promise.all(
    unique.map(async (mint) => {
      byMint.set(mint, await resolveOne(mint, jupiter, solUsd));
    }),
  );
  return mints.map((m) => byMint.get(m)!);
}
