// One-off (2026-08-20): build VaultDepositor rows from the historical
// Deposit/WithdrawRequest ledger (same derivation the portfolio route
// used before the per-depositor ledger existed). Safe to re-run.
import { prisma } from "../src/db.js";

async function main() {
  const deposits = await prisma.deposit.findMany();
  const withdrawals = await prisma.withdrawRequest.findMany({
    where: { status: { not: "cancelled" } },
    orderBy: { requestedAt: "asc" },
  });

  const key = (v: string, u: string) => `${v}:${u}`;
  const state = new Map<string, { vaultId: string; userId: string; shares: number; costSol: number }>();
  for (const d of deposits) {
    const k = key(d.vaultId, d.userId);
    const e = state.get(k) ?? { vaultId: d.vaultId, userId: d.userId, shares: 0, costSol: 0 };
    e.shares += d.shares;
    e.costSol += d.costSol;
    state.set(k, e);
  }
  for (const w of withdrawals) {
    const e = state.get(key(w.vaultId, w.userId));
    if (!e || e.shares <= 0) continue;
    const ratio = Math.min(1, w.shares / e.shares);
    e.costSol -= e.costSol * ratio;
    e.shares -= Math.min(e.shares, w.shares);
  }

  for (const e of state.values()) {
    await prisma.vaultDepositor.upsert({
      where: { vaultId_userId: { vaultId: e.vaultId, userId: e.userId } },
      update: { shares: e.shares, costSol: e.costSol },
      create: { vaultId: e.vaultId, userId: e.userId, shares: e.shares, costSol: e.costSol },
    });
    console.log(`[backfill] vault=${e.vaultId} shares=${e.shares.toFixed(4)} cost=${e.costSol.toFixed(4)}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
