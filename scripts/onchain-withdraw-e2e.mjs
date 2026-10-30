#!/usr/bin/env node
/**
 * Withdrawal E2E — proves the API's withdrawal builders drive the DEPLOYED
 * program, against a real vault, with real lamports moving.
 *
 * WHY IT MATTERS MORE THAN THE OTHERS. These five instructions are hand-encoded
 * — no IDL, no Anchor client — so the discriminator and the account ORDER are
 * asserted by nothing but the fact that a transaction lands. A builder with the
 * accounts in the wrong order fails at RUNTIME, in production, on the one path
 * a depositor cannot afford to have fail. And a withdrawal path that has never
 * been executed is exactly what the security review called out: the whole suite
 * had one withdrawal in it, asserting a bound that passes if the program pays
 * zero.
 *
 * What it does:
 *   [1] instant_withdraw   — burns shares, asserts the payout ARRIVED and that
 *                            the depositor's balance grew by it
 *   [2] request_withdraw   — asserts the request and the reservation are on the
 *                            accounts afterwards
 *   [3] cancel             — asserts both are released and the shares are back
 *   [4] execute / emergency — SIMULATED. Their gates (a 24h redeem window, 7
 *                            days of keeper silence) cannot be waited out here,
 *                            so instead they are asserted to fail on the
 *                            BUSINESS rule rather than on encoding. A wrong
 *                            discriminator gives InstructionFallbackNotFound;
 *                            a wrong account list gives a constraint error.
 *                            Getting RedeemWindowNotElapsed / NavNotStaleEnough
 *                            is proof the encoding reached the handler.
 *
 * Usage:
 *   E2E_VAULT=<vaultPda> npx tsx scripts/onchain-withdraw-e2e.mjs
 *
 * Env: SOLANA_RPC_URL, SOLANA_CLUSTER, SOLANA_KEYPAIR_PATH (the depositor —
 * this script withdraws ITS OWN position), NAV_KEEPER_KEYPAIR_JSON.
 */
import { PublicKey } from "@solana/web3.js";

import {
  buildCancelWithdrawRequestIx,
  buildEmergencyWithdrawIx,
  buildExecuteWithdrawIx,
  buildInstantWithdrawIx,
  buildRequestWithdrawIx,
  effectiveEquity,
  fetchVaultAccount,
  fetchVaultDepositorAccount,
  valueForShares,
  vaultDepositorPda,
} from "../apps/api/src/services/program.js";
import {
  getConfirmedSlot,
  getConnection,
  getLamports,
  getNavKeeperKeypair,
  getServerKeypair,
  sendAndConfirm,
  simulateOnly,
} from "../apps/api/src/services/signer.js";
import { buildPostNavIx } from "../apps/api/src/services/program.js";

const VAULT = process.env.E2E_VAULT;
if (!VAULT) {
  console.error("set E2E_VAULT=<vaultPda>");
  process.exit(2);
}

let passed = 0;
let failed = 0;
const problems = [];
function ok(m) {
  passed += 1;
  console.log(`  ✓ ${m}`);
}
function fail(m, detail) {
  failed += 1;
  problems.push(m);
  console.log(`  ✗ ${m}${detail ? `\n      ${detail}` : ""}`);
}
function check(cond, m, detail) {
  if (cond) ok(m);
  else fail(m, detail);
}
function head(t) {
  console.log(`\n${t}`);
}

const connection = getConnection();
const me = getServerKeypair();
const vault = new PublicKey(VAULT);
const [depositorPda] = vaultDepositorPda(vault, me.publicKey);

console.log("=".repeat(74));
console.log("Withdrawal E2E — the API's own builders against the deployed program");
console.log("=".repeat(74));
console.log(`  vault      ${vault.toBase58()}`);
console.log(`  depositor  ${me.publicKey.toBase58()}`);
console.log(`  record     ${depositorPda.toBase58()}`);

const v0acc = await fetchVaultAccount(connection, vault);
if (!v0acc) {
  console.error("no vault at that address");
  process.exit(2);
}
const d0acc = await fetchVaultDepositorAccount(connection, depositorPda);
if (!d0acc || d0acc.data.shares === 0n) {
  console.error("this key holds no shares in that vault — run the deposit e2e first");
  process.exit(2);
}

// Refresh the mark first. Every normally priced withdrawal path gates on NAV
// freshness, and this vault is not in the DB so the keeper loop never sees it.
// Posting flat (nav unchanged) restores freshness without moving any value —
// and, since the lamport floor now refuses a mark below the vault's own cash,
// a flat re-post is the only honest thing to send here anyway.
{
  const keeper = getNavKeeperKeypair();
  const slot = await getConfirmedSlot();
  if (slot > v0acc.data.navSlot) {
    const ix = buildPostNavIx({
      vault,
      keeper: keeper.publicKey,
      navLamports: v0acc.data.navLamports,
      markSlot: slot,
    });
    await sendAndConfirm([ix], [keeper], { label: "post_nav (freshen)" });
    console.log(`  freshened  mark re-posted flat at slot ${slot}`);
  }
}
const v0 = await fetchVaultAccount(connection, vault);
v0acc.data = v0.data;

const now = BigInt(Math.floor(Date.now() / 1000));
const equity0 = effectiveEquity(v0acc.data, now);
console.log(`  nav        ${v0acc.data.navLamports} lamports`);
console.log(`  equity     ${equity0} lamports (nav − still-locked profit)`);
console.log(`  my shares  ${d0acc.data.shares}`);
console.log(`  my value   ${valueForShares(d0acc.data.shares, v0acc.data.totalShares, equity0)} lamports`);

// ── [1] instant_withdraw ─────────────────────────────────────────────
head("[1] instant_withdraw — a quarter of the position");
const heldBefore = d0acc.data.shares;
const burn = heldBefore / 4n;
const expected = valueForShares(burn, v0acc.data.totalShares, equity0);
console.log(`    burning ${burn} shares, worth ~${expected} lamports`);

const navAge = Number(now) - Number(v0acc.data.navPostedAt);
const heldFor = Number(now) - Number(d0acc.data.lastDepositTs);
console.log(`    mark age ${navAge}s (instant needs < 300s)`);
console.log(`    held for ${heldFor}s (instant needs >= 3600s)`);

let instantRan = false;
if (navAge >= 300 || heldFor < 3600) {
  console.log("    gates not satisfied right now — simulating instead of sending");
  const ix = buildInstantWithdrawIx({
    authority: me.publicKey,
    vault,
    trader: v0acc.data.trader,
    shares: burn,
  }).ix;
  let logs = [];
  try {
    logs = (await simulateOnly([ix], [])).logs ?? [];
  } catch (e) {
    logs = e?.logs ?? [];
  }
  const joined = logs.join("\n");
  check(
    !/InstructionFallbackNotFound|Fallback functions are not supported/.test(joined),
    "the instruction reached a handler (discriminator is right)",
    joined.slice(0, 300),
  );
  check(
    /NavTooStaleForInstant|DepositHoldNotElapsed/.test(joined),
    "rejected on the expected business gate, not on encoding",
    joined.slice(0, 300),
  );
} else {
  const balBefore = await getLamports(me.publicKey);
  const ix = buildInstantWithdrawIx({
    authority: me.publicKey,
    vault,
    trader: v0acc.data.trader,
    shares: burn,
  }).ix;
  const sent = await sendAndConfirm([ix], [], { label: "instant_withdraw" });
  console.log(`    sig ${sent.signature}`);
  instantRan = true;

  const balAfter = await getLamports(me.publicKey);
  const d1 = await fetchVaultDepositorAccount(connection, depositorPda);
  const v1 = await fetchVaultAccount(connection, vault);
  const fee = BigInt(sent.feeLamports ?? 5000);
  const received = balAfter - balBefore + fee;

  console.log(`    balance ${balBefore} → ${balAfter} (fee ${fee}) → received ${received}`);
  // The one-sided assertion the review called out is exactly what NOT to write:
  // "isAtMost(delta, valueAtRequest)" passes when the program pays zero.
  check(received > 0n, "the payout ACTUALLY ARRIVED (not zero)");
  check(
    received <= expected,
    "payout never exceeds the shares' value",
    `received ${received}, value ${expected}`,
  );
  // Trader fee is taken from profit only; with no profit the payout is exact.
  check(
    received >= (expected * 60n) / 100n,
    "payout is within the performance-fee band of the value",
    `received ${received}, value ${expected}`,
  );
  check(
    d1.data.shares === heldBefore - burn,
    "exactly the burned shares left the depositor record",
    `${d1.data.shares} vs ${heldBefore - burn}`,
  );
  check(
    v1.data.totalShares === v0acc.data.totalShares - burn,
    "total_shares fell by the same amount",
  );
  check(
    v1.data.navLamports < v0acc.data.navLamports,
    "NAV fell to reflect the money that left",
  );
}

// ── [2] request_withdraw ─────────────────────────────────────────────
head("[2] request_withdraw");
const dNow = await fetchVaultDepositorAccount(connection, depositorPda);
const vNow = await fetchVaultAccount(connection, vault);
const reqShares = dNow.data.shares / 4n;

if (dNow.data.lastWithdrawRequest.shares > 0n) {
  console.log("    a request is already pending — cancelling it first");
  const cix = buildCancelWithdrawRequestIx({ authority: me.publicKey, vault }).ix;
  await sendAndConfirm([cix], [], { label: "cancel (cleanup)" });
}

const rix = buildRequestWithdrawIx({ authority: me.publicKey, vault, shares: reqShares }).ix;
const rsent = await sendAndConfirm([rix], [], { label: "request_withdraw" });
console.log(`    sig ${rsent.signature}`);

const d2 = await fetchVaultDepositorAccount(connection, depositorPda);
const v2 = await fetchVaultAccount(connection, vault);
check(d2.data.lastWithdrawRequest.shares === reqShares, "the request records the share count");
check(
  d2.data.lastWithdrawRequest.valueAtRequestLamports > 0n,
  "the request records a non-zero value",
);
check(
  v2.data.pendingWithdrawShares === vNow.data.pendingWithdrawShares + reqShares,
  "the vault's pending share counter grew by the request",
);
check(
  v2.data.pendingWithdrawValueLamports > vNow.data.pendingWithdrawValueLamports,
  "the vault reserved lamports against the request",
);
check(d2.data.shares === dNow.data.shares, "shares are NOT burned by a request");

// ── [3] execute + emergency, simulated ───────────────────────────────
head("[3] execute_withdraw and emergency_withdraw — encoding proof");
for (const [name, ix, expectErr] of [
  [
    "execute_withdraw",
    buildExecuteWithdrawIx({ authority: me.publicKey, vault, trader: v2.data.trader }).ix,
    /RedeemWindowNotElapsed/,
  ],
  [
    "emergency_withdraw",
    buildEmergencyWithdrawIx({
      authority: me.publicKey,
      vault,
      trader: v2.data.trader,
      shares: 1000n,
    }).ix,
    /WithdrawRequestPending|NavNotStaleEnough/,
  ],
]) {
  let logs = [];
  try {
    logs = (await simulateOnly([ix], [])).logs ?? [];
  } catch (e) {
    logs = e?.logs ?? [];
  }
  const joined = logs.join("\n");
  check(
    !/InstructionFallbackNotFound|Fallback functions are not supported/.test(joined),
    `${name}: discriminator reached a handler`,
    joined.slice(0, 250),
  );
  check(
    !/ConstraintSeeds|ConstraintHasOne|AccountNotEnoughKeys|AccountOwnedByWrongProgram/.test(joined),
    `${name}: account list satisfied every constraint`,
    joined.slice(0, 250),
  );
  check(
    expectErr.test(joined),
    `${name}: rejected on its business gate, as expected`,
    joined.slice(0, 250),
  );
}

// ── [4] cancel ───────────────────────────────────────────────────────
head("[4] cancel_withdraw_request");
const cix = buildCancelWithdrawRequestIx({ authority: me.publicKey, vault }).ix;
const csent = await sendAndConfirm([cix], [], { label: "cancel_withdraw_request" });
console.log(`    sig ${csent.signature}`);

const d3 = await fetchVaultDepositorAccount(connection, depositorPda);
const v3 = await fetchVaultAccount(connection, vault);
check(d3.data.lastWithdrawRequest.shares === 0n, "the request is cleared");
check(d3.data.shares === d2.data.shares, "the depositor keeps every share");
check(
  v3.data.pendingWithdrawShares === vNow.data.pendingWithdrawShares,
  "the vault's pending share counter is back where it started",
);
check(
  v3.data.pendingWithdrawValueLamports === vNow.data.pendingWithdrawValueLamports,
  "the reservation is fully released — no lamports left stranded",
);

console.log("\n" + "=".repeat(74));
console.log(
  failed === 0
    ? `RESULT: PASS — ${passed} assertions${instantRan ? ", real lamports moved" : ""}`
    : `RESULT: FAIL — ${failed} of ${passed + failed} checks failed`,
);
for (const p of problems) console.log(`  - ${p}`);
console.log("=".repeat(74));
process.exit(failed === 0 ? 0 : 1);
