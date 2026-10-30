import { ComputeBudgetProgram, TransactionInstruction, PublicKey } from "@solana/web3.js";
import { env } from "../env.js";
import { cacheGet, cacheSet } from "../cache.js";

/**
 * Priority fees.
 *
 * Nothing in this codebase set one. On devnet that is invisible: blocks are
 * empty, so a zero-priority transaction lands every time. On mainnet it is
 * the difference between a swap executing and quietly timing out — and a
 * swap that lands late lands at a worse price than the quote it was built
 * from, which is a loss taken by the vault's depositors.
 *
 * Helius's getPriorityFeeEstimate reads the fee market for the specific
 * accounts a transaction touches, which is far better than a global guess:
 * a busy AMM pool can need orders of magnitude more than the chain median.
 */

/** Microlamports per compute unit when Helius is unavailable. */
const FALLBACK_MICROLAMPORTS = 50_000;

/**
 * Ceiling on the fee, in microlamports per CU.
 *
 * Helius returns what it takes to land, not what is sensible to pay. During
 * a spike that estimate can be millions; multiplied by a 400k-CU swap it
 * becomes a fee larger than the trade. Refusing to pay past this point means
 * a swap can fail to land — which is the correct outcome, because the
 * alternative is spending depositor SOL on gas without their consent.
 */
const MAX_MICROLAMPORTS = 2_000_000;

/** Estimates move on the order of seconds, and every swap would otherwise re-ask. */
const TTL_MS = 5_000;

interface HeliusFeeResponse {
  result?: { priorityFeeEstimate?: number };
  error?: { message?: string };
}

function heliusRpcUrl(): string | null {
  const key = env.heliusApiKey;
  if (!key) return null;
  const cluster = env.solanaCluster;
  const host =
    cluster === "mainnet-beta" || cluster === "mainnet"
      ? "mainnet.helius-rpc.com"
      : "devnet.helius-rpc.com";
  return `https://${host}/?api-key=${key}`;
}

/**
 * Microlamports per compute unit for a transaction touching `accountKeys`.
 *
 * Never throws: a failed estimate falls back rather than blocking a trade,
 * because "we could not price the fee" is not a reason to refuse to trade.
 */
export async function estimatePriorityFee(accountKeys: string[]): Promise<number> {
  const url = heliusRpcUrl();
  if (!url) return FALLBACK_MICROLAMPORTS;

  const key = `priofee:${accountKeys.slice(0, 4).join(",")}`;
  const cached = cacheGet<number>(key);
  if (cached !== undefined) return cached;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(5_000),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getPriorityFeeEstimate",
        params: [{ accountKeys, options: { recommended: true } }],
      }),
    });
    if (!res.ok) return FALLBACK_MICROLAMPORTS;

    const body = (await res.json()) as HeliusFeeResponse;
    const raw = body?.result?.priorityFeeEstimate;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
      return cacheSet(key, FALLBACK_MICROLAMPORTS, TTL_MS);
    }
    // recommended can come back as 0 on a quiet account set; a floor keeps
    // us from broadcasting something that will not be picked up
    const bounded = Math.min(MAX_MICROLAMPORTS, Math.max(1_000, Math.ceil(raw)));
    return cacheSet(key, bounded, TTL_MS);
  } catch {
    return FALLBACK_MICROLAMPORTS;
  }
}

/**
 * Compute-budget instructions to prepend to a transaction.
 *
 * Order matters only in that both must precede the instructions they govern;
 * Solana reads them from anywhere in the transaction, but keeping them first
 * matches every explorer's expectations and makes the fee obvious to anyone
 * auditing the transaction later.
 */
export async function computeBudgetIxs(params: {
  accountKeys: (string | PublicKey)[];
  /** Omit to leave the default 200k limit, which is not enough for a Jupiter route. */
  computeUnitLimit?: number;
}): Promise<TransactionInstruction[]> {
  const keys = params.accountKeys.map((k) => (typeof k === "string" ? k : k.toBase58()));
  const microLamports = await estimatePriorityFee(keys);

  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
  ];
  if (params.computeUnitLimit && params.computeUnitLimit > 0) {
    ixs.push(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: Math.min(1_400_000, params.computeUnitLimit),
      }),
    );
  }
  return ixs;
}
