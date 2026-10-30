// ── real wallet scanning over public mainnet RPC ───────────────────
// Reads a wallet's recent transactions (getSignaturesForAddress →
// getTransaction, sequential with a polite gap) and classifies swaps by
// BALANCE DIFFING — the DEX-agnostic technique: a swap is SOL down +
// one token up (BUY) or one token down + SOL up (SELL), computed from
// pre/post lamport balances (fee excluded, wrapped SOL folded in) and
// pre/post token balances owned by the wallet. We NEVER fabricate: a
// wallet with zero detectable swaps returns zeroed stats with
// scanStatus "ok"; a scan interrupted by rate limits keeps what it has
// and reports "partial". Results cache 10 minutes per wallet.
//
// The per-transaction classifier (classifySwap) and the RPC helpers are
// exported for reuse — the paper mirror engine (mirrorEngine.ts) runs
// the SAME classification over a leader wallet's new transactions
// instead of duplicating the balance-diff logic.

import type { TradeSide, TraderStats, WalletSwap } from "@trader-vaults/shared";
import { cacheDelete, getOrSet } from "../cache.js";
import { env } from "../env.js";
import { getTokenInfos, SOL_MINT } from "./prices.js";

const RPC_TIMEOUT_MS = 8_000;
const SCAN_TTL_MS = 600_000; // 10 min
const SIGNATURE_LIMIT = 25;
// public mainnet RPC allows ~40 req/10s per method — 250ms keeps us at the line
const TX_GAP_MS = 250;
const RETRY_BACKOFF_MS = 1_500; // one backoff-retry per call before giving up
const SCAN_DEADLINE_MS = 15_000; // inline scans stay bounded; overrun → partial
const DUST_LAMPORTS = 100_000n; // 0.0001 SOL — below this is rent/fee jitter, not a swap leg

export interface WalletScanResult {
  stats: TraderStats;
  /** newest swap ts, else newest signature blockTime, else 0 */
  lastActiveAt: number;
  scanStatus: "ok" | "partial";
  /** newest first */
  swaps: WalletSwap[];
  scannedAt: number;
  /** false when the signature list itself could not be fetched (know-nothing partial) */
  sawChain: boolean;
}

// ── raw JSON-RPC ───────────────────────────────────────────────────

let rpcId = 0;

export class RpcHttpError extends Error {
  readonly status: number;
  /** seconds the server asked us to wait (Retry-After), if sent */
  readonly retryAfterSec?: number;
  constructor(status: number, method: string, retryAfterSec?: number) {
    super(`RPC HTTP ${status} for ${method}`);
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

/**
 * Round-robin cursor over the RPC pool. Kept module-level so consecutive
 * calls spread across endpoints instead of hammering the first one — the
 * public mainnet endpoint 429s after roughly ten calls in a burst.
 */
let rpcCursor = 0;

async function rpcOnce<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!res.ok) {
    const retryAfter = Number(res.headers.get("retry-after"));
    throw new RpcHttpError(
      res.status,
      method,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }
  const body = (await res.json()) as { result?: T; error?: { code?: number; message?: string } };
  if (body.error) throw new Error(`RPC error ${body.error.code}: ${body.error.message}`);
  return body.result as T;
}

/**
 * Pooled RPC: try each endpoint once, rotating the starting point so load
 * spreads. Only transport/rate-limit failures fall through — a valid RPC
 * error (bad params, unknown method) is the same on every endpoint and is
 * rethrown immediately. The last failure propagates so callers keep their
 * existing RpcHttpError backoff behaviour.
 */
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const pool = env.mainnetRpcPool;
  const start = rpcCursor++ % pool.length;
  let lastErr: unknown;
  for (let i = 0; i < pool.length; i++) {
    const url = pool[(start + i) % pool.length]!;
    try {
      return await rpcOnce<T>(url, method, params);
    } catch (err) {
      lastErr = err;
      // a genuine JSON-RPC error is deterministic — don't waste the pool
      if (!(err instanceof RpcHttpError) && !(err instanceof TypeError) &&
          !(err instanceof DOMException)) {
        throw err;
      }
    }
  }
  throw lastErr;
}

export interface SigInfo {
  signature: string;
  blockTime?: number | null;
  err?: unknown;
}

interface TokenBalance {
  accountIndex: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: { amount?: string; decimals?: number };
}

export interface ParsedTx {
  blockTime?: number | null;
  meta?: {
    err?: unknown;
    fee?: number;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  } | null;
  transaction?: {
    message?: { accountKeys?: Array<{ pubkey?: string } | string> };
  };
}

// ── classification by balance diffing ──────────────────────────────

export interface ClassifiedSwap extends WalletSwap {
  /** token leg in raw units + decimals — used for FIFO pairing and sell fractions */
  tokenRaw: bigint;
  decimals: number;
  /**
   * The wallet's raw balance of the moved mint BEFORE the swap (summed
   * over its token accounts). For sells this makes the sold fraction
   * honestly derivable: tokenRaw / preRaw.
   */
  preRaw: bigint;
}

function bigAbs(v: bigint): bigint {
  return v < 0n ? -v : v;
}

/**
 * Classify one parsed transaction as a SOL↔token swap by balance
 * diffing (SOL down + one token up = BUY; one token down + SOL up =
 * SELL). Returns undefined for anything that isn't a clean single-mint
 * SOL swap by `wallet` — failed txs, transfers, airdrops, dust,
 * token-to-token routes.
 */
export function classifySwap(wallet: string, sig: SigInfo, tx: ParsedTx): ClassifiedSwap | undefined {
  const meta = tx.meta;
  if (!meta || meta.err) return undefined; // failed txs never count
  const keys = (tx.transaction?.message?.accountKeys ?? []).map((k) =>
    typeof k === "string" ? k : (k?.pubkey ?? ""),
  );
  const idx = keys.indexOf(wallet);
  if (idx < 0) return undefined;

  // (a) SOL delta at the wallet's index; the fee is not part of the swap,
  // so add it back when the wallet is the fee payer (always index 0).
  let solDelta =
    BigInt(meta.postBalances?.[idx] ?? 0) - BigInt(meta.preBalances?.[idx] ?? 0);
  if (idx === 0) solDelta += BigInt(meta.fee ?? 0);

  // (b) per-mint token deltas where the wallet owns the token account.
  // preRawByMint keeps the wallet's pre-swap balances so a SELL's sold
  // fraction (tokenRaw / preRaw) is derivable from real chain data.
  const deltas = new Map<string, { delta: bigint; decimals: number }>();
  const preRawByMint = new Map<string, bigint>();
  const fold = (rows: TokenBalance[] | undefined, sign: 1n | -1n): void => {
    for (const b of rows ?? []) {
      if (b.owner !== wallet || !b.mint) continue;
      const amount = b.uiTokenAmount?.amount;
      if (amount === undefined) continue;
      const entry = deltas.get(b.mint) ?? {
        delta: 0n,
        decimals: b.uiTokenAmount?.decimals ?? 0,
      };
      entry.delta += sign * BigInt(amount);
      deltas.set(b.mint, entry);
      if (sign === -1n) {
        preRawByMint.set(b.mint, (preRawByMint.get(b.mint) ?? 0n) + BigInt(amount));
      }
    }
  };
  fold(meta.postTokenBalances, 1n);
  fold(meta.preTokenBalances, -1n);

  // wrapped SOL is the SOL leg of the swap, not a token leg — fold it in
  const wsol = deltas.get(SOL_MINT);
  if (wsol) {
    solDelta += wsol.delta;
    deltas.delete(SOL_MINT);
  }

  const moved = [...deltas.entries()].filter(([, e]) => e.delta !== 0n);
  // no token delta → not a swap; >1 mint moved → token-to-token, skip
  if (moved.length !== 1) return undefined;
  const [mint, tokenLeg] = moved[0]!;

  let side: TradeSide;
  if (tokenLeg.delta > 0n && solDelta < -DUST_LAMPORTS) side = "buy";
  else if (tokenLeg.delta < 0n && solDelta > DUST_LAMPORTS) side = "sell";
  else return undefined; // transfers/airdrops/dust — not a SOL swap

  return {
    ts: tx.blockTime ?? sig.blockTime ?? 0,
    side,
    mint,
    solAmount: Number(bigAbs(solDelta)) / 1e9,
    txSig: sig.signature,
    tokenRaw: bigAbs(tokenLeg.delta),
    decimals: tokenLeg.decimals,
    preRaw: preRawByMint.get(mint) ?? 0n,
  };
}

// ── window stats (FIFO pairing) ────────────────────────────────────
// Buys queue as lots per mint; each sell consumes lots FIFO and
// realizes (proceeds − proportional cost) on the covered fraction.
// Sells of tokens bought before the window stay unpaired (no cost
// basis → no fabricated pnl).

function windowStats(swaps: ClassifiedSwap[]): Pick<TraderStats, "pnlSol" | "winRatePct" | "profitFactor"> {
  const chrono = [...swaps].sort((a, b) => a.ts - b.ts);
  const lots = new Map<string, Array<{ tokens: number; costSol: number }>>();
  let pnl = 0;
  let exits = 0;
  let wins = 0;
  let grossProfit = 0;
  let grossLoss = 0;

  for (const s of chrono) {
    const tokens = Number(s.tokenRaw) / 10 ** s.decimals;
    if (!(tokens > 0)) continue;
    if (s.side === "buy") {
      const q = lots.get(s.mint) ?? [];
      q.push({ tokens, costSol: s.solAmount });
      lots.set(s.mint, q);
      continue;
    }
    const q = lots.get(s.mint) ?? [];
    let remaining = tokens;
    let covered = 0;
    let cost = 0;
    while (remaining > 0 && q.length > 0) {
      const lot = q[0]!;
      const take = Math.min(lot.tokens, remaining);
      const takeCost = lot.costSol * (take / lot.tokens);
      cost += takeCost;
      lot.costSol -= takeCost;
      lot.tokens -= take;
      covered += take;
      remaining -= take;
      if (lot.tokens <= tokens * 1e-9) q.shift();
    }
    if (covered <= 0) continue; // nothing to pair against in-window
    const proceeds = s.solAmount * (covered / tokens);
    const realized = proceeds - cost;
    pnl += realized;
    exits += 1;
    if (realized > 0) {
      wins += 1;
      grossProfit += realized;
    } else {
      grossLoss += -realized;
    }
  }

  return {
    pnlSol: Math.round(pnl * 1e4) / 1e4,
    winRatePct: exits > 0 ? Math.round((wins / exits) * 1000) / 10 : 0,
    profitFactor: grossLoss > 0 ? Math.round((grossProfit / grossLoss) * 100) / 100 : undefined,
  };
}

// ── symbol resolution (best effort via the oracle's metadata) ──────

async function resolveSymbols(swaps: ClassifiedSwap[]): Promise<void> {
  const mints = [...new Set(swaps.map((s) => s.mint))];
  if (mints.length === 0) return;
  try {
    const infos = await getTokenInfos(mints);
    const byMint = new Map(infos.map((i) => [i.mint, i]));
    for (const s of swaps) {
      const info = byMint.get(s.mint);
      // the oracle falls back to mint.slice(0,4) when it has no metadata —
      // that placeholder means "unknown", so leave symbol undefined
      if (info && info.symbol !== s.mint.slice(0, 4)) s.symbol = info.symbol;
    }
  } catch {
    // symbols are cosmetic — the scan stands without them
  }
}

// ── the scan ───────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Backoff-retry per call — public RPC 429s are usually transient. A 429
 * with a Retry-After we can afford inside the deadline waits that long;
 * anything we can't afford propagates so the scan ends partial.
 */
export async function rpcWithRetry<T>(method: string, params: unknown[], deadline: number): Promise<T> {
  let backoff = RETRY_BACKOFF_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      return await rpc<T>(method, params);
    } catch (err) {
      if (attempt >= 2) throw err;
      if (err instanceof RpcHttpError && err.status === 429 && err.retryAfterSec) {
        backoff = Math.max(backoff, err.retryAfterSec * 1000);
      }
      if (Date.now() + backoff >= deadline) throw err;
      await sleep(backoff);
      backoff *= 2;
    }
  }
}

async function runScan(address: string): Promise<WalletScanResult> {
  const startedAt = Date.now();
  const deadline = startedAt + SCAN_DEADLINE_MS;
  let partial = false;
  let sawChain = true;

  let sigs: SigInfo[] = [];
  try {
    sigs = (await rpcWithRetry<SigInfo[]>("getSignaturesForAddress", [
      address,
      { limit: SIGNATURE_LIMIT },
    ], deadline)) ?? [];
  } catch (err) {
    // couldn't even list signatures — we know nothing about this wallet
    console.warn(`[walletScan] ${address}: signature list failed:`, err);
    partial = true;
    sawChain = false;
  }

  const classified: ClassifiedSwap[] = [];
  for (const sig of sigs) {
    // newest first (RPC order), sequential, gap between calls
    if (Date.now() >= deadline) {
      partial = true;
      break;
    }
    try {
      const tx = await rpcWithRetry<ParsedTx | null>("getTransaction", [
        sig.signature,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
      ], deadline);
      if (tx) {
        const swap = classifySwap(address, sig, tx);
        if (swap) classified.push(swap);
      }
    } catch (err) {
      // 429 / timeout / node hiccup — keep what we have, report partial
      console.warn(`[walletScan] ${address}: stopped at ${sig.signature.slice(0, 8)}…:`, err);
      partial = true;
      break;
    }
    await sleep(TX_GAP_MS);
  }

  await resolveSymbols(classified);

  const stats = windowStats(classified);
  const lastActiveAt =
    classified[0]?.ts ??
    sigs.find((s) => typeof s.blockTime === "number")?.blockTime ??
    0;

  return {
    stats: {
      winRatePct: stats.winRatePct,
      pnlSol: stats.pnlSol,
      trades: classified.length,
      profitFactor: stats.profitFactor,
    },
    lastActiveAt: lastActiveAt || 0,
    scanStatus: partial ? "partial" : "ok",
    swaps: classified.map(({ ts, side, mint, symbol, solAmount, txSig }) => ({
      ts,
      side,
      mint,
      symbol,
      solAmount,
      txSig,
    })),
    scannedAt: Math.floor(Date.now() / 1000),
    sawChain,
  };
}

/** Scan a wallet's recent swap activity. Cached 10 min unless `force`. */
export async function scanWallet(address: string, force = false): Promise<WalletScanResult> {
  const key = `walletscan:${address}`;
  if (force) cacheDelete(key);
  return getOrSet(key, SCAN_TTL_MS, () => runScan(address));
}
