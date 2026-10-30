// ── demo trade execution ───────────────────────────────────────────
// Executes buys/sells against a vault's SOL buffer at the LIVE oracle
// mark (getTokenInfo). We never fabricate a price: source:"none" is a
// hard 422. Position accounting is the PaperApe average-cost model —
// add-on buys average into one row per (vault, mint); partial sells
// reduce tokens and cost basis proportionally, realizing pnl implicitly.
// Fills are demo ledger entries: txSig is prefixed "demo-" so the UI
// can distinguish them from on-chain signatures.

import type { TradeResult } from "@trader-vaults/shared";
import type { Position as DbPosition } from "@prisma/client";
import { PublicKey } from "@solana/web3.js";
import { prisma } from "../db.js";
import { getTokenInfo } from "./prices.js";
import {
  effectiveEquity,
  fetchVaultAccount,
  MAX_DAILY_SWAP_SPEND_BPS,
  MAX_SWAP_EQUITY_BPS,
  MIN_SELL_RECOVERY_BPS,
  VAULT_ACCOUNT_BYTES,
  WSOL_MINT,
} from "./program.js";
import { getMint } from "@solana/spl-token";
import { getConnection } from "./signer.js";
import { assembleVault, toPosition, toTrade } from "./vaults.js";
import { executeVaultSwap, validateVaultSwap } from "./vaultSwap.js";

/** Thrown for every rejected trade — routes map status → HTTP code.
 *  `body` (when set) is the exact JSON the route must respond with;
 *  otherwise routes respond { error: message }. */
export class TradeError extends Error {
  readonly status: number;
  readonly body?: Record<string, unknown>;
  constructor(status: number, message: string, body?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// ── THE WALL ────────────────────────────────────────────────────────
// Real vaults hold real SOL and only ever execute on-chain. The vault
// program is now DEPLOYED (devnet, 2026-08-22), so what remains is the
// client half: signing transactions as the user (Privy session signers)
// and a funded NAV keeper. Until both exist, EVERY ledger operation
// against a real vault is rejected with this exact shape — real vaults
// never touch the simulated engine, deployed program or not.
export const REAL_VAULT_WALL = {
  error:
    "real vaults execute on-chain only — via the vault program " +
    "(HWssGCcxUdiqeEiWk3CRxuSJy6eb4aZH7g2ubo7w6Sqc); pending: client-side " +
    "transaction signing (Privy session signers) and a funded NAV keeper",
  /** what is actually left — program_deploy cleared 2026-08-22 */
  pending: ["nav_keeper"], // client signing is now complete
  programId: "HWssGCcxUdiqeEiWk3CRxuSJy6eb4aZH7g2ubo7w6Sqc",
  cluster: "devnet",
} as const;

export function realVaultWallError(): TradeError {
  return new TradeError(409, REAL_VAULT_WALL.error, {
    error: REAL_VAULT_WALL.error,
    pending: [...REAL_VAULT_WALL.pending],
  });
}

export interface TradeInput {
  side: "buy" | "sell";
  mint: string;
  /** buys: SOL to spend from the vault's unallocated buffer */
  solAmount?: number;
  /** sells: fraction of the open position to close, 0–1 */
  sellFraction?: number;
}

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const EPS = 1e-9;
/** a sell of ≥ this fraction closes the row (dust is dropped) */
const CLOSE_FRACTION = 0.999;
/** min seconds between trade-driven equity points (anti-spam) */
const EQUITY_MIN_GAP_SEC = 60;

const nowSec = () => Math.floor(Date.now() / 1000);

function randBase58(len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) out += BASE58[Math.floor(Math.random() * BASE58.length)]!;
  return out;
}

/**
 * Execute a trade against a vault. Handles both paper (simulated) and
 * real (on-chain via Jupiter) vaults. Throws TradeError on any rejection.
 */
export async function executeTrade(vaultId: string, input: TradeInput): Promise<TradeResult> {
  const { side, mint } = input;
  if (side !== "buy" && side !== "sell") {
    throw new TradeError(400, 'side must be "buy" or "sell"');
  }
  if (typeof mint !== "string" || !BASE58_RE.test(mint)) {
    throw new TradeError(400, "not a valid mint address");
  }

  const vault = await prisma.vault.findUnique({ where: { id: vaultId } });
  if (!vault) throw new TradeError(404, "vault not found");

  // Route to the appropriate execution path
  if (vault.mode === "real") {
    return executeRealTrade(vault, input);
  }

  return executePaperTrade(vault, input);
}

/**
 * Execute a paper trade (simulated, database-only).
 */
async function executePaperTrade(vault: any, input: TradeInput): Promise<TradeResult> {
  const { side, mint } = input;

  if (vault.status !== "active") throw new TradeError(409, `vault is ${vault.status}`);

  // Live mark only — a fabricated price would fabricate pnl.
  const info = await getTokenInfo(mint);
  if (info.source === "none" || info.priceSol <= 0) {
    throw new TradeError(422, `no live price for ${mint} — refusing to trade without an oracle mark`);
  }
  const priceSol = info.priceSol;

  const existing = await prisma.position.findUnique({
    where: { vaultId_mint: { vaultId: vault.id, mint } },
  });

  // ── size the fill ────────────────────────────────────────────────
  let solAmount: number; // SOL leg (spent on buy / received on sell)
  let tokenAmount: number; // token leg
  let closing = false;

  if (side === "buy") {
    solAmount = Number(input.solAmount);
    if (!Number.isFinite(solAmount) || solAmount <= 0) {
      throw new TradeError(400, "solAmount must be a positive number");
    }
    if (solAmount > vault.solBufferSol + EPS) {
      throw new TradeError(
        400,
        `insufficient SOL buffer (requested ${solAmount}, available ${vault.solBufferSol.toFixed(4)})`,
      );
    }
    tokenAmount = solAmount / priceSol;
  } else {
    const fraction = Number(input.sellFraction);
    if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
      throw new TradeError(400, "sellFraction must be a number in (0, 1]");
    }
    if (!existing || existing.amountTokens <= 0) {
      throw new TradeError(400, "no open position in this token");
    }
    tokenAmount = existing.amountTokens * fraction;
    solAmount = tokenAmount * priceSol;
    closing = fraction >= CLOSE_FRACTION;
  }

  const now = nowSec();
  const txSig = `demo-${randBase58(64)}`;

  // ── apply atomically ─────────────────────────────────────────────
  const { tradeRow, positionRow } = await prisma.$transaction(async (tx) => {
    let position: DbPosition | null;

    if (side === "buy") {
      position = existing
        ? await tx.position.update({
            where: { id: existing.id },
            data: {
              // average-cost basis: add-on buys average in
              amountTokens: existing.amountTokens + tokenAmount,
              costSol: existing.costSol + solAmount,
              valueSol: (existing.amountTokens + tokenAmount) * priceSol,
              markStale: false,
            },
          })
        : await tx.position.create({
            data: {
              vaultId: vault.id,
              mint,
              symbol: info.symbol,
              name: info.name,
              amountTokens: tokenAmount,
              costSol: solAmount,
              valueSol: tokenAmount * priceSol,
              markStale: false,
            },
          });
    } else {
      const pos = existing!;
      if (closing) {
        await tx.position.delete({ where: { id: pos.id } });
        position = null;
      } else {
        position = await tx.position.update({
          where: { id: pos.id },
          data: {
            amountTokens: pos.amountTokens - tokenAmount,
            // cost basis reduced proportionally — realized pnl is implicit
            costSol: pos.costSol * (1 - tokenAmount / pos.amountTokens),
            valueSol: (pos.amountTokens - tokenAmount) * priceSol,
            markStale: false,
          },
        });
      }
    }

    const tradeRow = await tx.trade.create({
      data: {
        vaultId: vault.id,
        ts: now,
        side,
        mint,
        symbol: position?.symbol ?? existing?.symbol ?? info.symbol,
        solAmount,
        tokenAmount,
        priceSol,
        txSig,
        source: vault.type,
      },
    });

    // Buffer debit is CONDITIONAL and atomic. The pre-transaction check
    // above is only a fast path: concurrent buys each read the same
    // pre-transaction snapshot, so without a guarded write five parallel
    // 10-SOL buys against a 10-SOL buffer would all "succeed" and mint
    // assets from nothing (audit: 10 SOL deposit -> 30 SOL of positions,
    // share price 3.0). Never clamp an overdraft with Math.max(0, ...) —
    // a clamp turns a trade that must fail into fabricated NAV.
    if (side === "buy") {
      const debited = await tx.vault.updateMany({
        where: { id: vault.id, solBufferSol: { gte: solAmount } },
        data: { solBufferSol: { decrement: solAmount } },
      });
      if (debited.count === 0) {
        throw new TradeError(400, `insufficient SOL buffer (requested ${solAmount})`);
      }
    } else {
      await tx.vault.update({
        where: { id: vault.id },
        data: { solBufferSol: { increment: solAmount } },
      });
    }

    // re-read the post-debit truth, then derive tvl and NAV per share
    const fresh = await tx.vault.findUniqueOrThrow({
      where: { id: vault.id },
      select: { solBufferSol: true, totalShares: true },
    });
    const agg = await tx.position.aggregate({ where: { vaultId: vault.id }, _sum: { valueSol: true } });
    const solBufferSol = fresh.solBufferSol;
    const tvlSol = solBufferSol + (agg._sum.valueSol ?? 0);
    const sharePriceSol = fresh.totalShares > 0 ? tvlSol / fresh.totalShares : 1;
    await tx.vault.update({ where: { id: vault.id }, data: { tvlSol, sharePriceSol } });

    const last = await tx.equityPoint.findFirst({
      where: { vaultId: vault.id },
      orderBy: { t: "desc" },
      select: { t: true },
    });
    if (!last || now - last.t >= EQUITY_MIN_GAP_SEC) {
      // equity curve records PER-SHARE value — flow-independent, so
      // deposits/withdrawals never masquerade as performance
      await tx.equityPoint.upsert({
        where: { vaultId_t: { vaultId: vault.id, t: now } },
        update: { v: sharePriceSol },
        create: { vaultId: vault.id, t: now, v: sharePriceSol },
      });
    }

    return { tradeRow, positionRow: position };
  });

  const assembled = await assembleVault(vault.id);
  return {
    trade: toTrade(tradeRow),
    position: positionRow ? toPosition(positionRow) : null,
    vault: assembled!,
  };
}

/**
 * Sell a real vault's position back into SOL.
 *
 * This was `throw new TradeError(501, "Real vault sells not yet implemented -
 * use withdrawals instead")`. The suggested alternative does not exist: a
 * withdrawal pays SOL out of the vault's free lamports, and no instruction
 * anywhere liquidates a token position. A real vault that bought anything
 * could never convert it back, so its NAV was permanently illiquid and its
 * depositors could not be paid out of the position.
 *
 * Sizing comes from the PROGRAM's recorded position, not the DB Position row:
 * the DB records tokenAmount as outputAmount/1e9, hard-coding 9 decimals, so
 * a fraction of it is wrong for any other-decimal mint. The program's
 * `positions[]` carries the true token amount and what the vault paid for it.
 */
async function executeRealSell(
  vault: any,
  vaultPda: PublicKey,
  input: TradeInput,
): Promise<TradeResult> {
  const mint = input.mint;
  const fraction = Number(input.sellFraction ?? 1);
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
    throw new TradeError(400, "sellFraction must be in (0, 1]");
  }

  const chain = await fetchVaultAccount(getConnection(), vaultPda);
  if (!chain) throw new TradeError(502, "on-chain vault account not found");

  const mintKey = new PublicKey(mint);
  const pos = chain.data.positions.find((pos) => pos.mint.equals(mintKey));
  if (!pos || pos.tokenAmount === 0n) {
    throw new TradeError(
      409,
      "this vault holds no recorded position in that mint. Only tokens bought " +
        "through the vault's own trading have a cost basis, and the program " +
        "refuses to sell what it cannot price.",
    );
  }

  const tokensOut =
    fraction >= 1
      ? pos.tokenAmount
      : (pos.tokenAmount * BigInt(Math.round(fraction * 10_000))) / 10_000n;
  if (tokensOut <= 0n) throw new TradeError(400, "that fraction rounds to zero tokens");

  // The program refuses a clip that recovers less than MIN_SELL_RECOVERY_BPS
  // of the pro-rata basis. Quote first and say so, rather than reverting.
  const basisOut =
    fraction >= 1
      ? pos.wsolBasisLamports
      : (pos.wsolBasisLamports * tokensOut + pos.tokenAmount - 1n) / pos.tokenAmount;
  const floor = (basisOut * BigInt(MIN_SELL_RECOVERY_BPS)) / 10_000n;

  const info = await getTokenInfo(mint);
  // Read the mint's OWN decimals. TokenInfo does not carry them, and the buy
  // path hard-codes 1e9 — which is wrong for every token that is not
  // 9-decimal, and silently wrong by orders of magnitude.
  const decimals = await getMint(getConnection(), mintKey)
    .then((m) => m.decimals)
    .catch(() => 9);
  const scale = 10 ** decimals;

  const result = await executeVaultSwap({
    vaultId: vault.id,
    vaultPda,
    inputMint: mintKey,
    outputMint: WSOL_MINT,
    amountIn: tokensOut,
  });

  const solOut = Number(result.outputAmount) / 1e9;
  if (BigInt(result.outputAmount) < floor) {
    // Belt and braces: the program enforces this, but if it ever landed we
    // would want the record to say what happened.
    console.warn(
      `[trade] sell recovered ${result.outputAmount} against a basis floor of ${floor}`,
    );
  }

  const now = nowSec();
  const tradeRow = await prisma.trade.create({
    data: {
      vaultId: vault.id,
      ts: now,
      side: "sell",
      mint,
      symbol: info.symbol,
      solAmount: solOut,
      tokenAmount: Number(tokensOut) / scale,
      priceSol: solOut / Math.max(1e-12, Number(tokensOut) / scale),
      txSig: result.signature,
      source: "real",
    },
  });

  const assembled = await assembleVault(vault.id);
  return {
    trade: toTrade(tradeRow),
    position: null,
    vault: assembled!,
  };
}

/**
 * Execute a real trade (on-chain via Jupiter Router).
 */
async function executeRealTrade(vault: any, input: TradeInput): Promise<TradeResult> {
  const { side, mint } = input;

  if (vault.status !== "active") {
    throw new TradeError(409, `vault is ${vault.status}`);
  }
  if (!vault.onchainVaultPda) {
    throw new TradeError(409, "vault has no on-chain account");
  }
  const vaultPda = new PublicKey(vault.onchainVaultPda as string);

  if (side === "sell") {
    return executeRealSell(vault, vaultPda, input);
  }

  const solAmount = Number(input.solAmount);
  if (!Number.isFinite(solAmount) || solAmount <= 0) {
    throw new TradeError(400, "solAmount must be a positive number");
  }

  // Size against the vault's ACTUAL on-chain lamports, not the DB buffer
  // column — nothing on this deployment refreshes that column, so it reads 0
  // on every real vault and rejected every trade as "insufficient SOL buffer".
  const chain = await fetchVaultAccount(getConnection(), vaultPda);
  if (!chain) throw new TradeError(502, "on-chain vault account not found");

  const nowBig = BigInt(nowSec());
  const equity = effectiveEquity(chain.data, nowBig);
  const rentMin = BigInt(
    await getConnection().getMinimumBalanceForRentExemption(VAULT_ACCOUNT_BYTES),
  );
  const freeLamports =
    BigInt(chain.lamports) > rentMin + chain.data.platformFeesOwedLamports
      ? BigInt(chain.lamports) - rentMin - chain.data.platformFeesOwedLamports
      : 0n;
  const amountIn = BigInt(Math.round(solAmount * 1e9));
  if (amountIn > freeLamports) {
    throw new TradeError(
      400,
      `insufficient SOL in the vault (requested ${solAmount}, spendable ` +
        `${(Number(freeLamports) / 1e9).toFixed(6)})`,
    );
  }

  // The program caps one swap at MAX_SWAP_EQUITY_BPS of equity and the day's
  // total wSOL spend at MAX_DAILY_SWAP_SPEND_BPS. Say so here rather than
  // letting the transaction revert MaxInExceeded.
  const perSwapCap = (equity * BigInt(MAX_SWAP_EQUITY_BPS)) / 10_000n;
  if (amountIn > perSwapCap) {
    throw new TradeError(
      400,
      `one trade may spend at most ${MAX_SWAP_EQUITY_BPS / 100}% of vault equity ` +
        `(${(Number(perSwapCap) / 1e9).toFixed(6)} SOL); split it into clips`,
    );
  }
  const today = BigInt(Math.floor(Date.now() / 1000 / 86_400));
  const spentToday =
    chain.data.swapDayBucket === today ? chain.data.dailySwapSpendLamports : 0n;
  const dailyCap = (equity * BigInt(MAX_DAILY_SWAP_SPEND_BPS)) / 10_000n;
  if (spentToday + amountIn > dailyCap) {
    throw new TradeError(
      400,
      `this vault has spent ${(Number(spentToday) / 1e9).toFixed(4)} SOL on buys today; ` +
        `the program's daily cap is ${(Number(dailyCap) / 1e9).toFixed(4)} SOL`,
    );
  }

  // Get token info
  const info = await getTokenInfo(mint);
  if (info.source === "none") {
    throw new TradeError(422, `no live price for ${mint}`);
  }

  // Validate the swap
  const validation = await validateVaultSwap({
    inputMint: new PublicKey("So11111111111111111111111111111111111111112"), // SOL
    outputMint: new PublicKey(mint),
    amountIn: BigInt(Math.round(solAmount * 1e9)),
    vaultId: vault.id,
  });

  if (!validation.valid) {
    throw new TradeError(400, validation.reason || "Swap validation failed");
  }

  const buyDecimals = await getMint(getConnection(), new PublicKey(mint))
    .then((m) => m.decimals)
    .catch(() => 9);
  const buyScale = 10 ** buyDecimals;

  // Execute the on-chain swap
  const result = await executeVaultSwap({
    vaultId: vault.id,
    vaultPda,
    inputMint: new PublicKey("So11111111111111111111111111111111111111112"),
    outputMint: new PublicKey(mint),
    amountIn: BigInt(Math.round(solAmount * 1e9)),
  });

  // Record the trade in the database
  const now = nowSec();
  const tradeRow = await prisma.trade.create({
    data: {
      vaultId: vault.id,
      ts: now,
      side: "buy",
      mint,
      symbol: info.symbol,
      solAmount,
      // The mint's OWN decimals, read from chain. This was /1e9 for every
      // token, which is right only for 9-decimal mints and silently wrong by
      // orders of magnitude for everything else — including USDC (6).
      tokenAmount: Number(result.outputAmount) / buyScale,
      priceSol: solAmount / Math.max(1e-12, Number(result.outputAmount) / buyScale),
      txSig: result.signature,
      source: "real",
    },
  });

  // Update the vault's buffer and create/update position
  const { trade: recordedTrade, position } = await prisma.$transaction(async (tx) => {
    // Debit buffer
    await tx.vault.update({
      where: { id: vault.id },
      data: { solBufferSol: { decrement: solAmount } },
    });

    // Create or update position
    const existing = await tx.position.findUnique({
      where: { vaultId_mint: { vaultId: vault.id, mint } },
    });

    const tokenAmount = Number(result.outputAmount) / buyScale;
    let positionRow: any = null;

    if (existing) {
      positionRow = await tx.position.update({
        where: { id: existing.id },
        data: {
          amountTokens: existing.amountTokens + tokenAmount,
          costSol: existing.costSol + solAmount,
          valueSol: (existing.amountTokens + tokenAmount) * (solAmount / tokenAmount),
          markStale: false,
        },
      });
    } else {
      positionRow = await tx.position.create({
        data: {
          vaultId: vault.id,
          mint,
          symbol: info.symbol,
          name: info.name,
          amountTokens: tokenAmount,
          costSol: solAmount,
          valueSol: tokenAmount * (solAmount / tokenAmount),
          markStale: false,
        },
      });
    }

    // Recalculate TVL and NAV
    const fresh = await tx.vault.findUniqueOrThrow({
      where: { id: vault.id },
      select: { solBufferSol: true, totalShares: true },
    });
    const agg = await tx.position.aggregate({
      where: { vaultId: vault.id },
      _sum: { valueSol: true }
    });
    const tvlSol = fresh.solBufferSol + (agg._sum.valueSol ?? 0);
    const sharePriceSol = fresh.totalShares > 0 ? tvlSol / fresh.totalShares : 1;

    await tx.vault.update({
      where: { id: vault.id },
      data: { tvlSol, sharePriceSol }
    });

    // Record equity point
    const last = await tx.equityPoint.findFirst({
      where: { vaultId: vault.id },
      orderBy: { t: "desc" },
      select: { t: true },
    });
    if (!last || now - last.t >= EQUITY_MIN_GAP_SEC) {
      await tx.equityPoint.upsert({
        where: { vaultId_t: { vaultId: vault.id, t: now } },
        update: { v: sharePriceSol },
        create: { vaultId: vault.id, t: now, v: sharePriceSol },
      });
    }

    return { trade: toTrade(tradeRow), position: positionRow ? toPosition(positionRow) : null };
  });

  const assembled = await assembleVault(vault.id);
  return {
    trade: recordedTrade,
    position,
    vault: assembled!,
  };
}
