// Seed on-chain vaults with devnet SOL so they have real TVL and can trade.
//
// The pump.fun creator fees are MAINNET SOL and the vaults are DEVNET
// accounts — two separate chains, no transaction moves value between them.
// So this does not touch those fees. It funds the devnet vaults with devnet
// SOL, which is free, and gets the platform to a state where deposits,
// share math and trading are exercised against real on-chain accounts.
//
// Usage:  node scripts/seed-vaults.mjs [solPerVault]
//
// NOTE on how a donation reaches depositors: it does not, on its own. A plain
// transfer raises the PDA's lamports without minting shares and without
// moving nav_lamports, so nothing prices it. What makes it land is post_nav's
// lamport floor: the keeper can no longer post a mark BELOW the vault's own
// unencumbered balance, so the next mark has to recognise the donation, and
// at that point every existing share is worth more. Seed, then wait for a
// mark.

import { readFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";

const SOL_PER_VAULT = Number(process.argv[2] ?? 0.05);
const LAMPORTS = BigInt(Math.round(SOL_PER_VAULT * 1e9));

function env(name, fallback = "") {
  const raw = readFileSync(".env", "utf8");
  const m = raw.match(new RegExp(`^${name}="?([^"\\r\\n]*)"?`, "m"));
  return m ? m[1] : fallback;
}

const RPC = `https://devnet.helius-rpc.com/?api-key=${env("HELIUS_API_KEY")}`;
const conn = new Connection(RPC, "confirmed");

const kp = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(".keys/server-authority.json", "utf8"))),
);
console.log(`funder: ${kp.publicKey.toBase58()}`);

const bal = await conn.getBalance(kp.publicKey);
console.log(`balance: ${(bal / 1e9).toFixed(4)} SOL`);

// Which vaults actually exist on chain? The API does not expose the PDA, so
// ask the program directly: every account it owns of the Vault size.
const PROGRAM = new PublicKey("HWssGCcxUdiqeEiWk3CRxuSJy6eb4aZH7g2ubo7w6Sqc");
// 8-byte discriminator + Vault::INIT_SPACE. Printed by the program's own
// `print_account_sizes` test; update both together.
const VAULT_ACCOUNT_SIZE = 1095;
const accounts = await conn.getProgramAccounts(PROGRAM, {
  filters: [{ dataSize: VAULT_ACCOUNT_SIZE }],
});
console.log(`on-chain vaults found: ${accounts.length}`);

if (accounts.length === 0) {
  console.log("nothing to seed");
  process.exit(0);
}

const needed = accounts.length * SOL_PER_VAULT + 0.05;
if (bal / 1e9 < needed) {
  console.log(
    `need ~${needed.toFixed(3)} SOL to seed ${accounts.length} vaults, have ${(bal / 1e9).toFixed(3)}.`,
  );
  console.log("airdrop more devnet SOL first, or lower solPerVault.");
  process.exit(1);
}

// A plain transfer into the vault PDA raises its lamports without minting
// shares. That is deliberate: minting shares to the funder would make the
// platform a depositor with a claim on the vault, which is the opposite of
// "funding". This is a donation to the vault's balance.
let ok = 0;
for (const { pubkey } of accounts) {
  try {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: kp.publicKey,
        toPubkey: pubkey,
        lamports: Number(LAMPORTS),
      }),
    );
    const sig = await conn.sendTransaction(tx, [kp], { skipPreflight: false });
    await conn.confirmTransaction(sig, "confirmed");
    console.log(`  ${pubkey.toBase58()}  +${SOL_PER_VAULT} SOL  ${sig.slice(0, 20)}…`);
    ok++;
  } catch (e) {
    console.log(`  ${pubkey.toBase58()}  FAILED: ${String(e).slice(0, 120)}`);
  }
}
console.log(`\nseeded ${ok}/${accounts.length} vaults with ${SOL_PER_VAULT} SOL each`);
