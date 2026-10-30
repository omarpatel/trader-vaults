#!/usr/bin/env node
/**
 * Re-create on-chain vaults for real vault rows that no longer have one.
 *
 * WHY THIS EXISTS. Vault PDAs used to be seeded on the name alone, which meant
 * anyone could squat a trader's vault name with a higher priority fee and
 * become its trader. They are seeded on ["vault", creator, name] now, so every
 * vault created under the old seeds sits at an address this build cannot
 * derive and cannot decode — the row still says "real", the API still points
 * at a PDA, and every read of it fails. Nothing in the codebase re-created
 * them, because vault creation only ever ran once, inline, at row creation.
 *
 * What it does per row:
 *   - derive the CURRENT PDA from (server key, row id)
 *   - if a decodable vault already lives there, just repair the row's pointer
 *   - otherwise run init_vault and write the new PDA + signature back
 *
 * Idempotent: re-running only touches rows that still need it. A vault that
 * already exists is never re-seeded, so a retry cannot burn a second seed
 * deposit.
 *
 * Usage:
 *   npx tsx scripts/migrate-vaults.mjs            # dry run, spends nothing
 *   npx tsx scripts/migrate-vaults.mjs --apply    # actually migrate
 *   npx tsx scripts/migrate-vaults.mjs --apply --only <vaultId>
 *
 * Env: the API's own — DATABASE_URL, SOLANA_RPC_URL, SOLANA_CLUSTER,
 * SOLANA_KEYPAIR_PATH / SOLANA_KEYPAIR_JSON.
 */
import { PublicKey } from "@solana/web3.js";

import { prisma } from "../apps/api/src/db.js";
import {
  StaleVaultLayoutError,
  VAULT_PROGRAM_ID,
  fetchVaultAccount,
  vaultPda,
} from "../apps/api/src/services/program.js";
import { getConnection, getServerKeypair, getLamports } from "../apps/api/src/services/signer.js";
import { initVaultOnChain } from "../apps/api/src/services/onchainVaults.js";

const APPLY = process.argv.includes("--apply");
const onlyIdx = process.argv.indexOf("--only");
const ONLY = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;

/** Rough cost of one init_vault: account rent + the burned seed + fees. */
const COST_PER_VAULT_SOL = 0.019;

const connection = getConnection();
const server = getServerKeypair();

console.log("=".repeat(74));
console.log("Vault migration — re-create on-chain vaults under the current PDA seeds");
console.log("=".repeat(74));
console.log(`  program   ${VAULT_PROGRAM_ID.toBase58()}`);
console.log(`  creator   ${server.publicKey.toBase58()} (seeds the PDA)`);
console.log(`  mode      ${APPLY ? "APPLY — will send transactions" : "DRY RUN — spends nothing"}`);

const rows = await prisma.vault.findMany({
  where: { mode: "real", ...(ONLY ? { id: ONLY } : {}) },
  select: {
    id: true,
    name: true,
    status: true,
    perfFeeBps: true,
    redeemWindowHours: true,
    type: true,
    onchainVaultPda: true,
  },
  orderBy: { createdAt: "asc" },
});
console.log(`  rows      ${rows.length} real vault(s)\n`);

/** ok | stale | missing | wrong_pointer */
async function classify(row) {
  const [expected] = vaultPda(server.publicKey, row.id);
  let live = null;
  try {
    live = await fetchVaultAccount(connection, expected);
  } catch (e) {
    if (!(e instanceof StaleVaultLayoutError)) throw e;
    // An account at the CURRENT address that does not decode would mean the
    // seeds collided with something older, which cannot happen — the creator
    // is in the seeds now. Treat it as fatal rather than guessing.
    return { state: "corrupt", expected, detail: e.message };
  }
  if (live) {
    return {
      state: row.onchainVaultPda === expected.toBase58() ? "ok" : "wrong_pointer",
      expected,
      live,
    };
  }
  return { state: row.onchainVaultPda ? "stale" : "missing", expected };
}

const plan = [];
for (const row of rows) {
  const c = await classify(row);
  plan.push({ row, ...c });
  const label = `${row.id}  ${JSON.stringify(row.name).padEnd(26)}`;
  switch (c.state) {
    case "ok":
      console.log(`  ok            ${label} ${c.expected.toBase58()}`);
      break;
    case "wrong_pointer":
      console.log(`  repair row    ${label} exists at ${c.expected.toBase58()}, row points elsewhere`);
      break;
    case "stale":
      console.log(`  RECREATE      ${label} row -> ${row.onchainVaultPda} (old seeds, unreachable)`);
      break;
    case "missing":
      console.log(`  CREATE        ${label} never had an on-chain account`);
      break;
    case "corrupt":
      console.log(`  CORRUPT       ${label} ${c.detail}`);
      break;
  }
}

const toCreate = plan.filter((p) => p.state === "stale" || p.state === "missing");
const toRepair = plan.filter((p) => p.state === "wrong_pointer");
const corrupt = plan.filter((p) => p.state === "corrupt");

console.log("");
console.log(`  ${plan.filter((p) => p.state === "ok").length} already correct`);
console.log(`  ${toRepair.length} row pointer(s) to repair (no transaction)`);
console.log(`  ${toCreate.length} vault(s) to create on-chain`);
if (corrupt.length) console.log(`  ${corrupt.length} CORRUPT — not touched`);

if (toCreate.length) {
  const est = toCreate.length * COST_PER_VAULT_SOL;
  const bal = Number(await getLamports(server.publicKey)) / 1e9;
  console.log(`\n  estimated cost  ~${est.toFixed(4)} SOL`);
  console.log(`  creator balance  ${bal.toFixed(6)} SOL`);
  if (bal < est) {
    console.error(`\nFAIL — creator holds ${bal.toFixed(6)} SOL, needs ~${est.toFixed(4)}`);
    await prisma.$disconnect();
    process.exit(1);
  }
}

if (!APPLY) {
  console.log("\nDry run. Re-run with --apply to migrate.");
  await prisma.$disconnect();
  process.exit(0);
}

if (toCreate.length === 0 && toRepair.length === 0) {
  console.log("\nNothing to do.");
  await prisma.$disconnect();
  process.exit(0);
}

console.log("\n" + "-".repeat(74));
let created = 0;
let repaired = 0;
const failures = [];

for (const p of toRepair) {
  await prisma.vault.update({
    where: { id: p.row.id },
    data: { onchainVaultPda: p.expected.toBase58() },
  });
  repaired += 1;
  console.log(`  repaired  ${p.row.id} -> ${p.expected.toBase58()}`);
}

for (const p of toCreate) {
  const { row } = p;
  try {
    const result = await initVaultOnChain({
      id: row.id,
      type: row.type === "mirror" ? "mirror" : "managed",
      perfFeeBps: row.perfFeeBps,
      // The row's own redeemWindowHours is used rather than a hardcoded 24:
      // the program enforces a floor now, so a row carrying something below
      // it must fail loudly here instead of silently getting different terms
      // from the ones the trader was shown.
      redeemWindowHours: row.redeemWindowHours,
    });
    await prisma.vault.update({
      where: { id: row.id },
      data: {
        onchainVaultPda: result.vaultPda,
        onchainInitSig: result.signature || null,
      },
    });
    created += 1;
    console.log(
      `  created   ${row.id}  ${result.vaultPda}  ${result.signature ? result.signature.slice(0, 24) + "…" : "(already existed)"}`,
    );
  } catch (err) {
    const msg = err?.message ?? String(err);
    failures.push({ id: row.id, name: row.name, msg });
    console.error(`  FAILED    ${row.id} ${JSON.stringify(row.name)}: ${msg}`);
    for (const line of err?.logs ?? []) console.error(`              | ${line}`);
  }
}

console.log("-".repeat(74));
console.log(`\n  ${repaired} row(s) repaired, ${created} vault(s) created, ${failures.length} failed`);
if (failures.length) {
  console.log("\n  failures:");
  for (const f of failures) console.log(`    ${f.id} ${JSON.stringify(f.name)} — ${f.msg}`);
}
console.log(`\n  creator balance now ${(Number(await getLamports(server.publicKey)) / 1e9).toFixed(6)} SOL`);

await prisma.$disconnect();
process.exit(failures.length ? 1 : 0);
