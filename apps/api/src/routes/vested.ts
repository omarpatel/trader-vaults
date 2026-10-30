// ── vested (escrowed) trader fees ───────────────────────────────────
// One third of every crystallized performance fee is routed to the
// platform-controlled escrow wallet and locked for VEST_LOCK_DAYS. This
// router is how a trader sees and claims it.
//
// TIME IS THE ONLY GATE. A tranche becomes claimable the instant
// `unlocksAt <= now` — computed on every read, never waited for. There is
// deliberately no cron: a scheduler that dies must not be able to strand
// a trader's money. The stored `status` column is a cache of that
// computation, refreshed opportunistically on read; the claim path
// re-checks the clock itself and never trusts the column.
//
// DEVNET NOTE: `amountSol` is bookkeeping. `escrowWallet` records the
// destination each tranche is booked against; paper vaults move no
// lamports, so `claimSig` stays null until a real transfer backs a claim.

import {
  VEST_LOCK_DAYS,
  type VestedFeeStatus,
  type VestedFeeSummary,
  type VestedFeeTranche,
} from "@trader-vaults/shared";
import { Router } from "express";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { getDemoUser } from "../services/vaults.js";

export const vestedRouter = Router();

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * Whose vested fees are we looking at? The rest of the API resolves the
 * caller through getDemoUser(), and vaults created here are owned by
 * that same user — so an absent or "me" traderId means the demo user.
 * An explicit id lets the trader dashboard ask about the trader of the
 * vault it is currently showing (seeded vaults have their own owners).
 */
async function resolveTraderId(raw: unknown): Promise<string> {
  const q = typeof raw === "string" ? raw.trim() : "";
  if (q === "" || q === "me") return (await getDemoUser()).id;
  return q;
}

type DbVestedFee = {
  id: string;
  vaultId: string;
  traderId: string;
  amountSol: number;
  crystallizedAt: number;
  unlocksAt: number;
  status: string;
  claimedAt: number | null;
  claimSig: string | null;
  escrowWallet: string | null;
  vault: { name: string };
};

/** Status as of `now` — the column is only ever a cache of this. */
function effectiveStatus(row: { status: string; unlocksAt: number }, now: number): VestedFeeStatus {
  if (row.status === "claimed") return "claimed";
  return now >= row.unlocksAt ? "claimable" : "locked";
}

function toTranche(row: DbVestedFee, now: number): VestedFeeTranche {
  return {
    id: row.id,
    vaultId: row.vaultId,
    vaultName: row.vault.name,
    traderId: row.traderId,
    amountSol: row.amountSol,
    crystallizedAt: row.crystallizedAt,
    unlocksAt: row.unlocksAt,
    status: effectiveStatus(row, now),
    claimedAt: row.claimedAt ?? undefined,
    claimSig: row.claimSig ?? undefined,
    escrowWallet: row.escrowWallet ?? undefined,
  };
}

/**
 * Persist the locked → claimable flip for anything whose clock has run
 * out. Idempotent and cheap; purely an optimization so the
 * (traderId, status) index stays meaningful. Correctness never depends
 * on it — every read recomputes the status anyway.
 */
async function refreshMatured(traderId: string, now: number): Promise<void> {
  await prisma.vestedFee.updateMany({
    where: { traderId, status: "locked", unlocksAt: { lte: now } },
    data: { status: "claimable" },
  });
}

async function summarize(traderId: string, now: number): Promise<VestedFeeSummary> {
  const rows = (await prisma.vestedFee.findMany({
    where: { traderId },
    include: { vault: { select: { name: true } } },
    orderBy: { unlocksAt: "asc" },
  })) as DbVestedFee[];

  const tranches = rows.map((r) => toTranche(r, now));
  let lockedSol = 0;
  let claimableSol = 0;
  let claimedSol = 0;
  let nextUnlockAt: number | null = null;
  for (const t of tranches) {
    if (t.status === "locked") {
      lockedSol += t.amountSol;
      if (nextUnlockAt === null || t.unlocksAt < nextUnlockAt) nextUnlockAt = t.unlocksAt;
    } else if (t.status === "claimable") {
      claimableSol += t.amountSol;
    } else {
      claimedSol += t.amountSol;
    }
  }
  return {
    traderId,
    escrowWallet: env.feeEscrowWallet ?? null,
    lockedSol,
    claimableSol,
    claimedSol,
    nextUnlockAt,
    tranches,
  };
}

// GET /api/vested?traderId=me — locked + claimable totals and every
// tranche with its unlock date.
vestedRouter.get("/", async (req, res, next) => {
  try {
    const traderId = await resolveTraderId(req.query.traderId);
    const now = nowSec();
    await refreshMatured(traderId, now);
    res.json({ ...(await summarize(traderId, now)), lockDays: VEST_LOCK_DAYS, now });
  } catch (err) {
    next(err);
  }
});

// POST /api/vested/:id/claim — refuses before unlocksAt, marks claimed
// after. The clock is re-read here; a stale "claimable" column cannot
// unlock anything early.
vestedRouter.post("/:id/claim", async (req, res, next) => {
  try {
    const now = nowSec();
    const row = await prisma.vestedFee.findUnique({
      where: { id: req.params.id },
      include: { vault: { select: { name: true } } },
    });
    if (!row) {
      res.status(404).json({ error: "vested fee tranche not found" });
      return;
    }
    if (row.status === "claimed") {
      res.status(409).json({
        error: "tranche already claimed",
        code: "already_claimed",
        claimedAt: row.claimedAt,
      });
      return;
    }
    if (now < row.unlocksAt) {
      const secondsRemaining = row.unlocksAt - now;
      res.status(409).json({
        error:
          `tranche is locked for another ${Math.ceil(secondsRemaining / 86_400)} day(s) — ` +
          `it unlocks at ${row.unlocksAt} (${VEST_LOCK_DAYS} days after it crystallized)`,
        code: "vest_locked",
        unlocksAt: row.unlocksAt,
        secondsRemaining,
        amountSol: row.amountSol,
      });
      return;
    }

    // Atomic claim: two concurrent requests must not both succeed.
    const claimed = await prisma.vestedFee.updateMany({
      where: { id: row.id, status: { in: ["locked", "claimable"] } },
      data: { status: "claimed", claimedAt: now },
    });
    if (claimed.count === 0) {
      res.status(409).json({ error: "tranche already claimed", code: "already_claimed" });
      return;
    }

    const updated = (await prisma.vestedFee.findUnique({
      where: { id: row.id },
      include: { vault: { select: { name: true } } },
    })) as DbVestedFee;
    res.json({
      tranche: toTranche(updated, now),
      // On devnet the escrow leg is bookkeeping: the tranche is marked
      // claimed and the destination is reported, but no lamports moved,
      // so there is no signature to show.
      claimSig: updated.claimSig ?? null,
      escrowWallet: env.feeEscrowWallet ?? null,
      summary: await summarize(row.traderId, now),
    });
  } catch (err) {
    next(err);
  }
});
