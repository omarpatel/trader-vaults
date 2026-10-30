// ── Honest seed ─────────────────────────────────────────────────────
// No LARP: no invented traders, no fabricated trade histories, no fake
// tracked wallets. The platform starts empty and every number shown is
// produced by real usage — vault creation, deposits, trades at live
// oracle marks, scans of real mainnet wallets.
//
// Idempotent: wipes all ledger data, keeps only the demo account row
// (which getDemoUser would recreate anyway).

import { prisma } from "./db.js";

async function main() {
  // dependency order: children first
  await prisma.dcaOrder.deleteMany();
  await prisma.order.deleteMany();
  await prisma.withdrawRequest.deleteMany();
  await prisma.deposit.deleteMany();
  await prisma.trade.deleteMany();
  await prisma.position.deleteMany();
  await prisma.equityPoint.deleteMany();
  await prisma.trackedWallet.deleteMany();
  await prisma.vault.deleteMany();
  await prisma.user.deleteMany();

  await prisma.user.upsert({
    where: { handle: "you" },
    update: {},
    create: {
      handle: "you",
      displayName: "You (demo)",
      bio: "Local demo account. Deposits and withdrawals here are ledger entries, not transactions.",
    },
  });

  console.log("[seed] clean slate: demo account only — no fabricated data");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
