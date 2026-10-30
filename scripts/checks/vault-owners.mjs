#!/usr/bin/env node
/**
 * Who actually owns the real vaults?
 *
 * POST /api/vaults fell back to the shared demo user on any auth failure, so
 * anonymous callers could create real vaults that were all assigned to one
 * account. That makes ownership meaningless, breaks creator-fee attribution,
 * and — now that the trade route checks caller == vault.traderId — means the
 * person who thought they made the vault cannot trade it.
 *
 *   npx tsx scripts/checks/vault-owners.mjs
 */
import { prisma } from "../../apps/api/src/db.js";

const rows = await prisma.vault.findMany({
  where: { mode: "real" },
  select: { id: true, name: true, traderId: true, onchainVaultPda: true },
  orderBy: { createdAt: "asc" },
});

const byTrader = new Map();
for (const r of rows) {
  if (!byTrader.has(r.traderId)) byTrader.set(r.traderId, []);
  byTrader.get(r.traderId).push(r);
}

const users = await prisma.user.findMany({
  where: { id: { in: [...byTrader.keys()] } },
  select: { id: true, handle: true, privyId: true },
});

console.log(`${rows.length} real vaults across ${byTrader.size} owner(s)\n`);
for (const u of users) {
  const owned = byTrader.get(u.id) ?? [];
  const kind = u.privyId ? "real Privy account" : "DEMO / no Privy id";
  console.log(`${u.id}  ${JSON.stringify(u.handle)}  [${kind}]  ${owned.length} vault(s)`);
  for (const v of owned) {
    console.log(`    ${v.id}  ${JSON.stringify(v.name).padEnd(30)} ${v.onchainVaultPda ?? "(no pda)"}`);
  }
  console.log("");
}

await prisma.$disconnect();
