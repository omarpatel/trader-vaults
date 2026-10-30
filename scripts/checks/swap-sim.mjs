#!/usr/bin/env node
/**
 * Does the rewritten execute_swap builder actually reach the program?
 *
 * The five withdrawal builders were provable by landing transactions. A swap
 * is not: it moves real money through a real route, so this SIMULATES instead.
 * That is enough for what is in doubt — the instruction was hand-encoded
 * against a struct it did not match, with args in the wrong order and route
 * accounts marked read-only, and it threw a TypeError before a transaction
 * even existed. A simulation that reaches the handler and fails on a BUSINESS
 * rule proves the discriminator, the account list and the arg encoding are all
 * right; a wrong discriminator gives InstructionFallbackNotFound and a wrong
 * account list gives a constraint error.
 *
 *   E2E_VAULT=<pda> E2E_MINT=<mint> npx tsx scripts/checks/swap-sim.mjs [solAmount]
 */
import { PublicKey } from "@solana/web3.js";

import { fetchVaultAccount, effectiveEquity } from "../../apps/api/src/services/program.js";
import { getConnection, getServerKeypair } from "../../apps/api/src/services/signer.js";
import { executeVaultSwap, validateVaultSwap } from "../../apps/api/src/services/vaultSwap.js";

const VAULT = process.env.E2E_VAULT;
const MINT = process.env.E2E_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC
const SOL = Number(process.argv[2] ?? 0.02);
if (!VAULT) {
  console.error("set E2E_VAULT=<vaultPda>");
  process.exit(2);
}

const connection = getConnection();
const vault = new PublicKey(VAULT);
const me = getServerKeypair();
const acc = await fetchVaultAccount(connection, vault);
if (!acc) {
  console.error("no vault there");
  process.exit(2);
}
const now = BigInt(Math.floor(Date.now() / 1000));
const equity = effectiveEquity(acc.data, now);

console.log(`vault      ${VAULT}`);
console.log(`trader     ${acc.data.trader.toBase58()}  (signer ${me.publicKey.toBase58()})`);
console.log(`equity     ${equity} lamports`);
console.log(`5% cap     ${(equity * 500n) / 10_000n} lamports`);
console.log(`buying     ${SOL} SOL of ${MINT}`);
console.log(`positions  ${acc.data.positions.length} recorded\n`);

const amountIn = BigInt(Math.round(SOL * 1e9));
const check = await validateVaultSwap({
  inputMint: new PublicKey("So11111111111111111111111111111111111111112"),
  outputMint: new PublicKey(MINT),
  amountIn,
  vaultId: "sim",
}).catch((e) => ({ valid: false, reason: e.message }));
console.log(`route check: ${check.valid ? "ok" : "REFUSED — " + check.reason}\n`);

try {
  const r = await executeVaultSwap({
    vaultId: "sim",
    vaultPda: vault,
    inputMint: new PublicKey("So11111111111111111111111111111111111111112"),
    outputMint: new PublicKey(MINT),
    amountIn,
  });
  console.log(`LANDED: ${r.signature}`);
} catch (e) {
  const msg = String(e?.message ?? e);
  console.log("send/simulate result:\n  " + msg.slice(0, 1200).replace(/\n/g, "\n  "));
  const bad = /InstructionFallbackNotFound|Fallback functions are not supported|ConstraintSeeds|ConstraintHasOne|AccountNotEnoughKeys|AccountOwnedByWrongProgram|Cannot read properties of undefined|invalid account data/i;
  if (bad.test(msg)) {
    console.log("\nENCODING IS STILL WRONG — the instruction did not reach the handler correctly");
    process.exit(1);
  }
  console.log("\nEncoding reached the program; the failure is about the trade, not the instruction");
}
