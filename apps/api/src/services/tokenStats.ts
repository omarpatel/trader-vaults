// ── per-token pool stats via GeckoTerminal ─────────────────────────
// Resolve the mint's deepest pool (reusing the ohlcv resolver + its
// 10 min cache), then read that pool's rolling stats: price change,
// buy/sell counts and volume across timeframes. Cached 30s per mint.
// GeckoTerminal serializes numbers as strings — everything is parsed
// at the edge. Failures degrade to an empty stats object with
// pool: null; the route always answers 200.

import type { TokenPoolStats } from "@trader-vaults/shared";
import { getOrSet, recallGood, rememberGood } from "../cache.js";
import { gtFetch } from "./gtBudget.js";
import { topPool } from "./ohlcv.js";

const GT_BASE = "https://api.geckoterminal.com/api/v2";
const FETCH_TIMEOUT_MS = 5_000;
const STATS_TTL_MS = 30_000;

interface GtBucket {
  buys?: number;
  sells?: number;
}

interface GtPoolDetail {
  data?: {
    attributes?: {
      price_change_percentage?: { m5?: string; h1?: string; h6?: string; h24?: string };
      transactions?: { m5?: GtBucket; h1?: GtBucket; h24?: GtBucket };
      volume_usd?: { m5?: string; h1?: string; h24?: string };
    };
  };
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function txnBucket(b: GtBucket | undefined): { buys: number; sells: number } | undefined {
  const buys = num(b?.buys);
  const sells = num(b?.sells);
  return buys !== undefined && sells !== undefined ? { buys, sells } : undefined;
}

function emptyStats(mint: string): TokenPoolStats {
  return {
    mint,
    pool: null,
    priceChangePct: {},
    txns: {},
    volumeUsd: {},
    fetchedAt: Date.now(),
  };
}

export async function getTokenPoolStats(mint: string): Promise<TokenPoolStats> {
  const goodKey = `tokenstats:${mint}`;
  return getOrSet(goodKey, STATS_TTL_MS, async () => {
    // degrade to the last good stats rather than blanking the strip
    const good = recallGood<TokenPoolStats>(goodKey);
    const pool = await topPool(mint);
    if (!pool) return good?.value ?? emptyStats(mint);
    try {
      const res = await gtFetch(
        `${GT_BASE}/networks/solana/pools/${encodeURIComponent(pool)}`,
        { priority: "high", timeoutMs: FETCH_TIMEOUT_MS },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status} for pool ${pool}`);
      const body = (await res.json()) as GtPoolDetail;
      const attrs = body?.data?.attributes ?? {};
      const change = attrs.price_change_percentage ?? {};
      const txns = attrs.transactions ?? {};
      const vol = attrs.volume_usd ?? {};
      const m5 = txnBucket(txns.m5);
      const h1 = txnBucket(txns.h1);
      const h24 = txnBucket(txns.h24);
      const out = {
        mint,
        pool,
        priceChangePct: {
          ...(num(change.m5) !== undefined ? { m5: num(change.m5) } : {}),
          ...(num(change.h1) !== undefined ? { h1: num(change.h1) } : {}),
          ...(num(change.h6) !== undefined ? { h6: num(change.h6) } : {}),
          ...(num(change.h24) !== undefined ? { h24: num(change.h24) } : {}),
        },
        txns: {
          ...(m5 ? { m5 } : {}),
          ...(h1 ? { h1 } : {}),
          ...(h24 ? { h24 } : {}),
        },
        volumeUsd: {
          ...(num(vol.m5) !== undefined ? { m5: num(vol.m5) } : {}),
          ...(num(vol.h1) !== undefined ? { h1: num(vol.h1) } : {}),
          ...(num(vol.h24) !== undefined ? { h24: num(vol.h24) } : {}),
        },
        fetchedAt: Date.now(),
      } satisfies TokenPoolStats;
      return rememberGood(goodKey, out);
    } catch {
      return good?.value ?? emptyStats(mint);
    }
  });
}
