#!/usr/bin/env node
/**
 * Reclaim the SOL this key put into vaults while testing.
 *
 * Withdraws the server key's OWN depositor positions, closes the emptied
 * depositor records to get their rent back, and unwraps any leftover wSOL
 * float. Nothing else — see the exclusions below.
 *
 * WHAT IT WILL NOT TOUCH, and why:
 *
 *   · Vaults this key does not hold a position in. A vault created by
 *     somebody else is somebody else's, and its seed and rent are theirs.
 *   · Seed shares. MIN_SEED_LAMPORTS is minted to NOBODY and is permanently
 *     unredeemable by design — that is the whole point of it, it is what
 *     stops the share price being reset by emptying a vault. 0.01 SOL per
 *     vault created is gone and no instruction anywhere can return it.
 *   · The six vaults created under the OLD PDA seeds. This build cannot
 *     derive their addresses, so no instruction can name them. Their 0.0924
 *     SOL is stranded permanently.
 *   · The v1 PlatformConfig and Treasury, orphaned by the same seed bump.
 *
 * Usage:
 *   npx tsx scripts/reclaim-test-sol.mjs            # dry run
 *   npx tsx scripts/reclaim-test-sol.mjs --apply
 */
import { PublicKey } from "@solana/web3.js";

import {
  buildCloseDepositorIx,
  buildInstantWithdrawIx,
  buildPostNavIx,
  buildUnwrapSolIx,
  effectiveEquity,
  fetchVaultAccount,
  fetchVaultDepositorAccount,
  valueForShares,
  vaultDepositorPda,
  vaultTokenAccount,
  VAULT_PROGRAM_ID,
  WSOL_MINT,
} from "../apps/api/src/services/program.js";
import {
  getConfirmedSlot,
  getConnection,
  getLamports,
  getNavKeeperKeypair,
  getServerKeypair,
  sendAndConfirm,
} from "../apps/api/src/services/signer.js";

const APPLY = process.argv.includes("--apply");
const conn = getConnection();
const me = getServerKeypair();

console.log("=".repeat(72));
console.log("Reclaim test SOL");
console.log("=".repeat(72));
console.log(`  key   ${me.publicKey.toBase58()}`);
console.log(`  mode  ${APPLY ? "APPLY" : "DRY RUN"}`);
const startBalance = await getLamports(me.publicKey);
console.log(`  start ${(Number(startBalance) / 1e9).toFixed(6)} SOL\n`);

// Every CURRENT-layout vault. The old-layout ones are undecodable and
// unreachable; they are reported at the end rather than skipped silently.
const vaults = await conn.getProgramAccounts(VAULT_PROGRAM_ID, {
  filters: [{ dataSize: 1095 }],
});

const plan = [];
for (const v of vaults) {
  const vault = await fetchVaultAccount(conn, v.pubkey);
  if (!vault) continue;
  const [dp] = vaultDepositorPda(v.pubkey, me.publicKey);
  const dep = await fetchVaultDepositorAccount(conn, dp);
  if (!dep) continue;

  const now = BigInt(Math.floor(Date.now() / 1000));
  const equity = effectiveEquity(vault.data, now);
  const value =
    dep.data.shares > 0n
      ? valueForShares(dep.data.shares, vault.data.totalShares, equity)
      : 0n;
  plan.push({ vault: v.pubkey, data: vault.data, lamports: v.account.lamports, dep, dp, value });
}

if (plan.length === 0) {
  console.log("  no positions held by this key");
} else {
  for (const p of plan) {
    const name = Buffer.from(p.data.nameBytes).toString("utf8").replace(/\0+$/, "");
    console.log(`  ${p.vault.toBase58()}  ${JSON.stringify(name)}`);
    console.log(
      `    shares ${p.dep.data.shares}  worth ${(Number(p.value) / 1e9).toFixed(6)} SOL` +
        `  (record rent ${(p.dep.lamports / 1e9).toFixed(6)})`,
    );
  }
}
const recoverable = plan.reduce((s, p) => s + Number(p.value) + p.dep.lamports, 0);
console.log(`\n  recoverable: ~${(recoverable / 1e9).toFixed(6)} SOL\n`);

if (!APPLY) {
  console.log("Dry run. Re-run with --apply.");
  process.exit(0);
}

const keeper = getNavKeeperKeypair();
let reclaimed = 0;

for (const p of plan) {
  const label = p.vault.toBase58().slice(0, 8);
  try {
    if (p.dep.data.shares > 0n) {
      // Instant withdrawal needs a mark under 300s old. These vaults are test
      // vaults the keeper loop may not cover, so refresh it here — FLAT, which
      // is the only honest re-post: the lamport floor refuses a mark below the
      // vault's own cash, and nothing about the book has changed.
      const slot = await getConfirmedSlot();
      if (slot > p.data.navSlot) {
        // Mark at least the vault's own unencumbered cash.
        //
        // A flat re-post is refused NavBelowLamports when the vault holds more
        // lamports than its mark — which happens legitimately here: closing a
        // wSOL account returns its rent to the vault, and that SOL backs
        // nobody's shares until a mark recognises it. Posting the floor is the
        // honest number, and the surplus becomes locked profit that drips into
        // the share price rather than being handed to whoever exits first.
        const rentMin = BigInt(await conn.getMinimumBalanceForRentExemption(1095));
        const floor =
          BigInt(p.lamports) > rentMin + p.data.platformFeesOwedLamports
            ? BigInt(p.lamports) - rentMin - p.data.platformFeesOwedLamports
            : 0n;
        const mark = p.data.navLamports > floor ? p.data.navLamports : floor;
        await sendAndConfirm(
          [
            buildPostNavIx({
              vault: p.vault,
              keeper: keeper.publicKey,
              navLamports: mark,
              markSlot: slot,
            }),
          ],
          [keeper],
          { label: `post_nav(${label})` },
        );
        if (mark !== p.data.navLamports) {
          console.log(
            `  marked ${label} up to its lamport floor: ${p.data.navLamports} -> ${mark}`,
          );
        }
      }

      const fresh = await fetchVaultDepositorAccount(conn, p.dp);
      const before = await getLamports(me.publicKey);
      const sent = await sendAndConfirm(
        [
          buildInstantWithdrawIx({
            authority: me.publicKey,
            vault: p.vault,
            trader: p.data.trader,
            shares: fresh.data.shares,
          }).ix,
        ],
        [],
        { label: `instant_withdraw(${label})` },
      );
      const after = await getLamports(me.publicKey);
      const got = after - before + BigInt(sent.feeLamports ?? 5000);
      reclaimed += Number(got);
      console.log(`  withdrew ${(Number(got) / 1e9).toFixed(6)} SOL from ${label}  ${sent.signature.slice(0, 20)}…`);
    }

    // Rent back on the emptied record.
    const before = await getLamports(me.publicKey);
    const sent = await sendAndConfirm(
      [buildCloseDepositorIx({ authority: me.publicKey, vault: p.vault }).ix],
      [],
      { label: `close_depositor(${label})` },
    );
    const after = await getLamports(me.publicKey);
    const got = after - before + BigInt(sent.feeLamports ?? 5000);
    reclaimed += Number(got);
    console.log(`  closed record, +${(Number(got) / 1e9).toFixed(6)} SOL  ${sent.signature.slice(0, 20)}…`);
  } catch (e) {
    console.log(`  FAILED on ${label}: ${String(e?.message ?? e).slice(0, 200)}`);
    for (const l of e?.logs ?? []) console.log(`      | ${l}`);
  }

  // Any wSOL float left in the vault belongs to the vault, not to us — but
  // returning it to the vault PDA is still the right hygiene, since a float
  // sitting in wSOL backs NAV without being able to pay a withdrawal.
  const ata = vaultTokenAccount(p.vault, WSOL_MINT);
  const info = await conn.getAccountInfo(ata);
  if (info) {
    try {
      await sendAndConfirm(
        [buildUnwrapSolIx({ authority: me.publicKey, vault: p.vault }).ix],
        [],
        { label: `unwrap_sol(${label})` },
      );
      console.log(`  returned the wSOL float on ${label} to the vault`);
    } catch {
      /* not the trade authority on that vault; leave it alone */
    }
  }
}

const end = await getLamports(me.publicKey);
console.log(`\n  balance ${(Number(startBalance) / 1e9).toFixed(6)} -> ${(Number(end) / 1e9).toFixed(6)} SOL`);
console.log(`  net +${(Number(end - startBalance) / 1e9).toFixed(6)} SOL`);
