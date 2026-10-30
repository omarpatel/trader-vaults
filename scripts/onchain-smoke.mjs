#!/usr/bin/env node
/**
 * Trader Vaults on-chain smoke test — proves the deployed program EXECUTES on devnet.
 *
 * What it does, with zero Anchor client and zero IDL:
 *   1. derives the PDAs from the *_SEED consts in programs/vault/src/state.rs
 *   2. hand-builds `init_platform` (8-byte sighash discriminator, no args)
 *      with the accounts in exactly the order InitPlatform declares them
 *   3. sends + confirms it (already-initialized is treated as success)
 *   4. reads platform_config + treasury back off-chain and asserts owner and
 *      account discriminators, then borsh-decodes PlatformConfig by hand
 *   5. prints PASS/FAIL with the signature and an explorer link
 *
 * Run: node scripts/onchain-smoke.mjs
 * Env: SOLANA_RPC_URL (default https://api.devnet.solana.com)
 *      SOLANA_KEYPAIR (default ~/.config/solana/id.json)
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

// ---------------------------------------------------------------------------
// Constants — mirrored from the program source (state.rs / init_platform.rs)
// ---------------------------------------------------------------------------

const PROGRAM_ID = new PublicKey('HWssGCcxUdiqeEiWk3CRxuSJy6eb4aZH7g2ubo7w6Sqc');
const BPF_LOADER_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

// state.rs
// v2: the account layout gained nav_keeper + pending_admin and an
// allocated PDA cannot grow. Mirrors state.rs::PLATFORM_CONFIG_SEED.
const PLATFORM_CONFIG_SEED = Buffer.from('platform_config_v2');
const TREASURY_SEED = Buffer.from('treasury_v2');

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const KEYPAIR_PATH =
  process.env.SOLANA_KEYPAIR || join(homedir(), '.config', 'solana', 'id.json');

const CLUSTER_QS = '?cluster=devnet';

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

const sha256 = (s) => createHash('sha256').update(s).digest();

/** Anchor instruction discriminator: sha256("global:<snake_name>")[0..8] */
const ixDiscriminator = (name) => sha256(`global:${name}`).subarray(0, 8);

/** Anchor account discriminator: sha256("account:<StructName>")[0..8] */
const acctDiscriminator = (name) => sha256(`account:${name}`).subarray(0, 8);

const ok = (m) => console.log(`  ✓ ${m}`);
const info = (m) => console.log(`    ${m}`);
const bad = (m) => console.log(`  ✗ ${m}`);

function loadKeypair(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function explorerTx(sig) {
  return `https://explorer.solana.com/tx/${sig}${CLUSTER_QS}`;
}
function explorerAddr(addr) {
  return `https://explorer.solana.com/address/${addr}${CLUSTER_QS}`;
}

/** Pull program logs off whatever shape the error/simulation gives us. */
function extractLogs(e) {
  if (!e) return null;
  if (Array.isArray(e.logs)) return e.logs;
  if (e.value && Array.isArray(e.value.logs)) return e.value.logs;
  if (Array.isArray(e?.transactionLogs)) return e.transactionLogs;
  return null;
}

function printLogs(logs, label = 'program logs') {
  if (!logs || logs.length === 0) {
    info('(no logs returned)');
    return;
  }
  console.log(`    --- ${label} ---`);
  for (const l of logs) console.log(`    | ${l}`);
  console.log('    ---');
}

/**
 * "Already initialized" detection. Anchor's `init` on an existing account
 * surfaces either the system program's "already in use" allocate failure or
 * Anchor's ConstraintSeeds/AccountAlreadyInitialized. We treat any of those as
 * "the account is already there", but only after we independently confirm the
 * account really does exist and is owned by the program.
 */
function looksAlreadyInitialized(errText, logs) {
  const hay = `${errText}\n${(logs || []).join('\n')}`.toLowerCase();
  return hay.includes('already in use') || hay.includes('already initialized');
}

// ---------------------------------------------------------------------------
// Minimal borsh decoders (little-endian, no schema library)
// ---------------------------------------------------------------------------

/**
 * PlatformConfig, per state.rs:
 *   bump: u8, treasury_bump: u8, admin: Pubkey (32), pending_admin: Pubkey (32),
 *   nav_keeper: Pubkey (32), kill_switch: bool, padding: [u8; 128]
 * preceded by the 8-byte Anchor account discriminator.
 */
function decodePlatformConfig(data) {
  const EXPECTED_LEN = 8 + 1 + 1 + 32 + 32 + 32 + 1 + 128; // 235
  if (data.length < EXPECTED_LEN) {
    throw new Error(
      `PlatformConfig too short: ${data.length} bytes, need >= ${EXPECTED_LEN}`,
    );
  }
  let o = 8;
  const bump = data.readUInt8(o); o += 1;
  const treasuryBump = data.readUInt8(o); o += 1;
  const admin = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const pendingAdmin = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const navKeeper = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const killSwitchByte = data.readUInt8(o); o += 1;
  return {
    bump,
    treasuryBump,
    admin,
    pendingAdmin,
    navKeeper,
    killSwitch: killSwitchByte === 1,
    killSwitchRawByte: killSwitchByte,
    declaredLen: data.length,
    expectedLen: EXPECTED_LEN,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const failures = [];
  const fail = (m) => {
    bad(m);
    failures.push(m);
  };

  console.log('='.repeat(72));
  console.log('Trader Vaults on-chain smoke test  (devnet, hand-built instructions, no IDL)');
  console.log('='.repeat(72));

  const connection = new Connection(RPC_URL, 'confirmed');
  const payer = loadKeypair(KEYPAIR_PATH);

  console.log('\n[0] Environment');
  info(`rpc         ${RPC_URL}`);
  info(`payer       ${payer.publicKey.toBase58()}`);
  info(`program     ${PROGRAM_ID.toBase58()}`);

  const balance = await connection.getBalance(payer.publicKey);
  info(`balance     ${(balance / 1e9).toFixed(6)} SOL`);
  if (balance === 0) {
    fail('payer has zero lamports; cannot pay rent + fees');
  }

  // -- program sanity --------------------------------------------------------
  console.log('\n[1] Program account');
  const progInfo = await connection.getAccountInfo(PROGRAM_ID);
  if (!progInfo) {
    fail('program account not found on this cluster');
    return summarize(failures, null);
  }
  ok(`exists, executable=${progInfo.executable}, owner=${progInfo.owner.toBase58()}`);
  if (!progInfo.executable) fail('program account is not executable');
  if (!progInfo.owner.equals(BPF_LOADER_UPGRADEABLE)) {
    fail('program is not owned by BPFLoaderUpgradeable — the ProgramData admin gate cannot work');
  }

  // ProgramData address is a PDA of the upgradeable loader over the program id.
  const [programData] = PublicKey.findProgramAddressSync(
    [PROGRAM_ID.toBytes()],
    BPF_LOADER_UPGRADEABLE,
  );
  ok(`program_data ${programData.toBase58()}`);

  const pdInfo = await connection.getAccountInfo(programData);
  if (!pdInfo) {
    fail('ProgramData account not found');
  } else {
    // UpgradeableLoaderState::ProgramData layout:
    //   u32 enum tag (=3) | u64 slot | Option<Pubkey> upgrade authority
    const tag = pdInfo.data.readUInt32LE(0);
    const slot = pdInfo.data.readBigUInt64LE(4);
    const hasAuthority = pdInfo.data.readUInt8(12) === 1;
    const authority = hasAuthority
      ? new PublicKey(pdInfo.data.subarray(13, 45))
      : null;
    info(`  loader state tag ${tag} (3 = ProgramData), last deployed slot ${slot}`);
    info(`  upgrade authority ${authority ? authority.toBase58() : '<none — immutable>'}`);
    if (!authority) {
      fail('program is immutable: upgrade_authority_address is None, so init_platform can never pass its gate');
    } else if (!authority.equals(payer.publicKey)) {
      fail(
        `payer ${payer.publicKey.toBase58()} is NOT the upgrade authority (${authority.toBase58()}); init_platform will fail Unauthorized`,
      );
    } else {
      ok('payer IS the upgrade authority — ProgramData admin gate should pass');
    }
  }

  // -- PDAs ------------------------------------------------------------------
  console.log('\n[2] PDA derivation (seeds from state.rs)');
  const [platformConfig, platformBump] = PublicKey.findProgramAddressSync(
    [PLATFORM_CONFIG_SEED],
    PROGRAM_ID,
  );
  const [treasury, treasuryBump] = PublicKey.findProgramAddressSync(
    [TREASURY_SEED],
    PROGRAM_ID,
  );
  ok(`platform_config ["platform_config"]  ${platformConfig.toBase58()}  bump=${platformBump}`);
  ok(`treasury        ["treasury"]         ${treasury.toBase58()}  bump=${treasuryBump}`);

  // -- build init_platform ---------------------------------------------------
  console.log('\n[3] Hand-built init_platform instruction');
  // init_platform now takes the dedicated NAV keeper as its one argument.
  // It is deliberately NOT the signer: the key that posts NAV every hour must
  // not be the key that can rewrite the program.
  const navKeeperArg = process.env.NAV_KEEPER
    ? new PublicKey(process.env.NAV_KEEPER)
    : payer.publicKey;
  if (navKeeperArg.equals(payer.publicKey)) {
    console.log(
      '  ! NAV_KEEPER is unset, so the keeper is the upgrade authority. That is ' +
      'the concentration the program was changed to allow you to avoid. ' +
      'Set NAV_KEEPER to a dedicated key before this holds real money.',
    );
  }
  const data = Buffer.concat([ixDiscriminator('init_platform'), navKeeperArg.toBuffer()]);
  ok(`discriminator sha256("global:init_platform")[0..8] = ${data.toString('hex')}`);
  info(`arg: nav_keeper = ${navKeeperArg.toBase58()}`);

  // Order is load-bearing: it must match the field order of InitPlatform in
  // instructions/init_platform.rs exactly.
  //   admin (mut, signer) | platform_config (init, mut) | treasury (init, mut)
  //   | program_data (ro) | program (ro) | system_program (ro)
  const keys = [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },   // admin
    { pubkey: platformConfig, isSigner: false, isWritable: true },   // platform_config (init)
    { pubkey: treasury, isSigner: false, isWritable: true },         // treasury (init)
    { pubkey: programData, isSigner: false, isWritable: false },     // program_data
    { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },      // program (itself)
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  keys.forEach((k, i) => {
    const flags = `${k.isSigner ? 's' : '-'}${k.isWritable ? 'w' : '-'}`;
    info(`  #${i} [${flags}] ${k.pubkey.toBase58()}`);
  });

  const ix = new TransactionInstruction({ programId: PROGRAM_ID, keys, data });

  // -- send ------------------------------------------------------------------
  console.log('\n[4] Send + confirm');
  const existingCfg = await connection.getAccountInfo(platformConfig);
  let signature = null;
  let alreadyInitialized = false;

  if (existingCfg) {
    ok('platform_config already exists on-chain — skipping send (idempotent)');
    alreadyInitialized = true;
  } else {
    // Simulate first so we get logs even when the send path swallows them.
    const simTx = new Transaction().add(ix);
    simTx.feePayer = payer.publicKey;
    simTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    const sim = await connection.simulateTransaction(simTx);
    if (sim.value.err) {
      bad(`simulation failed: ${JSON.stringify(sim.value.err)}`);
      printLogs(sim.value.logs, 'simulation logs');
      if (looksAlreadyInitialized(JSON.stringify(sim.value.err), sim.value.logs)) {
        ok('...but it reads as "already in use" — continuing to verification');
        alreadyInitialized = true;
      } else {
        fail('init_platform simulation failed (see logs above)');
        return summarize(failures, null, { platformConfig, treasury });
      }
    } else {
      ok(`simulation ok, ${sim.value.unitsConsumed ?? '?'} CU`);
      printLogs(sim.value.logs, 'simulation logs');
    }

    if (!alreadyInitialized) {
      try {
        signature = await sendAndConfirmTransaction(
          connection,
          new Transaction().add(ix),
          [payer],
          { commitment: 'confirmed', preflightCommitment: 'confirmed' },
        );
        ok(`init_platform confirmed: ${signature}`);
      } catch (e) {
        const logs = extractLogs(e);
        bad(`send failed: ${e.message}`);
        printLogs(logs, 'program logs');
        if (looksAlreadyInitialized(e.message, logs)) {
          ok('...treating as already-initialized, continuing to verification');
          alreadyInitialized = true;
        } else {
          fail('init_platform transaction failed (see logs above)');
          return summarize(failures, null, { platformConfig, treasury });
        }
      }
    }
  }

  // Pull the confirmed tx back and print its real on-chain logs.
  if (signature) {
    const tx = await connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    if (tx?.meta) {
      info(`  slot ${tx.slot}, fee ${tx.meta.fee} lamports, err=${JSON.stringify(tx.meta.err)}`);
      printLogs(tx.meta.logMessages, 'on-chain logs (getTransaction)');
    }
  }

  // -- verify ----------------------------------------------------------------
  console.log('\n[5] Verify state read back off-chain');

  const cfgInfo = await connection.getAccountInfo(platformConfig);
  if (!cfgInfo) {
    fail('platform_config does not exist after init');
  } else {
    ok(`platform_config exists (${cfgInfo.data.length} bytes, ${cfgInfo.lamports} lamports rent)`);
    if (cfgInfo.owner.equals(PROGRAM_ID)) ok('platform_config owner == program id');
    else fail(`platform_config owner is ${cfgInfo.owner.toBase58()}, expected ${PROGRAM_ID.toBase58()}`);

    const want = acctDiscriminator('PlatformConfig');
    const got = cfgInfo.data.subarray(0, 8);
    if (got.equals(want)) {
      ok(`discriminator matches sha256("account:PlatformConfig")[0..8] = ${want.toString('hex')}`);
    } else {
      fail(`discriminator mismatch: got ${got.toString('hex')}, want ${want.toString('hex')}`);
    }

    try {
      const cfg = decodePlatformConfig(cfgInfo.data);
      console.log('\n    PlatformConfig (borsh-decoded by hand):');
      console.log(`      bump           = ${cfg.bump}   (derived off-chain: ${platformBump})`);
      console.log(`      treasury_bump  = ${cfg.treasuryBump}   (derived off-chain: ${treasuryBump})`);
      console.log(`      admin          = ${cfg.admin.toBase58()}`);
      console.log(`      pending_admin  = ${cfg.pendingAdmin.toBase58()}`);
      console.log(`      nav_keeper     = ${cfg.navKeeper.toBase58()}`);
      console.log(`      kill_switch    = ${cfg.killSwitch}  (raw byte 0x${cfg.killSwitchRawByte.toString(16)})`);
      console.log(`      account size   = ${cfg.declaredLen} bytes (8 disc + 35 data)`);

      if (cfg.bump !== platformBump) fail('stored bump != off-chain derived bump');
      if (cfg.treasuryBump !== treasuryBump) fail('stored treasury_bump != off-chain derived bump');
      if (!cfg.admin.equals(payer.publicKey)) {
        fail(`admin is ${cfg.admin.toBase58()}, expected the upgrade authority ${payer.publicKey.toBase58()}`);
      } else {
        ok('admin == upgrade authority (ProgramData gate wrote the right key)');
      }
      if (cfg.killSwitch !== false) fail('kill_switch should be false at init');
      if (cfg.killSwitchRawByte > 1) fail('kill_switch byte is not a valid bool');
      // The whole point of the keeper split: the key that must be online
      // every hour is not the key that can rewrite the program.
      if (cfg.navKeeper.equals(cfg.admin)) {
        fail('nav_keeper == admin: the always-online key is also the upgrade authority');
      } else {
        ok('nav_keeper != admin (the always-online key holds no other authority)');
      }
    } catch (e) {
      fail(`PlatformConfig decode failed: ${e.message}`);
    }
  }

  console.log('');
  const treInfo = await connection.getAccountInfo(treasury);
  if (!treInfo) {
    fail('treasury does not exist after init');
  } else {
    ok(`treasury exists (${treInfo.data.length} bytes, ${treInfo.lamports} lamports)`);
    if (treInfo.owner.equals(PROGRAM_ID)) ok('treasury owner == program id');
    else fail(`treasury owner is ${treInfo.owner.toBase58()}, expected ${PROGRAM_ID.toBase58()}`);

    const want = acctDiscriminator('Treasury');
    const got = treInfo.data.subarray(0, 8);
    if (got.equals(want)) {
      ok(`discriminator matches sha256("account:Treasury")[0..8] = ${want.toString('hex')}`);
    } else {
      fail(`discriminator mismatch: got ${got.toString('hex')}, want ${want.toString('hex')}`);
    }
    if (treInfo.data.length !== 8) {
      info(`  note: Treasury is discriminator-only, expected 8 bytes, got ${treInfo.data.length}`);
    }
  }

  return summarize(failures, signature, { platformConfig, treasury, alreadyInitialized });
}

function summarize(failures, signature, ctx = {}) {
  console.log('\n' + '='.repeat(72));
  if (failures.length === 0) {
    console.log('RESULT: PASS — the deployed program executed and its state reads back clean.');
  } else {
    console.log(`RESULT: FAIL — ${failures.length} problem(s):`);
    for (const f of failures) console.log(`  - ${f}`);
  }
  if (signature) {
    console.log(`\n  tx signature : ${signature}`);
    console.log(`  explorer     : ${explorerTx(signature)}`);
  } else if (ctx.alreadyInitialized) {
    console.log('\n  tx signature : (none this run — platform was already initialized)');
  }
  if (ctx.platformConfig) {
    console.log(`  platform_cfg : ${explorerAddr(ctx.platformConfig.toBase58())}`);
  }
  if (ctx.treasury) {
    console.log(`  treasury     : ${explorerAddr(ctx.treasury.toBase58())}`);
  }
  console.log('='.repeat(72));
  process.exitCode = failures.length === 0 ? 0 : 1;
  return failures.length === 0;
}

main().catch((e) => {
  console.error('\nUNCAUGHT:', e);
  const logs = extractLogs(e);
  if (logs) printLogs(logs, 'program logs');
  process.exitCode = 1;
});
