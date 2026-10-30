// ── real OHLCV: pump.fun native, GeckoTerminal fallback ────────────
// PRIMARY is pump.fun's own swap-api: this platform is pump.fun-only, so
// the launchpad itself is the most authoritative source — and crucially
// it serves BONDING-CURVE tokens, which have no AMM pool at all and are
// therefore invisible to GeckoTerminal (verified: GT returns zero pools
// for a fresh mint while pump.fun already has candles). It is also
// keyless and outside the GT rate budget, so a GT cool-off can no longer
// blank a chart.
//
// FALLBACK is GeckoTerminal (pool-based, graduated tokens only), metered
// by gtBudget. Beneath both sits the last-good layer: a failed or empty
// refresh serves the remembered chart flagged `stale` rather than wiping
// it. Charts degrade to stale, never to blank.

import type { Candle } from "@trader-vaults/shared";
import { cacheGet, cacheSet, recallGood, rememberGood } from "../cache.js";
import { gtFetch, type GtPriority } from "./gtBudget.js";

const GT_BASE = "https://api.geckoterminal.com/api/v2";
const FETCH_TIMEOUT_MS = 8_000;
const POOL_TTL_MS = 600_000; // 10 min
const POOL_MISS_TTL_MS = 30_000; // failed lookups retry sooner
/**
 * Cache a candle set for a fraction of its own bar width, so the forming bar
 * is never more than a few seconds behind. A flat 30s made a 1m chart look
 * frozen; a 1h chart doesn't need that pace and shouldn't pay for it.
 */
const OHLCV_TTL_BY_TF: Record<Timeframe, number> = {
  // The upstream is itself 2-7s behind wall clock on an active token, so
  // polling faster than ~1s buys nothing and just burns rate limit. One
  // cache entry serves every viewer of the same token.
  "1s": 1_000,
  "15s": 4_000,
  "30s": 8_000,
  "1m": 5_000,
  "5m": 10_000,
  "15m": 20_000,
  "1h": 45_000,
};
const OHLCV_TTL_FALLBACK_MS = 30_000;
const ttlFor = (tf: Timeframe): number => OHLCV_TTL_BY_TF[tf] ?? OHLCV_TTL_FALLBACK_MS;

// pump.fun's own validator reports its accepted set as:
//   1s, 15s, 30s, 1m, 5m, 15m, 30m, 1h, 4h, 6h, 12h, 24h
// (note 5s and 10s are NOT accepted). We expose the sub-minute end because
// that is where memecoin entries are actually decided.
export const TIMEFRAMES = ["1s", "15s", "30s", "1m", "5m", "15m", "1h"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

// GeckoTerminal's finest granularity is one minute. Sub-minute timeframes
// map to it so the fallback still draws SOMETHING, but the result is
// labelled by source so the UI can say the chart is coarser than asked.
const TF_MAP: Record<Timeframe, { timeframe: "minute" | "hour"; aggregate: number }> = {
  "1s": { timeframe: "minute", aggregate: 1 },
  "15s": { timeframe: "minute", aggregate: 1 },
  "30s": { timeframe: "minute", aggregate: 1 },
  "1m": { timeframe: "minute", aggregate: 1 },
  "5m": { timeframe: "minute", aggregate: 5 },
  "15m": { timeframe: "minute", aggregate: 15 },
  "1h": { timeframe: "hour", aggregate: 1 },
};

export function isTimeframe(v: unknown): v is Timeframe {
  return typeof v === "string" && (TIMEFRAMES as readonly string[]).includes(v);
}

export interface OhlcvResult {
  candles: Candle[];
  pool: string | null;
  /** true when serving remembered data because the fresh fetch failed */
  stale?: boolean;
  /** unix ms the served candles were actually fetched */
  fetchedAt?: number;
  /** which upstream produced these candles */
  source?: "pumpfun" | "geckoterminal";
}

// All GT calls go through the global budgeter (beneath our caches).
async function gtJson(url: string, priority: GtPriority): Promise<unknown> {
  const res = await gtFetch(url, { priority, timeoutMs: FETCH_TIMEOUT_MS });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

// ── pool resolution ────────────────────────────────────────────────

interface GtPoolRow {
  attributes?: { address?: string; reserve_in_usd?: string };
}

/** Deepest pool address for a mint, or null. Cached (misses retry sooner). */
export async function topPool(mint: string): Promise<string | null> {
  const key = `gt:pool:${mint}`;
  const cached = cacheGet<string | null>(key);
  if (cached !== undefined) return cached;

  let best: string | null = null;
  try {
    const body = (await gtJson(
      `${GT_BASE}/networks/solana/tokens/${encodeURIComponent(mint)}/pools?page=1`,
      "normal",
    )) as { data?: GtPoolRow[] };
    let bestReserve = -1;
    for (const row of body?.data ?? []) {
      const address = row?.attributes?.address;
      const reserve = Number(row?.attributes?.reserve_in_usd ?? 0);
      if (address && reserve > bestReserve) {
        best = address;
        bestReserve = reserve;
      }
    }
  } catch {
    best = null;
  }
  return cacheSet(key, best, best ? POOL_TTL_MS : POOL_MISS_TTL_MS);
}

// ── pump.fun candles (primary) ─────────────────────────────────────

const PUMP_CANDLES_BASE = "https://swap-api.pump.fun/v1/coins";

/** pump.fun interval slugs map 1:1 onto ours. */
const PUMP_TF: Record<Timeframe, string> = {
  "1s": "1s",
  "15s": "15s",
  "30s": "30s",
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "1h": "1h",
};

/**
 * How many bars to ask for, per timeframe.
 *
 * pump.fun caps limit at 1000. Sub-minute bars are emitted only for seconds
 * that actually traded, so a 1s request covering a useful stretch of wall
 * time needs far more rows than a 1h one — 600 one-second bars is roughly
 * ten minutes on a busy token and much longer on a quiet one.
 */
const PUMP_LIMIT: Record<Timeframe, number> = {
  "1s": 600,
  "15s": 400,
  "30s": 300,
  "1m": 200,
  "5m": 200,
  "15m": 200,
  "1h": 200,
};

interface PumpCandleRow {
  timestamp?: number; // epoch MILLISECONDS
  open?: string | number;
  high?: string | number;
  low?: string | number;
  close?: string | number;
  volume?: string | number;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

/**
 * Candles straight from pump.fun (USD-denominated, same as GT's), for
 * bonding-curve and graduated tokens alike. Returns [] on any failure so
 * the caller can fall through — never throws.
 */
export type Denom = "USD" | "SOL";

async function pumpCandles(
  mint: string,
  tf: Timeframe,
  limit: number,
  currency: Denom,
): Promise<Candle[]> {
  try {
    const res = await fetch(
      `${PUMP_CANDLES_BASE}/${encodeURIComponent(mint)}/candles?interval=${PUMP_TF[tf]}&limit=${limit}&currency=${currency}`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!res.ok) return [];
    const rows = (await res.json()) as PumpCandleRow[];
    if (!Array.isArray(rows)) return [];
    return rows
      .map((r) => ({
        t: Math.floor(num(r.timestamp) / 1000), // ms → unix seconds
        o: num(r.open),
        h: num(r.high),
        l: num(r.low),
        c: num(r.close),
        v: Number.isFinite(num(r.volume)) ? num(r.volume) : undefined,
      }))
      .filter(
        (c) =>
          Number.isFinite(c.t) && c.t > 0 &&
          Number.isFinite(c.o) && Number.isFinite(c.h) &&
          Number.isFinite(c.l) && Number.isFinite(c.c),
      )
      .sort((a, b) => a.t - b.t);
  } catch {
    return [];
  }
}

// ── candles ────────────────────────────────────────────────────────

/** Bar width in ms, used to scale failure and fallback TTLs. */
const TF_MS: Record<Timeframe, number> = {
  "1s": 1_000,
  "15s": 15_000,
  "30s": 30_000,
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
};

/**
 * GeckoTerminal has no granularity below a minute, so a GT answer to a 1s
 * request is a 1-minute chart. Caching that at the 1s TTL would re-ask GT
 * every single second for data that cannot change more than once a minute —
 * 120 calls/min against gtBudget's 25/min capacity, at "high" priority,
 * starving pool resolution and the entire Pulse board for every other user
 * on the server. The cache TTL must follow whoever actually answered.
 */
const GT_MIN_TTL_MS = 30_000;

/** Retry a hard failure after two bar widths, never slower than 10s. */
function failTtl(tf: Timeframe): number {
  return Math.min(10_000, Math.max(2_000, TF_MS[tf] * 2));
}

/**
 * How many bars to ask for on a REFRESH, once we already hold a window.
 *
 * A full 1s window is 600 rows / ~131KB. Re-pulling that every 1.2s is
 * ~385MB per hour per viewer, each way, for maybe a dozen new bars. Because
 * sub-minute bars are sparse, a 40-row tail still covers roughly fifteen
 * minutes of wall clock — enough that the server can miss polls for minutes
 * and still stitch the window back together without a hole.
 */
const PUMP_TAIL: Record<Timeframe, number> = {
  "1s": 40,
  "15s": 40,
  "30s": 40,
  "1m": 40,
  "5m": 40,
  "15m": 40,
  "1h": 40,
};

/** Bars retained per key, trimmed oldest-first. */
const retained = new Map<string, Candle[]>();

/**
 * Merge a fetched tail into the retained window.
 *
 * Upstream re-sends the currently-forming bar on every poll with updated
 * OHLC, so a merge must overwrite by timestamp rather than append —
 * otherwise the same second appears twice and the strictly-ascending
 * contract the chart depends on is broken.
 */
function mergeWindow(key: string, tail: Candle[], cap: number): Candle[] {
  const prev = retained.get(key) ?? [];
  if (tail.length === 0) return prev;

  const oldestTail = tail[0]!.t;
  const newestPrev = prev.length > 0 ? prev[prev.length - 1]!.t : -Infinity;
  // The tail starts after everything we hold — there is a hole between them.
  // Drop the stale window rather than splice a gap the chart would render
  // as contiguous.
  if (prev.length > 0 && oldestTail > newestPrev + 1) {
    const trimmed = tail.slice(-cap);
    retained.set(key, trimmed);
    return trimmed;
  }

  const byTs = new Map<number, Candle>();
  for (const c of prev) byTs.set(c.t, c);
  for (const c of tail) byTs.set(c.t, c); // fetched wins — it is newer
  const merged = [...byTs.values()].sort((a, b) => a.t - b.t).slice(-cap);
  retained.set(key, merged);
  return merged;
}

/**
 * In-flight loads, so concurrent viewers of the same token share one
 * upstream call. Without this, a 1s TTL against a ~300-680ms upstream RTT
 * means a large share of requests land inside an open fetch window and each
 * starts its own — and pump.fun's edge punishes concurrency hardest of all.
 */
const inFlight = new Map<string, Promise<OhlcvResult>>();

export function getOhlcv(mint: string, tf: Timeframe, currency: Denom = "USD"): Promise<OhlcvResult> {
  // currency is part of the key — a SOL chart and a USD chart of the same
  // token are different series and must never share a cache entry
  const key = `ohlcv:${mint}:${tf}:${currency}`;
  const cached = cacheGet<OhlcvResult>(key);
  if (cached !== undefined) return Promise.resolve(cached);

  const hit = inFlight.get(key);
  if (hit) return hit;

  const p = loadOhlcv(mint, tf, key, currency).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function loadOhlcv(
  mint: string,
  tf: Timeframe,
  key: string,
  currency: Denom,
): Promise<OhlcvResult> {

  const good = recallGood<OhlcvResult>(key);

  // 1) pump.fun native — needs no pool, so bonding-curve tokens chart too
  // Cold key pulls the full window; a warm one pulls only a tail and merges.
  const warm = (retained.get(key)?.length ?? 0) > 0;
  const want = warm ? PUMP_TAIL[tf] : PUMP_LIMIT[tf];
  const pump = await pumpCandles(mint, tf, want, currency);
  if (pump.length > 0) {
    const merged = mergeWindow(key, pump, PUMP_LIMIT[tf]);
    const fresh: OhlcvResult = {
      candles: merged,
      pool: good?.value.pool ?? null,
      fetchedAt: Date.now(),
      source: "pumpfun",
    };
    rememberGood(key, fresh);
    return cacheSet(key, fresh, ttlFor(tf));
  }

  // 2) GeckoTerminal fallback — pool-based, graduated tokens only.
  //
  // Sub-minute requests only reach GT on a genuinely cold key. Serving a
  // 1-minute chart once, labelled, while a new token has no pump.fun
  // candles yet is a reasonable courtesy; doing it once per second is a
  // denial of service against our own GT budget. With a remembered chart
  // in hand we serve that instead (step 3) and let the next poll retry
  // pump.fun.
  // GeckoTerminal quotes in USD only. Falling back for a SOL request would
  // return numbers ~500x off with no way for the client to tell.
  if (currency === "SOL") {
    if (good) {
      return cacheSet(key, { ...good.value, stale: true, fetchedAt: good.at }, failTtl(tf));
    }
    return cacheSet(key, { candles: [], pool: null }, failTtl(tf));
  }

  const subMinute = TF_MS[tf] < 60_000;
  if (subMinute && good) {
    return cacheSet(
      key,
      { ...good.value, stale: true, fetchedAt: good.at },
      failTtl(tf),
    );
  }

  // Pool pinning: once a pool has produced candles, prefer it over a
  // fresh resolution so re-resolution churn can't blank a live chart.
  const pool = (await topPool(mint)) ?? good?.value.pool ?? null;
  if (pool) {
    const { timeframe, aggregate } = TF_MAP[tf];
    try {
      const body = (await gtJson(
        `${GT_BASE}/networks/solana/pools/${encodeURIComponent(pool)}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=200`,
        "high",
      )) as { data?: { attributes?: { ohlcv_list?: number[][] } } };
      // rows are [ts, o, h, l, c, v] newest-first — flip to oldest-first
      const candles = (body?.data?.attributes?.ohlcv_list ?? [])
        .filter((r): r is number[] => Array.isArray(r) && r.length >= 5)
        .map((r) => ({ t: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: r[5] }))
        // same validation the pump.fun branch applies — a NaN/null row
        // would reach the chart and break it
        .filter(
          (c) =>
            Number.isFinite(c.t) && c.t > 0 &&
            Number.isFinite(c.o) && Number.isFinite(c.h) &&
            Number.isFinite(c.l) && Number.isFinite(c.c),
        )
        .sort((a, b) => a.t - b.t);
      if (candles.length > 0) {
        const fresh: OhlcvResult = {
          candles,
          pool,
          fetchedAt: Date.now(),
          source: "geckoterminal",
        };
        rememberGood(key, fresh);
        // GT answered — cache on GT's clock, not the requested timeframe's
        return cacheSet(key, fresh, Math.max(GT_MIN_TTL_MS, ttlFor(tf)));
      }
    } catch {
      // fall through to stale
    }
  }

  // 3) both upstreams failed or were empty — serve the last good chart,
  // marked stale, and cache only briefly so the next poll retries
  if (good) {
    return cacheSet(key, { ...good.value, stale: true, fetchedAt: good.at }, failTtl(tf));
  }
  return cacheSet(key, { candles: [], pool }, failTtl(tf));
}
