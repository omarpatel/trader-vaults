// One-off (2026-08-20): QA cleanup + share-price backfill + equity-curve
// semantics change (TVL → per-share value). Safe to re-run.
import { prisma } from "../src/db.js";

async function main() {
  // 1) remove QA/test vaults created by the test fleet
  const qa = await prisma.vault.findMany({
    where: { OR: [{ name: { startsWith: "QA " } }, { name: { startsWith: "repro " } }] },
    select: { id: true, name: true },
  });
  for (const v of qa) {
    await prisma.dcaOrder.deleteMany({ where: { vaultId: v.id } });
    await prisma.order.deleteMany({ where: { vaultId: v.id } });
    await prisma.withdrawRequest.deleteMany({ where: { vaultId: v.id } });
    await prisma.deposit.deleteMany({ where: { vaultId: v.id } });
    await prisma.trade.deleteMany({ where: { vaultId: v.id } });
    await prisma.position.deleteMany({ where: { vaultId: v.id } });
    await prisma.equityPoint.deleteMany({ where: { vaultId: v.id } });
    await prisma.vault.delete({ where: { id: v.id } });
    console.log(`[migrate] removed QA vault: ${v.name}`);
  }

  // 2) trim stored symbols/names (upstream whitespace)
  const positions = await prisma.position.findMany();
  for (const p of positions) {
    const symbol = p.symbol.trim();
    const name = p.name?.trim() ?? null;
    if (symbol !== p.symbol || name !== (p.name ?? null)) {
      await prisma.position.update({ where: { id: p.id }, data: { symbol, name } });
    }
  }
  const trades = await prisma.trade.findMany({ select: { id: true, symbol: true } });
  for (const t of trades) {
    if (t.symbol.trim() !== t.symbol) {
      await prisma.trade.update({ where: { id: t.id }, data: { symbol: t.symbol.trim() } });
    }
  }

  // 3) recompute share prices; restart equity curves as per-share value
  const vaults = await prisma.vault.findMany();
  const now = Math.floor(Date.now() / 1000);
  for (const v of vaults) {
    const sharePriceSol = v.totalShares > 0 ? v.tvlSol / v.totalShares : 1;
    await prisma.vault.update({ where: { id: v.id }, data: { sharePriceSol } });
    await prisma.equityPoint.deleteMany({ where: { vaultId: v.id } });
    await prisma.equityPoint.create({ data: { vaultId: v.id, t: now, v: sharePriceSol } });
    console.log(`[migrate] ${v.name}: sharePrice=${sharePriceSol.toFixed(6)} (tvl=${v.tvlSol.toFixed(4)}, shares=${v.totalShares.toFixed(4)})`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
