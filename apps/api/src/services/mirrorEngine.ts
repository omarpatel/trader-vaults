// ── paper mirror-vault engine ──────────────────────────────────────
// Copies a REAL mainnet leader wallet's trades into a PAPER vault's
// ledger at live oracle prices. One 60s tick, started from src/index.ts
// after listen (never during seed):
//
//   • targets: paper + active + type "mirror" + leaderWallet set. Real
//     vaults are never touched (the wall), managed vaults have no leader.
//   • per leader per tick: 1 getSignaturesForAddress (limit 15, until
//     the dedupe cursor) + ≤10 getTransaction, sequential with 250ms
//     gaps and Retry-After-aware backoff — walletScan's RPC conventions,
//     shared via rpcWithRetry.
//   • ATTACH-FORWARD: the first ever sync (mirrorLastSig null) mirrors
//     NOTHING — it just records where the leader's timeline currently
//     ends, exactly like a real copy engine attaching to a live wallet.
//     History is never replayed as fresh fills.
//   • classification is walletScan's balance-diff classifier — the same
//     code path that powers tracked-wallet scans. We never guess a side
//     or a size; a tx that doesn't classify as a clean SOL swap is
//     ignored.
//   • fills go through executeTrade (live oracle mark, buffer
//     accounting, equity points — everything the manual trade path
//     gets). A 422 (no oracle price — typical for fresh pump tokens)
//     skips that copy and is logged; the cursor still advances, so a
//     skipped copy is skipped forever, never retried as a stale fill.
//
// Copy-lag honesty: copyLagSlots is derived from ELAPSED TIME —
// (paper fill unix time − leader blockTime) / 0.4s per slot — because a
// paper fill has no real landed slot. It is an approximation of how far
// behind the leader the copy landed, not real slot math, and is labeled
// as such here so nobody mistakes it for on-chain measurement.

import type { Vault as DbVault } from "@prisma/client";
import { prisma } from "../db.js";
import { executeTrade, TradeError } from "./trading.js";
import {
  type ClassifiedSwap,
  classifySwap,
  type ParsedTx,
  rpcWithRetry,
  type SigInfo,
} from "./walletScan.js";

const MIRROR_TICK_MS = 60_000;
/** 1 getSignaturesForAddress per leader per tick, at most this many sigs */
const SIG_LIMIT = 15;
/** ≤ this many getTransaction calls per leader per tick (public RPC budget) */
const TX_BUDGET = 10;
const RPC_GAP_MS = 250;
/** per-leader time box — overruns drop the rest of the batch (cursor still advances) */
const LEADER_DEADLINE_MS = 40_000;
/** copies smaller than this are noise, not trades — skip and log */
const MIN_COPY_SOL = 0.01;
/** null mirrorFixedSol means this (SOL per copied buy) */
const DEFAULT_FIXED_SOL = 0.25;
/** null mirrorMaxSol means this (hard per-copy cap, SOL) */
const DEFAULT_MAX_SOL = 1.0;
/** proportional sizing: leaderSolSpent × (tvl / this) */
const PROPORTIONAL_REF_TVL_SOL = 1_000;
/** mainnet slot time used for the elapsed-time lag approximation */
const SLOT_SEC = 0.4;
const MAX_LAG_SLOTS = 9_999;

const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (sig: string) => `${sig.slice(0, 8)}…`;

let mirrorTimer: NodeJS.Timeout | null = null;
let mirrorTickRunning = false;

export function startMirrorEngine(): void {
  if (mirrorTimer) return; // already running
  mirrorTimer = setInterval(() => void mirrorTick(), MIRROR_TICK_MS);
  console.log(`[mirror] started — leader sync every ${MIRROR_TICK_MS / 1000}s`);
}

export function stopMirrorEngine(): void {
  if (mirrorTimer) clearInterval(mirrorTimer);
  mirrorTimer = null;
}

// ── the tick ───────────────────────────────────────────────────────

export async function mirrorTick(): Promise<void> {
  if (mirrorTickRunning) return; // previous tick still in flight
  mirrorTickRunning = true;
  try {
    // paper + active + mirror + leader set. Real-mode vaults NEVER get
    // here (the wall); executeTrade re-rejects them regardless.
    const targets = await prisma.vault.findMany({
      where: {
        mode: "paper",
        status: "active",
        type: "mirror",
        leaderWallet: { not: null },
      },
      orderBy: { createdAt: "asc" },
    });

    // sequential on purpose — one shared public-RPC budget, no bursts
    for (const vault of targets) {
      try {
        await syncLeader(vault);
      } catch (err) {
        // one leader failing (RPC down, 429 wall) never kills the tick
        console.error(`[mirror] ${vault.name} (${vault.id}): sync failed:`, err);
      }
      await sleep(RPC_GAP_MS);
    }
  } catch (err) {
    console.error("[mirror] tick failed:", err);
  } finally {
    mirrorTickRunning = false;
  }
}

// ── per-leader sync ────────────────────────────────────────────────

async function syncLeader(vault: DbVault): Promise<void> {
  const leader = vault.leaderWallet!;
  const deadline = Date.now() + LEADER_DEADLINE_MS;

  const sigs =
    (await rpcWithRetry<SigInfo[]>(
      "getSignaturesForAddress",
      [leader, { limit: SIG_LIMIT, ...(vault.mirrorLastSig ? { until: vault.mirrorLastSig } : {}) }],
      deadline,
    )) ?? [];

  // ── attach-forward: first sync records the cursor, mirrors nothing ──
  if (!vault.mirrorLastSig) {
    if (sigs.length > 0) {
      await prisma.vault.update({
        where: { id: vault.id },
        data: { mirrorLastSig: sigs[0]!.signature, mirrorSyncedAt: nowSec() },
      });
      console.log(
        `[mirror] ${vault.name}: attached to ${short(leader)} at ${short(sigs[0]!.signature)} — history not mirrored`,
      );
    } else {
      // leader has no history yet — stay unattached, try again next tick
      await prisma.vault.update({
        where: { id: vault.id },
        data: { mirrorSyncedAt: nowSec() },
      });
    }
    return;
  }

  if (sigs.length === 0) {
    await prisma.vault.update({ where: { id: vault.id }, data: { mirrorSyncedAt: nowSec() } });
    return;
  }

  // RPC returns newest-first; we copy oldest→newest (leader order).
  // A full page means there may be a gap past the cursor — those txs are
  // dropped (logged), never guessed at.
  if (sigs.length >= SIG_LIMIT) {
    console.warn(
      `[mirror] ${vault.name}: signature page full (${sigs.length}) — leader may have older unseen txs past the cursor; they will NOT be mirrored`,
    );
  }
  const batch = [...sigs].reverse();
  let toProcess = batch.filter((s) => !s.err); // failed leader txs can't be swaps — save the budget
  if (toProcess.length > TX_BUDGET) {
    console.warn(
      `[mirror] ${vault.name}: ${toProcess.length} new txs > budget ${TX_BUDGET} — dropping the oldest ${toProcess.length - TX_BUDGET}`,
    );
    toProcess = toProcess.slice(toProcess.length - TX_BUDGET);
  }

  for (const sig of toProcess) {
    if (Date.now() >= deadline) {
      console.warn(`[mirror] ${vault.name}: leader time box hit — dropping rest of batch`);
      break; // cursor still advances below — dropped, never replayed stale
    }
    await sleep(RPC_GAP_MS);
    try {
      const tx = await rpcWithRetry<ParsedTx | null>(
        "getTransaction",
        [sig.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }],
        deadline,
      );
      if (!tx) continue;
      const swap = classifySwap(leader, sig, tx);
      if (!swap) continue; // not a clean SOL swap — transfers, dust, token-to-token
      await copySwap(vault.id, vault.name, swap);
    } catch (err) {
      // RPC gave up (429 wall / timeout) — drop the rest of this batch.
      // The cursor still advances: a missed copy is a logged miss, not a
      // stale fill executed minutes late at a drifted price.
      console.warn(
        `[mirror] ${vault.name}: stopped at ${short(sig.signature)}:`,
        err instanceof Error ? err.message : err,
      );
      break;
    }
  }

  // Advance the cursor over the WHOLE fetched batch exactly once —
  // skipped/dropped copies advance too, so nothing is ever re-processed
  // (no double fills across ticks). Trade-off, documented: a process
  // crash mid-batch re-runs the batch next boot (cursor not yet
  // advanced), which could re-copy already-copied swaps of that batch.
  await prisma.vault.update({
    where: { id: vault.id },
    data: { mirrorLastSig: sigs[0]!.signature, mirrorSyncedAt: nowSec() },
  });
}

// ── copy execution ─────────────────────────────────────────────────

async function copySwap(vaultId: string, vaultName: string, swap: ClassifiedSwap): Promise<void> {
  // re-read: buffer/tvl/status move as this batch's earlier copies land
  const vault = await prisma.vault.findUnique({ where: { id: vaultId } });
  if (!vault || vault.mode !== "paper" || vault.status !== "active") return;

  const tag = `${swap.side} ${swap.symbol ?? short(swap.mint)}`;

  let input: Parameters<typeof executeTrade>[1];
  if (swap.side === "buy") {
    // sizing: fixed SOL, or proportional to leader spend scaled by vault
    // size — ALWAYS capped by mirrorMaxSol and the available buffer.
    const fixed = vault.mirrorFixedSol ?? DEFAULT_FIXED_SOL;
    const max = vault.mirrorMaxSol ?? DEFAULT_MAX_SOL;
    const sized =
      vault.mirrorSizingMode === "proportional"
        ? swap.solAmount * (vault.tvlSol / PROPORTIONAL_REF_TVL_SOL)
        : fixed;
    const solAmount = Math.min(sized, max, vault.solBufferSol);
    if (!(solAmount >= MIN_COPY_SOL)) {
      console.log(
        `[mirror] ${vaultName}: skip ${tag} — sized ${solAmount.toFixed(4)} SOL < ${MIN_COPY_SOL} (buffer ${vault.solBufferSol.toFixed(4)})`,
      );
      return;
    }
    input = { side: "buy", mint: swap.mint, solAmount };
  } else {
    // Sold fraction is honestly derived from the leader's own pre/post
    // token balances: fraction = tokensSold / preSwapBalance. preRaw > 0
    // is guaranteed for a classified sell; the fallback 1 (full exit) is
    // defensive only.
    const fraction =
      swap.preRaw > 0n
        ? Math.min(1, Math.max(0, Number(swap.tokenRaw) / Number(swap.preRaw)))
        : 1;
    if (fraction <= 0) return;
    const position = await prisma.position.findUnique({
      where: { vaultId_mint: { vaultId, mint: swap.mint } },
    });
    if (!position || position.amountTokens <= 0) {
      console.log(`[mirror] ${vaultName}: skip ${tag} — no position in this mint`);
      return;
    }
    input = { side: "sell", mint: swap.mint, sellFraction: fraction };
  }

  try {
    // executeTrade records source from vault.type ("mirror") and enforces
    // the live-oracle-mark rule; we never fill without a price.
    const result = await executeTrade(vaultId, input);

    // Copy lag, honest approximation: elapsed wall time between the
    // leader's blockTime and our paper fill, divided by ~0.4s per
    // mainnet slot. NOT real slot math — a paper fill has no landed
    // slot, so this measures "how late the copy is" in slot units.
    if (swap.ts > 0) {
      const lag = Math.min(
        MAX_LAG_SLOTS,
        Math.max(0, Math.round((result.trade.ts - swap.ts) / SLOT_SEC)),
      );
      await prisma.trade.update({
        where: { id: result.trade.id },
        data: { copyLagSlots: lag },
      });
    }
    console.log(
      `[mirror] ${vaultName}: copied ${tag} — ${result.trade.solAmount.toFixed(4)} SOL ` +
        `(leader ${swap.solAmount.toFixed(4)} SOL, tx ${short(swap.txSig)}) → trade ${result.trade.id}`,
    );
  } catch (err) {
    if (err instanceof TradeError) {
      // 422 = no live oracle mark (fresh pump token) — the copy is
      // skipped, not queued: filling later at a different price would
      // fabricate the fill the leader actually got. Other TradeErrors
      // (buffer raced away, vault frozen mid-batch…) skip too.
      const why = err.status === 422 ? "no oracle price" : err.message;
      console.log(`[mirror] ${vaultName}: skip ${tag} — ${why} (HTTP ${err.status})`);
      return;
    }
    throw err; // db hiccup etc. — bubbles to the batch handler
  }
}
