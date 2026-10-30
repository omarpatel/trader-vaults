#!/usr/bin/env node
/**
 * Trader Vaults vault E2E — proves the API's on-chain client drives the DEPLOYED
 * program end to end: create → deposit → decode → mark. Point
 * SOLANA_RPC_URL at whichever cluster you mean to spend on.
 *
 * It deliberately imports the REAL API modules (apps/api/src/services/
 * program.ts + signer.ts) rather than re-implementing the encoders here.
 * A proof that only exercises a copy of the client proves nothing about
 * the client the server actually ships, so this file must be run through
 * tsx:
 *
 *   npx tsx scripts/onchain-vault-e2e.mjs
 *
 * Steps
 *   [0] environment + program + PlatformConfig sanity
 *   [1] init_vault           → tx + vault PDA, seed-share accounting checked
 *   [2] init_depositor       → tx (separate tx on purpose: each instruction
 *   [3] deposit 0.05 SOL     → tx  proves itself independently)
 *   [4] read both accounts back and DECODE — asserts total_shares > 0, the
 *       depositor's shares equal what math.rs says should have been minted,
 *       and vault lamports + NAV both moved by exactly the deposit
 *   [5] post_nav as the keeper → tx, re-read, assert the mark changed and
 *       the gain went into locked_profit (the anti-sandwich drip)
 *
 * Env
 *   SOLANA_RPC_URL       default https://api.devnet.solana.com
 *   SOLANA_KEYPAIR_PATH  default ~/.config/solana/id.json
 *   VAULT_PROGRAM_ID     default HWssGCcxUdiqeEiWk3CRxuSJy6eb4aZH7g2ubo7w6Sqc
 *   E2E_VAULT_NAME       reuse an existing vault instead of creating one
 *   E2E_DEPOSIT_SOL      default 0.05
 *   E2E_SIMULATE=1       dry-run init_vault only; spends nothing
 */

import { PublicKey } from "@solana/web3.js";

import {
  MIN_SEED_LAMPORTS,
  VAULT_PROGRAM_ID,
  buildDepositIx,
  buildInitDepositorIx,
  buildInitVaultIx,
  buildPostNavIx,
  effectiveEquity,
  explorerAddress,
  explorerTx,
  lockedProfitRemaining,
  fetchPlatformConfigAccount,
  fetchVaultAccount,
  fetchVaultDepositorAccount,
  platformConfigPda,
  sharesForDeposit,
  solToLamports,
  treasuryPda,
  vaultDepositorPda,
  vaultPda,
} from "../apps/api/src/services/program.ts";
import {
  OnChainError,
  getConfirmedSlot,
  getConnection,
  getLamports,
  getNavKeeperKeypair,
  getServerKeypair,
  sendAndConfirm,
  simulateOnly,
} from "../apps/api/src/services/signer.ts";

// ── tiny reporter ──────────────────────────────────────────────────
const failures = [];
const checks = [];
const txs = [];

const ok = (m) => {
  checks.push(m);
  console.log(`  ✓ ${m}`);
};
const fail = (m) => {
  failures.push(m);
  console.log(`  ✗ ${m}`);
};
const info = (m) => console.log(`    ${m}`);
const head = (m) => console.log(`\n${m}`);

function assert(cond, passMsg, failMsg) {
  if (cond) ok(passMsg);
  else fail(failMsg ?? passMsg);
  return cond;
}

function printLogs(logs, label = "program logs") {
  if (!logs || logs.length === 0) {
    info("(no logs)");
    return;
  }
  console.log(`    --- ${label} ---`);
  for (const l of logs) console.log(`    | ${l}`);
  console.log("    ---");
}

const sol = (lamports) => `${(Number(lamports) / 1e9).toFixed(9)} SOL`;

function recordTx(label, sent) {
  txs.push({ label, signature: sent.signature });
  ok(`${label} confirmed in slot ${sent.slot ?? "?"} (${sent.unitsConsumed ?? "?"} CU, fee ${sent.feeLamports ?? "?"} lamports)`);
  info(`sig ${sent.signature}`);
  info(explorerTx(sent.signature));
}

// ── main ───────────────────────────────────────────────────────────

async function main() {
  const connection = getConnection();
  const server = getServerKeypair();
  // The NAV keeper is its own key now, and init_vault requires the param to
  // equal platform_config.nav_keeper. Posting a mark below therefore needs
  // that key to sign, not the server key.
  const keeper = getNavKeeperKeypair();
  const simulateOnlyMode = process.env.E2E_SIMULATE === "1";
  const depositSol = Number(process.env.E2E_DEPOSIT_SOL ?? "0.05");
  const depositLamports = solToLamports(depositSol);
  const vaultName = process.env.E2E_VAULT_NAME ?? `e2e-${Date.now().toString(36)}`;

  console.log("=".repeat(74));
  console.log("Trader Vaults vault E2E — via the API's own on-chain client (no IDL)");
  console.log("=".repeat(74));

  // ── [0] environment ──────────────────────────────────────────────
  head("[0] Environment");
  info(`rpc          ${connection.rpcEndpoint}`);
  info(`program      ${VAULT_PROGRAM_ID.toBase58()}`);
  info(`server key   ${server.publicKey.toBase58()}`);
  info(`vault name   "${vaultName}"`);
  info(`deposit      ${depositSol} SOL (${depositLamports} lamports)`);

  const startBalance = await getLamports(server.publicKey);
  info(`balance      ${sol(startBalance)}`);
  if (startBalance < 100_000_000n) {
    fail("server key has < 0.1 SOL — top it up before running this");
    return summarize(startBalance, startBalance, null);
  }

  const progInfo = await connection.getAccountInfo(VAULT_PROGRAM_ID);
  assert(
    progInfo?.executable === true,
    "program account exists and is executable",
    "program account missing or not executable on this cluster",
  );

  const [cfgPda] = platformConfigPda();
  const [treasury] = treasuryPda();
  const cfg = await fetchPlatformConfigAccount(connection, cfgPda);
  if (!cfg) {
    fail(`PlatformConfig ${cfgPda.toBase58()} not found — run scripts/onchain-smoke.mjs first`);
    return summarize(startBalance, startBalance, null);
  }
  ok(`PlatformConfig decoded: admin ${cfg.admin.toBase58()}, kill_switch=${cfg.killSwitch}`);
  info(`treasury     ${treasury.toBase58()}`);
  assert(
    !cfg.killSwitch,
    "platform kill switch is OFF (deposits allowed)",
    "platform kill switch is ON",
  );

  // ── [1] init_vault ───────────────────────────────────────────────
  head("[1] init_vault");
  const seedLamports = MIN_SEED_LAMPORTS; // 0.01 SOL, burned forever
  const { ix: initIx, vault: vaultAddress, bump } = buildInitVaultIx({
    creator: server.publicKey,
    vault: {
      name: vaultName,
      vaultType: "Managed",
      perfFeeBps: 2000,
      redeemWindowSeconds: 86_400n,
      navStalenessSeconds: 3_600n,
      unlockPeriodSeconds: 3_600n,
      maxNavDeltaBps: 2_000,
      // u64::MAX is rejected now: an "uncapped" per-trade notional cap is
      // a field the UI can display and nothing else.
      maxTradeNotionalLamports: 1_000_000_000_000n, // 1000 SOL
      maxPriceImpactBps: 300,
      dailyLossLimitBps: 2_000,
      navKeeper: keeper.publicKey,
      seedLamports,
    },
  });
  info(`vault PDA    ${vaultAddress.toBase58()} (bump ${bump})`);
  info(`accounts     ${initIx.keys.map((k, i) => `#${i} ${k.isSigner ? "s" : "-"}${k.isWritable ? "w" : "-"} ${k.pubkey.toBase58().slice(0, 8)}…`).join("  ")}`);
  info(`ix data      ${initIx.data.length} bytes, disc ${initIx.data.subarray(0, 8).toString("hex")}`);

  if (simulateOnlyMode) {
    const sim = await simulateOnly([initIx]);
    printLogs(sim.logs, "init_vault simulation");
    assert(sim.ok, "init_vault simulates clean", `init_vault simulation failed: ${JSON.stringify(sim.err)}`);
    console.log("\nE2E_SIMULATE=1 — stopping before spending anything.");
    return summarize(startBalance, await getLamports(server.publicKey), vaultAddress);
  }

  let vaultBefore = await fetchVaultAccount(connection, vaultAddress);
  if (vaultBefore) {
    ok("vault already exists on-chain — reusing it (idempotent re-run)");
  } else {
    const sent = await sendAndConfirm([initIx], [], { label: "init_vault" });
    recordTx("init_vault", sent);
    printLogs(sent.logs.filter((l) => l.includes("Program log:")), "init_vault program logs");
    vaultBefore = await fetchVaultAccount(connection, vaultAddress);
  }
  if (!vaultBefore) {
    fail("vault account not found after init_vault");
    return summarize(startBalance, await getLamports(server.publicKey), vaultAddress);
  }

  const v0 = vaultBefore.data;
  ok(`Vault decoded: name="${v0.name}" trader=${v0.trader.toBase58().slice(0, 8)}… status=${v0.status} type=${v0.vaultType}`);
  info(`total_shares ${v0.totalShares}  seed_shares ${v0.seedShares}  nav ${v0.navLamports} lamports`);
  assert(v0.bump === bump, "stored bump matches the off-chain derivation");
  assert(v0.name === vaultName, `stored name round-trips ("${v0.name}")`);
  assert(v0.trader.equals(server.publicKey), "trader == creator (server key)");
  assert(
    v0.navKeeper.equals(keeper.publicKey),
    "nav_keeper == the platform's dedicated keeper key",
  );
  assert(
    !v0.navKeeper.equals(server.publicKey),
    "nav_keeper is NOT the server/admin key (the split that B1 required)",
  );
  assert(v0.creator.equals(server.publicKey), "creator recorded, and it seeds the PDA");
  assert(v0.status === "Active", "status == Active");
  assert(
    v0.seedShares === seedLamports * 1_000n,
    `seed_shares == seed_lamports × VIRTUAL_SHARES (${v0.seedShares})`,
    `seed_shares ${v0.seedShares} != ${seedLamports * 1_000n}`,
  );

  // ── [2] init_depositor ───────────────────────────────────────────
  head("[2] init_depositor");
  const [depositorPda, depBump] = vaultDepositorPda(vaultAddress, server.publicKey);
  info(`depositor PDA ${depositorPda.toBase58()} (bump ${depBump})`);
  let depositorBefore = await fetchVaultDepositorAccount(connection, depositorPda);
  if (depositorBefore) {
    ok("depositor record already exists — reusing it");
  } else {
    const { ix } = buildInitDepositorIx({ authority: server.publicKey, vault: vaultAddress });
    const sent = await sendAndConfirm([ix], [], { label: "init_depositor" });
    recordTx("init_depositor", sent);
    depositorBefore = await fetchVaultDepositorAccount(connection, depositorPda);
  }
  if (!depositorBefore) {
    fail("depositor account not found after init_depositor");
    return summarize(startBalance, await getLamports(server.publicKey), vaultAddress);
  }
  assert(
    depositorBefore.data.vault.equals(vaultAddress),
    "depositor.vault points at our vault",
  );
  assert(
    depositorBefore.data.authority.equals(server.publicKey),
    "depositor.authority == signer",
  );

  // ── [3] deposit ──────────────────────────────────────────────────
  head("[3] deposit");
  const vaultLamportsBefore = BigInt(vaultBefore.lamports);
  const sharesBefore = depositorBefore.data.shares;
  const totalSharesBefore = v0.totalShares;
  const navBefore = v0.navLamports;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const equityBefore = effectiveEquity(v0, nowSec);
  const expectedShares = sharesForDeposit(depositLamports, totalSharesBefore, equityBefore);
  // Pricing equity = nav − STILL-LOCKED profit, and the lock drips with the
  // on-chain clock. While profit is dripping the mint is therefore a
  // function of the exact second the transaction executes, which no client
  // can know in advance — so predict a BRACKET (± SKEW seconds) instead of
  // a single number, and only demand exactness when nothing is locked.
  const SKEW = 30n;
  const dripping =
    lockedProfitRemaining(v0.lockedProfit, v0.lockedProfitTs, v0.unlockPeriodSeconds, nowSec) > 0n;
  const sharesAt = (t) =>
    sharesForDeposit(depositLamports, totalSharesBefore, effectiveEquity(v0, t));
  const expectedMax = sharesAt(nowSec - SKEW); // more locked → lower equity → more shares
  const expectedMin = sharesAt(nowSec + SKEW);
  info(`pre-state: total_shares=${totalSharesBefore} equity=${equityBefore} nav=${navBefore}`);
  info(`math.rs predicts ${expectedShares} shares for ${depositLamports} lamports`);
  if (dripping) {
    info(`locked profit is still dripping → accepted range [${expectedMin}, ${expectedMax}]`);
  }

  const { ix: depositIx } = buildDepositIx({
    authority: server.publicKey,
    vault: vaultAddress,
    amountLamports: depositLamports,
  });
  const depositSent = await sendAndConfirm([depositIx], [], { label: "deposit" });
  recordTx("deposit", depositSent);
  printLogs(
    depositSent.logs.filter((l) => l.includes("Program log:")),
    "deposit program logs",
  );

  // ── [4] read back + decode ───────────────────────────────────────
  head("[4] Read the accounts back off-chain and decode");
  const vaultAfter = await fetchVaultAccount(connection, vaultAddress);
  const depositorAfter = await fetchVaultDepositorAccount(connection, depositorPda);
  if (!vaultAfter || !depositorAfter) {
    fail("could not read vault/depositor back after the deposit");
    return summarize(startBalance, await getLamports(server.publicKey), vaultAddress);
  }
  const v1 = vaultAfter.data;
  const d1 = depositorAfter.data;

  console.log("    Vault (decoded):");
  info(`  total_shares   ${totalSharesBefore}  ->  ${v1.totalShares}`);
  info(`  manager_shares ${v0.managerShares}  ->  ${v1.managerShares}`);
  info(`  nav_lamports   ${navBefore}  ->  ${v1.navLamports}`);
  info(`  account SOL    ${sol(vaultLamportsBefore)}  ->  ${sol(vaultAfter.lamports)}`);
  console.log("    VaultDepositor (decoded):");
  info(`  shares         ${sharesBefore}  ->  ${d1.shares}`);
  info(`  net_deposits   ${depositorBefore.data.netDepositsLamports}  ->  ${d1.netDepositsLamports}`);

  const mintedToDepositor = d1.shares - sharesBefore;
  const mintedTotal = v1.totalShares - totalSharesBefore;

  assert(v1.totalShares > 0n, `vault.total_shares > 0 (${v1.totalShares})`);
  if (dripping) {
    assert(
      mintedToDepositor >= expectedMin && mintedToDepositor <= expectedMax,
      `depositor's minted shares are inside the drip-adjusted prediction (${mintedToDepositor} ∈ [${expectedMin}, ${expectedMax}])`,
      `depositor minted ${mintedToDepositor}, outside [${expectedMin}, ${expectedMax}]`,
    );
  } else {
    assert(
      mintedToDepositor === expectedShares,
      `depositor's minted shares == math.rs prediction exactly (${mintedToDepositor})`,
      `depositor minted ${mintedToDepositor}, math.rs predicted ${expectedShares}`,
    );
  }
  assert(
    mintedTotal === mintedToDepositor,
    "vault.total_shares grew by exactly the depositor's mint",
    `total_shares grew ${mintedTotal} but depositor got ${mintedToDepositor}`,
  );
  assert(
    v1.navLamports - navBefore === depositLamports,
    `vault.nav_lamports grew by exactly the deposit (+${v1.navLamports - navBefore})`,
    `nav grew ${v1.navLamports - navBefore}, expected ${depositLamports}`,
  );
  assert(
    BigInt(vaultAfter.lamports) - vaultLamportsBefore === depositLamports,
    `vault ACCOUNT lamports grew by exactly the deposit (+${BigInt(vaultAfter.lamports) - vaultLamportsBefore})`,
    `vault lamports grew ${BigInt(vaultAfter.lamports) - vaultLamportsBefore}, expected ${depositLamports}`,
  );
  assert(
    d1.netDepositsLamports - depositorBefore.data.netDepositsLamports === depositLamports,
    "depositor.net_deposits_lamports grew by the deposit",
  );
  // The server key is also the trader, so this deposit is manager co-invest.
  assert(
    v1.managerShares - v0.managerShares === mintedToDepositor,
    "manager_shares tracked the trader's own deposit (co-invest accounting)",
    `manager_shares grew ${v1.managerShares - v0.managerShares}, expected ${mintedToDepositor}`,
  );
  assert(
    v1.navLamports <= BigInt(vaultAfter.lamports),
    "NAV never exceeds the lamports actually sitting on the vault",
  );

  // ── [5] post_nav ─────────────────────────────────────────────────
  head("[5] post_nav (keeper mark)");
  const markSlot = await getConfirmedSlot();
  // +2% — inside max_nav_delta_bps (2000 = 20%) and unambiguously a gain.
  const newNav = v1.navLamports + v1.navLamports / 50n;
  info(`mark_slot ${markSlot} (vault.nav_slot ${v1.navSlot})`);
  info(`nav ${v1.navLamports} -> ${newNav} (+${newNav - v1.navLamports} lamports)`);
  const navIx = buildPostNavIx({
    vault: vaultAddress,
    keeper: keeper.publicKey,
    navLamports: newNav,
    markSlot,
  });
  // Keeper signs, server pays — mirroring how navKeeper.ts sends it.
  const navSent = await sendAndConfirm([navIx], [keeper], { label: "post_nav" });
  recordTx("post_nav", navSent);
  printLogs(navSent.logs.filter((l) => l.includes("Program log:")), "post_nav program logs");

  const vaultAfterNav = await fetchVaultAccount(connection, vaultAddress);
  if (!vaultAfterNav) {
    fail("vault vanished after post_nav");
    return summarize(startBalance, await getLamports(server.publicKey), vaultAddress);
  }
  const v2 = vaultAfterNav.data;
  info(`nav_lamports ${v1.navLamports} -> ${v2.navLamports}`);
  info(`nav_slot     ${v1.navSlot} -> ${v2.navSlot}`);
  info(`locked_profit ${v1.lockedProfit} -> ${v2.lockedProfit} (drips over ${v2.unlockPeriodSeconds}s)`);
  assert(v2.navLamports === newNav, `vault.nav_lamports is the value we posted (${v2.navLamports})`);
  assert(v2.navLamports !== v1.navLamports, "NAV actually changed");
  assert(v2.navSlot === markSlot, `vault.nav_slot == our mark_slot (${v2.navSlot})`);
  assert(v2.navPostedAt >= v1.navPostedAt, "nav_posted_at moved forward (freshness restored)");
  assert(
    v2.lockedProfit >= newNav - v1.navLamports,
    `the gain went into locked_profit (${v2.lockedProfit}) — anti-sandwich drip`,
    `locked_profit ${v2.lockedProfit} < gain ${newNav - v1.navLamports}`,
  );
  assert(v2.status === "Active", "vault still Active (daily-loss breaker not tripped by a gain)");
  const equityAfterNav = effectiveEquity(v2, BigInt(Math.floor(Date.now() / 1000)));
  info(`effective equity right now: ${equityAfterNav} lamports (nav − still-locked profit)`);

  return summarize(startBalance, await getLamports(server.publicKey), vaultAddress, depositorPda);
}

async function summarize(startBalance, endBalance, vaultAddress, depositorPda) {
  console.log(`\n${"=".repeat(74)}`);
  if (failures.length === 0) {
    console.log(`RESULT: PASS — ${checks.length} assertions, ${txs.length} transactions.`);
  } else {
    console.log(`RESULT: FAIL — ${failures.length} of ${checks.length + failures.length} checks failed:`);
    for (const f of failures) console.log(`  - ${f}`);
  }
  if (txs.length > 0) {
    console.log("\n  transactions");
    for (const t of txs) {
      console.log(`    ${t.label.padEnd(16)} ${t.signature}`);
      console.log(`    ${" ".repeat(16)} ${explorerTx(t.signature)}`);
    }
  }
  if (vaultAddress) {
    console.log("\n  accounts");
    console.log(`    vault            ${vaultAddress.toBase58()}`);
    console.log(`                     ${explorerAddress(vaultAddress.toBase58())}`);
    if (depositorPda) {
      console.log(`    vault_depositor  ${depositorPda.toBase58()}`);
      console.log(`                     ${explorerAddress(depositorPda.toBase58())}`);
    }
  }
  const spent = startBalance - endBalance;
  console.log(
    `\n  spent: ${sol(startBalance)} -> ${sol(endBalance)}  (spent ${sol(spent)})`,
  );
  console.log("=".repeat(74));
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch(async (e) => {
  console.error("\nUNCAUGHT:", e instanceof Error ? e.message : e);
  if (e instanceof OnChainError) {
    console.error(`  phase: ${e.phase}  anchor error: ${e.anchorErrorCode ?? "n/a"}`);
    printLogs(e.logs, "program logs");
  }
  failures.push(e instanceof Error ? e.message : String(e));
  try {
    const bal = await getLamports(new PublicKey(getServerKeypair().publicKey));
    await summarize(bal, bal, null);
  } catch {
    process.exitCode = 1;
  }
  process.exitCode = 1;
});
