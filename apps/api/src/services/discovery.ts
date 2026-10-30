// ── token discovery: search + trending ─────────────────────────────
// Search rides DexScreener's keyless /search (cached 60s per query);
// a raw base58 mint short-circuits through the price oracle instead.
// Trending rides GeckoTerminal's trending_pools (cached 120s), and on
// failure falls back to oracle marks for the seeded well-known mints —
// the endpoint never 500s.

import type { TokenSearchResult, TrendingToken } from "@trader-vaults/shared";
import { getOrSet } from "../cache.js";
import { getTokenInfo, MCAP_SANITY_MAX_USD, TRUSTED_QUOTE_MINTS } from "./prices.js";

const FETCH_TIMEOUT_MS = 8_000;
const SEARCH_TTL_MS = 60_000;
const TRENDING_TTL_MS = 120_000;
const SEARCH_LIMIT = 8;
const TRENDING_LIMIT = 10;

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Platform mandate: discovery surfaces pump.fun tokens ONLY. Bonding-curve
 * mints carry the "pump" suffix; graduated pools live on pump.fun's AMM.
 * The oracle itself still prices any mint (vault positions must never go
 * blind) — but search/trending refuse to SURFACE non-pump tokens.
 */
export const isPumpMint = (mint: string): boolean => mint.toLowerCase().endsWith("pump");
const PUMP_DEX_IDS = new Set(["pumpfun", "pump-fun", "pumpswap"]);

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

// ── search ─────────────────────────────────────────────────────────

interface DexSearchPair {
  chainId?: string;
  dexId?: string;
  priceUsd?: string;
  fdv?: number;
  marketCap?: number;
  liquidity?: { usd?: number };
  baseToken?: { address?: string; symbol?: string; name?: string };
  quoteToken?: { address?: string };
  info?: { imageUrl?: string };
}

/** Trusted-quote pairs can't fake liquidity through a worthless quote token. */
function isTrustedQuote(pair: DexSearchPair): boolean {
  return TRUSTED_QUOTE_MINTS.has(pair.quoteToken?.address ?? "");
}

/** Trust tier first, then claimed liquidity — same doctrine as prices.ts. */
function betterPair(a: DexSearchPair, b: DexSearchPair): boolean {
  const ta = isTrustedQuote(a);
  const tb = isTrustedQuote(b);
  if (ta !== tb) return ta;
  return (a.liquidity?.usd ?? 0) > (b.liquidity?.usd ?? 0);
}

/** Gate absurd caps to undefined — never display upstream garbage. */
function saneMcap(v: number | undefined): number | undefined {
  return v !== undefined && v > 0 && v <= MCAP_SANITY_MAX_USD ? v : undefined;
}

export async function searchTokens(query: string): Promise<TokenSearchResult[]> {
  const q = query.trim();
  if (!q) return [];

  // Raw mint → resolve through the oracle into a single result.
  if (BASE58_RE.test(q)) {
    if (!isPumpMint(q)) return []; // pump.fun tokens only
    const info = await getTokenInfo(q);
    if (info.source === "none") return [];
    return [
      {
        mint: info.mint,
        symbol: info.symbol,
        name: info.name,
        priceUsd: info.priceUsd,
        mcapUsd: info.mcapUsd,
        liquidityUsd: info.liquidityUsd,
        imageUrl: info.imageUrl,
      },
    ];
  }

  return getOrSet(`search:${q.toLowerCase()}`, SEARCH_TTL_MS, async () => {
    try {
      const body = (await fetchJson(
        `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
      )) as { pairs?: DexSearchPair[] | null };
      // Solana pairs only; dedupe by base mint. A trusted-quote pair always
      // beats an untrusted one — poisoned pools fake liquidity through a
      // worthless quote token (the BONK/LTGA $1T-mcap incident).
      const byMint = new Map<string, DexSearchPair>();
      for (const pair of body?.pairs ?? []) {
        const mint = pair?.baseToken?.address;
        if (pair?.chainId !== "solana" || !mint) continue;
        // pump.fun tokens only
        if (!isPumpMint(mint) && !PUMP_DEX_IDS.has(pair.dexId ?? "")) continue;
        const held = byMint.get(mint);
        if (!held || betterPair(pair, held)) {
          byMint.set(mint, pair);
        }
      }
      // Rank result order the same way, so junk tokens can't float to the
      // top of search on fabricated liquidity.
      return [...byMint.entries()]
        .sort(([, a], [, b]) => {
          const ta = isTrustedQuote(a);
          const tb = isTrustedQuote(b);
          if (ta !== tb) return ta ? -1 : 1;
          return (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0);
        })
        .slice(0, SEARCH_LIMIT)
        .map(([mint, pair]): TokenSearchResult => {
          const priceUsd = Number(pair.priceUsd);
          return {
            mint,
            symbol: pair.baseToken?.symbol ?? mint.slice(0, 4),
            name: pair.baseToken?.name ?? "Unknown token",
            priceUsd: Number.isFinite(priceUsd) ? priceUsd : 0,
            mcapUsd: saneMcap(pair.marketCap ?? pair.fdv),
            liquidityUsd: pair.liquidity?.usd,
            imageUrl: pair.info?.imageUrl,
          };
        });
    } catch {
      return [];
    }
  });
}

// ── trending ───────────────────────────────────────────────────────

interface GtTrendingPool {
  attributes?: {
    base_token_price_usd?: string;
    fdv_usd?: string;
    market_cap_usd?: string | null;
    reserve_in_usd?: string;
    price_change_percentage?: { h24?: string };
    volume_usd?: { h24?: string };
  };
  relationships?: { base_token?: { data?: { id?: string } } };
}

interface GtIncludedToken {
  id?: string;
  attributes?: { address?: string; symbol?: string; name?: string; image_url?: string | null };
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export async function getTrending(): Promise<TrendingToken[]> {
  return getOrSet("trending", TRENDING_TTL_MS, async () => {
    try {
      const body = (await fetchJson(
        "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=1&include=base_token",
      )) as { data?: GtTrendingPool[]; included?: GtIncludedToken[] };
      const tokensById = new Map<string, GtIncludedToken>();
      for (const inc of body?.included ?? []) {
        if (inc?.id) tokensById.set(inc.id, inc);
      }
      const out: TrendingToken[] = [];
      const seen = new Set<string>();
      for (const pool of body?.data ?? []) {
        if (out.length >= TRENDING_LIMIT) break;
        const tokenId = pool?.relationships?.base_token?.data?.id;
        if (!tokenId) continue;
        const token = tokensById.get(tokenId)?.attributes;
        // token id is "solana_<mint>" — attributes.address is authoritative
        const mint = token?.address ?? tokenId.replace(/^solana_/, "");
        if (!mint || seen.has(mint)) continue;
        if (!isPumpMint(mint)) continue; // pump.fun tokens only
        seen.add(mint);
        const attrs = pool.attributes ?? {};
        const imageUrl = token?.image_url;
        out.push({
          mint,
          symbol: token?.symbol ?? mint.slice(0, 4),
          name: token?.name ?? token?.symbol ?? "Unknown token",
          priceUsd: num(attrs.base_token_price_usd) ?? 0,
          // circulating cap beats fully-diluted when GT reports both; either
          // way, gate the absurd. GT sends null (not absent) for missing
          // caps and Number(null) === 0, so squash falsy before the ??.
          mcapUsd: saneMcap((num(attrs.market_cap_usd) || undefined) ?? num(attrs.fdv_usd)),
          liquidityUsd: num(attrs.reserve_in_usd),
          change24hPct: num(attrs.price_change_percentage?.h24),
          volume24hUsd: num(attrs.volume_usd?.h24),
          // image may be absent (or GT's "missing.png" placeholder) — omit
          ...(imageUrl && !imageUrl.includes("missing.png") ? { imageUrl } : {}),
        });
      }
      if (out.length > 0) return out;
      return await trendingFallback();
    } catch {
      return trendingFallback();
    }
  });
}

/**
 * No fabricated fallback: when GeckoTerminal is down, trending is honestly
 * empty rather than a hardcoded list dressed up as "trending".
 */
async function trendingFallback(): Promise<TrendingToken[]> {
  return [];
}
