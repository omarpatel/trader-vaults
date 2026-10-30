import { Router } from "express";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { crystallize, unlockAt } from "../services/fees.js";
import { REAL_VAULT_WALL } from "../services/trading.js";
import { assembleVault, toWithdrawRequest } from "../services/vaults.js";

export const withdrawalsRouter = Router();

const EPS = 1e-9;
const nowSec = () => Math.floor(Date.now() / 1000);

// POST /api/withdrawals/:id/execute — pay out a matured withdraw
// request. Payout is worse-of: min(value at request, shares × current
// share price). Requires the vault's SOL buffer to cover it — the
// trader has to unwind positions first otherwise.
withdrawalsRouter.post("/:id/execute", async (req, res, next) => {
  try {
    const request = await prisma.withdrawRequest.findUnique({
      where: { id: req.params.id },
      include: { vault: true },
    });
    if (!request) {
      res.status(404).json({ error: "withdraw request not found" });
      return;
    }
    if (request.vault.mode === "real") {
      // THE WALL: real-vault payouts are on-chain, never ledger entries
      res.status(409).json(REAL_VAULT_WALL);
      return;
    }
    const now = nowSec();
    if (request.status !== "pending" && request.status !== "executable") {
      res.status(409).json({ error: `request is ${request.status}` });
      return;
    }
    if (now < request.executableAt) {
      res.status(409).json({
        error: `request is not executable until ${request.executableAt} (redeem window)`,
      });
      return;
    }

    const vault = request.vault;
    // worse-of rule: gross proceeds are the lesser of request-time and
    // execution-time value of the shares
    const grossSol = Math.min(request.valueAtRequestSol, request.shares * vault.sharePriceSol);
    if (vault.solBufferSol + EPS < grossSol) {
      res.status(409).json({ error: "vault buffer insufficient — trader must unwind" });
      return;
    }

    const depositor = await prisma.vaultDepositor.findUnique({
      where: { vaultId_userId: { vaultId: vault.id, userId: request.userId } },
    });
    // crystallize the 70/30 split against this portion's cost basis
    const fees = crystallize({
      grossSol,
      positionCostSol: depositor?.costSol ?? grossSol,
      shares: request.shares,
      positionShares: depositor?.shares ?? request.shares,
      perfFeeBps: vault.perfFeeBps,
    });

    // worse-of payouts can pay below fair value — the difference accrues to
    // remaining holders, so recompute per-share value after the exit
    const newShares = Math.max(0, vault.totalShares - request.shares);
    const newTvl = Math.max(0, vault.tvlSol - grossSol);
    const newSharePrice = newShares > 0 ? newTvl / newShares : 1;
    // Claim the request atomically FIRST: two concurrent executes would
    // otherwise both pass the status/buffer checks above and pay twice.
    const claimed = await prisma.withdrawRequest.updateMany({
      where: { id: request.id, status: { in: ["pending", "executable"] } },
      data: { status: "paid", paidAt: now },
    });
    if (claimed.count === 0) {
      res.status(409).json({ error: "request already executed" });
      return;
    }
    const [updated] = await prisma.$transaction([
      prisma.withdrawRequest.update({
        where: { id: request.id },
        data: { status: "paid", paidAt: now },
      }),
      ...(depositor
        ? [
            prisma.vaultDepositor.update({
              where: { id: depositor.id },
              data: {
                shares: { decrement: Math.min(depositor.shares, request.shares) },
                costSol: { decrement: fees.costBasisSol },
                cumulativeTraderFeeSol: { increment: fees.traderFeeSol },
              },
            }),
          ]
        : []),
      prisma.vault.update({
        where: { id: vault.id },
        data: {
          tvlSol: newTvl,
          totalShares: newShares,
          solBufferSol: { decrement: grossSol },
          sharePriceSol: newSharePrice,
          // only the IMMEDIATE leg is spendable trader fees; the vested
          // leg is escrowed for 60 days (VestedFee row below)
          traderFeesAccruedSol: { increment: fees.traderFeeSol },
          vestedFeesAccruedSol: { increment: fees.traderVestedSol },
        },
      }),
      prisma.equityPoint.upsert({
        where: { vaultId_t: { vaultId: vault.id, t: now } },
        update: { v: newSharePrice },
        create: { vaultId: vault.id, t: now, v: newSharePrice },
      }),
      // The escrowed third. Locked 60 days from the moment it
      // crystallizes — which is NOW, at execution, not at request time.
      ...(fees.traderVestedSol > 0
        ? [
            prisma.vestedFee.create({
              data: {
                vaultId: vault.id,
                traderId: vault.traderId,
                amountSol: fees.traderVestedSol,
                crystallizedAt: now,
                unlocksAt: unlockAt(now),
                status: "locked",
                escrowWallet: env.feeEscrowWallet ?? null,
              },
            }),
          ]
        : []),
    ]);

    const assembled = await assembleVault(vault.id);
    res.json({ request: toWithdrawRequest(updated), paidSol: fees.paidSol, fees, vault: assembled });
  } catch (err) {
    next(err);
  }
});
