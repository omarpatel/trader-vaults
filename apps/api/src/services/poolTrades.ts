// ── live trade tape: pump.fun native, GeckoTerminal fallback ───────
// PRIMARY is pump.fun's own /v2/coins/:mint/trades — it needs no pool,
// so bonding-curve tokens have a tape too, it names the venue (pump vs
// raydium_v4_amm), and it costs nothing against the GT rate budget.
// FALLBACK is the GeckoTerminal pool tape, described below.
//
// Reuses the ohlcv service's top-pool resolution, then pulls the pool's
// recent trades. Response shape verified against the live API:
// attributes = { block_number, block_timestamp (ISO), tx_hash,
// tx_from_address, from_token_amount, to_token_amount,
// price_from_in_usd, price_to_in_usd, kind ("buy"|"sell"),
// volume_in_usd, from_token_address, to_token_address }.
// Side detection prefers matching the mint against the transfer legs
// (to_ side = buy, from_ side = sell) — `kind` is relative to the
// pool's base token, the legs are unambiguous. Cached 15s per mint;
// failures degrade to {trades: []}, never a 500.

import type { PoolTrade, TradeSide } from "@trader-vaults/shared";
import { cacheGet, cacheSet, recallGood, rememberGood } from "../cache.js";
import { gtFetch } from "./gtBudget.js";
import { topPool } from "./ohlcv.js";

const GT_BASE = "https://api.geckoterminal.com/api/v2";
const FETCH_TIMEOUT_MS = 8_000;
const TRADES_TTL_MS = 15_000;
const MAX_TRADES = 40;

interface GtTradeRow {
  attributes?: {
    block_timestamp?: string;
    kind?: string;
    tx_hash?: string;
    tx_from_address?: string;
    from_token_amount?: string;
    to_token_amount?: string;
    price_from_in_usd?: string;
    price_to_in_usd?: string;
    volume_in_usd?: string;
    from_token_address?: string;
    to_token_address?: string;
  };
}

function mapTrade(mint: string, row: GtTradeRow): PoolTrade | undefined {
  const a = row?.attributes;
  if (!a) return undefined;

  let side: TradeSide;
  if (a.to_token_address === mint) side = "buy";
  else if (a.from_token_address === mint) side = "sell";
  else if (a.kind === "buy" || a.kind === "sell") side = a.kind;
  else return undefined;

  const ts = Math.floor(Date.parse(a.block_timestamp ?? "") / 1000);
  const priceUsd = Number(side === "buy" ? a.price_to_in_usd : a.price_from_in_usd);
  const amountToken = Number(side === "buy" ? a.to_token_amount : a.from_token_amount);
  const amountUsd = Number(a.volume_in_usd);
  if (!Number.isFinite(ts) || !Number.isFinite(priceUsd) || !Number.isFinite(amountToken)) {
    return undefined;
  }
  return {
    ts,
    side,
    priceUsd,
    amountUsd: Number.isFinite(amountUsd) ? amountUsd : 0,
    amountToken,
    txSig: a.tx_hash ?? "",
    wallet: a.tx_from_address ?? "",
  };
}

export interface PoolTradesResult {
  trades: PoolTrade[];
}

// ── pump.fun tape (primary) ────────────────────────────────────────

interface PumpTradeRow {
  tx?: string;
  timestamp?: string; // ISO
  userAddress?: string;
  type?: string; // "buy" | "sell"
  priceUsd?: string | number;
  amountUsd?: string | number;
  baseAmount?: string | number;
}

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** Recent trades straight from pump.fun. [] on any failure — never throws. */
async function pumpTape(mint: string): Promise<PoolTrade[]> {
  try {
    const res = await fetch(
      `https://swap-api.pump.fun/v2/coins/${encodeURIComponent(mint)}/trades?limit=${MAX_TRADES}`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!res.ok) return [];
    const body = (await res.json()) as { trades?: PumpTradeRow[] };
    const rows = Array.isArray(body?.trades) ? body.trades : [];
    return rows
      .map((r) => {
        const ts = Math.floor(Date.parse(r.timestamp ?? "") / 1000);
        const side: TradeSide = r.type === "sell" ? "sell" : "buy";
        return {
          ts,
          side,
          priceUsd: n(r.priceUsd),
          amountUsd: n(r.amountUsd),
          amountToken: n(r.baseAmount),
          txSig: r.tx ?? "",
          wallet: r.userAddress ?? "",
        };
      })
      .filter((t) => Number.isFinite(t.ts) && t.ts > 0 && t.txSig !== "")
      .sort((a, b) => b.ts - a.ts)
      .slice(0, MAX_TRADES);
  } catch {
    return [];
  }
}

/** Latest ~40 trades in the mint's deepest pool, newest first. */
export async function getPoolTrades(mint: string): Promise<PoolTradesResult> {
  const key = `gt:trades:${mint}`;
  const cached = cacheGet<PoolTradesResult>(key);
  if (cached !== undefined) return cached;

  const good = recallGood<PoolTradesResult>(key);

  // 1) pump.fun native — no pool needed, so bonding tokens get a tape
  const pump = await pumpTape(mint);
  if (pump.length > 0) {
    return cacheSet(key, rememberGood(key, { trades: pump }), TRADES_TTL_MS);
  }

  // 2) GeckoTerminal fallback (pool-based)
  const pool = await topPool(mint);
  if (!pool) return cacheSet(key, good?.value ?? { trades: [] }, TRADES_TTL_MS);

  let trades: PoolTrade[] = [];
  try {
    const res = await gtFetch(
      `${GT_BASE}/networks/solana/pools/${encodeURIComponent(pool)}/trades?trade_volume_in_usd_greater_than=0`,
      { priority: "normal", timeoutMs: FETCH_TIMEOUT_MS },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { data?: GtTradeRow[] };
    trades = (body?.data ?? [])
      .map((row) => mapTrade(mint, row))
      .filter((t): t is PoolTrade => t !== undefined)
      .slice(0, MAX_TRADES);
  } catch {
    trades = [];
  }
  // a failed refresh keeps the tape rather than emptying it
  if (trades.length === 0 && good) return cacheSet(key, good.value, TRADES_TTL_MS);
  return cacheSet(key, rememberGood(key, { trades }), TRADES_TTL_MS);
}
