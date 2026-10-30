// One-off: purge audit/QA debris and repair corrupted rows.
import { prisma } from "../src/db.js";

async function main() {
  const vaults = await prisma.vault.findMany();
  const junk = vaults.filter(
    (v) =>
      v.name.length > 60 ||
      v.tvlSol < 0 ||
      v.totalShares < 0 ||
      v.solBufferSol < 0 ||
      /^(QA |repro |x{20,}|Z{20,})/i.test(v.name),
  );
  for (const v of junk) {
    await prisma.$transaction([
      prisma.dcaOrder.deleteMany({ where: { vaultId: v.id } }),
      prisma.order.deleteMany({ where: { vaultId: v.id } }),
      prisma.withdrawRequest.deleteMany({ where: { vaultId: v.id } }),
      prisma.deposit.deleteMany({ where: { vaultId: v.id } }),
      prisma.vaultDepositor.deleteMany({ where: { vaultId: v.id } }),
      prisma.trade.deleteMany({ where: { vaultId: v.id } }),
      prisma.position.deleteMany({ where: { vaultId: v.id } }),
      prisma.equityPoint.deleteMany({ where: { vaultId: v.id } }),
      prisma.vault.delete({ where: { id: v.id } }),
    ]);
    console.log(`[cleanup] removed ${v.name.slice(0, 40)}${v.name.length > 40 ? "…" : ""} (len ${v.name.length}, tvl ${v.tvlSol})`);
  }

  // repair U+FFFD from a bad encoding round-trip
  for (const v of await prisma.vault.findMany()) {
    if (v.thesis?.includes("\uFFFD")) {
      const fixed = v.thesis.replace(/\uFFFD/g, "—");
      await prisma.vault.update({ where: { id: v.id }, data: { thesis: fixed } });
      console.log(`[cleanup] repaired thesis on ${v.name}`);
    }
  }

  // any depositor row left negative by the withdrawal race
  const neg = await prisma.vaultDepositor.findMany({ where: { shares: { lt: 0 } } });
  for (const d of neg) {
    await prisma.vaultDepositor.update({ where: { id: d.id }, data: { shares: 0, costSol: 0 } });
    console.log(`[cleanup] zeroed negative depositor ${d.id}`);
  }

  const left = await prisma.vault.count();
  console.log(`[cleanup] done — ${left} vaults remain`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => void prisma.$disconnect());
