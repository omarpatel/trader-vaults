#!/usr/bin/env node
/**
 * Does the B1(a) NAV lamport floor actually fire on the DEPLOYED bytecode?
 *
 * The review's fourth complaint was that every claim about this program was a
 * reasoned trace through source — nothing had been executed against what is
 * actually running. This simulates a mark BELOW the vault's own unencumbered
 * lamports and asserts the program refuses it. Simulation only: spends
 * nothing, signs nothing that lands.
 *
 *   npx tsx scripts/checks/nav-floor.mjs <vaultPda>
 */
import { PublicKey } from "@solana/web3.js";

import { buildPostNavIx, fetchVaultAccount, VAULT_ACCOUNT_BYTES } from "../../apps/api/src/services/program.js";
import { getConnection, getNavKeeperKeypair, getConfirmedSlot, simulateOnly } from "../../apps/api/src/services/signer.js";

const target = process.argv[2];
if (!target) {
  console.error("usage: npx tsx scripts/checks/nav-floor.mjs <vaultPda>");
  process.exit(2);
}

const conn = getConnection();
const keeper = getNavKeeperKeypair();
const vault = new PublicKey(target);
const v = await fetchVaultAccount(conn, vault);
if (!v) {
  console.error(`no vault account at ${target}`);
  process.exit(2);
}

const rent = BigInt(await conn.getMinimumBalanceForRentExemption(VAULT_ACCOUNT_BYTES));
const floor = BigInt(v.lamports) - rent - v.data.platformFeesOwedLamports;
console.log(`vault           ${target}`);
console.log(`account lamports ${v.lamports}`);
console.log(`rent-exempt min  ${rent}`);
console.log(`lamport floor    ${floor}   <- a mark below this is provably wrong`);
console.log(`current nav      ${v.data.navLamports}`);

const slot = await getConfirmedSlot();
const below = floor - 1_000_000n;
console.log(`\nposting ${below} (1000000 below the floor)...`);
const ix = buildPostNavIx({ vault, keeper: keeper.publicKey, navLamports: below, markSlot: slot });

let logs = [];
try {
  const sim = await simulateOnly([ix], [keeper]);
  logs = sim.logs ?? [];
} catch (e) {
  logs = e?.logs ?? [];
  if (!logs.length) {
    console.error("simulation threw with no logs:", e?.message ?? e);
    process.exit(1);
  }
}
for (const l of logs) {
  if (/Error|NavBelow|failed/i.test(l)) console.log("  | " + l);
}
const rejected = logs.some((l) => l.includes("NavBelowLamports"));
console.log(
  rejected
    ? "\nREJECTED with NavBelowLamports — the floor is enforced by the running program"
    : "\nNOT REJECTED — the floor is not enforced on this deployment",
);
process.exit(rejected ? 0 : 1);
