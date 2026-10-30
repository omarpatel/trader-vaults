// ── real-vault on-chain operations ─────────────────────────────────
// Orchestration on top of program.ts (what to send) + signer.ts (how to
// send it). Routes call these; nothing here touches the demo ledger.
//
// A "real" vault is an on-chain object. Its DB row is an INDEX of that
// object (name, thesis, who created it) plus the PDA and the init
// signature — never a second source of truth for money. Nothing in this
// file writes tvlSol / totalShares / sharePriceSol: those columns carry
// paper-ledger semantics (SOL per share, ~1.0) and the chain's units are
// different by a factor of 1e12 (VIRTUAL_SHARES × lamports), so copying
// one into the other would put a fabricated number on screen. Callers
// that want a real vault's true state read it back with
// `readOnChainVault`.

import type { Keypair } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import {
  MIN_SEED_LAMPORTS,
  buildDepositIx,
  buildInitDepositorIx,
  buildInitVaultIx,
  explorerAddress,
  explorerTx,
  fetchPlatformConfigAccount,
  fetchVaultAccount,
  fetchVaultDepositorAccount,
  platformConfigPda,
  sharesForDeposit,
  type FetchedVault,
  type FetchedVaultDepositor,
  vaultAccountToJson,
  vaultDepositorPda,
  vaultDepositorToJson,
} from "./program.js";
import { getConnection, getServerKeypair, sendAndConfirm } from "./signer.js";

/** Vault params the platform pins for every vault it creates on-chain. */
export const PLATFORM_VAULT_DEFAULTS = {
  /** deposits/withdrawals gate on a mark newer than this */
  navStalenessSeconds: 3_600n,
  /** NAV gains drip into the share price over an hour (anti-sandwich) */
  unlockPeriodSeconds: 3_600n,
  /** max |NAV move| the keeper may post at once, bps of previous NAV */
  maxNavDeltaBps: 2_000,
  /** advisory quote bound for the off-chain engine */
  maxPriceImpactBps: 300,
  /** daily NAV-loss circuit breaker (freezes TRADING only) */
  dailyLossLimitBps: 2_000,
  /**
   * Per-trade wSOL notional cap: 1,000 SOL.
   *
   * This was u64::MAX - "uncapped" - on every vault the platform created,
   * which made the cap a field the UI could show and nothing else. The
   * program now rejects u64::MAX outright.
   */
  maxTradeNotionalLamports: 1_000_000_000_000n,
} as const;

export interface InitVaultOnChainInput {
  /** DB row id — becomes the 32-byte on-chain name, hence the PDA seed. */
  id: string;
  type: "managed" | "mirror";
  perfFeeBps: number;
  redeemWindowHours: number;
  /** Defaults to MIN_SEED_LAMPORTS (0.01 SOL), burned forever. */
  seedLamports?: bigint;
}

export interface InitVaultOnChainResult {
  vaultPda: string;
  signature: string;
  explorerTx: string;
  explorerAddress: string;
  seedLamports: string;
  slot: number | null;
  feeLamports: number | null;
}

/**
 * Create the vault on the deployed program. The SERVER key is the creator
 * (and therefore the on-chain trader) and the NAV keeper — on devnet the
 * platform runs both roles. Idempotent: if the PDA already exists it is
 * returned instead of re-sent, so a retried request cannot burn a second
 * seed deposit.
 */
export async function initVaultOnChain(
  input: InitVaultOnChainInput,
): Promise<InitVaultOnChainResult> {
  const server = getServerKeypair();
  const seedLamports = input.seedLamports ?? MIN_SEED_LAMPORTS;

  const [platformConfigPdaKey] = platformConfigPda();
  const platformConfig = await fetchPlatformConfigAccount(getConnection(), platformConfigPdaKey);
  if (!platformConfig) {
    throw new Error(
      `platform config ${platformConfigPdaKey.toBase58()} does not exist — run init_platform ` +
        "before creating vaults (scripts/onchain-smoke.mjs)",
    );
  }
  const platformNavKeeper = platformConfig.navKeeper;

  const { ix, vault } = buildInitVaultIx({
    creator: server.publicKey,
    vault: {
      name: input.id,
      vaultType: input.type === "mirror" ? "Mirror" : "Managed",
      perfFeeBps: input.perfFeeBps,
      redeemWindowSeconds: BigInt(Math.round(input.redeemWindowHours * 3600)),
      navStalenessSeconds: PLATFORM_VAULT_DEFAULTS.navStalenessSeconds,
      unlockPeriodSeconds: PLATFORM_VAULT_DEFAULTS.unlockPeriodSeconds,
      maxNavDeltaBps: PLATFORM_VAULT_DEFAULTS.maxNavDeltaBps,
      maxTradeNotionalLamports: PLATFORM_VAULT_DEFAULTS.maxTradeNotionalLamports,
      maxPriceImpactBps: PLATFORM_VAULT_DEFAULTS.maxPriceImpactBps,
      dailyLossLimitBps: PLATFORM_VAULT_DEFAULTS.dailyLossLimitBps,
      // Read from the chain, never from a local key.
      //
      // This was `server.publicKey`, and init_vault now requires
      // `params.nav_keeper == platform_config.nav_keeper`. The keeper is a
      // DEDICATED key, distinct from the server/admin key by design (it has
      // to be online hourly, so it must not also be the upgrade authority), so
      // every vault creation reverted Unauthorized — and vaults.ts deletes the
      // row and answers 502 when that happens. No vault could be created at
      // all, and the migration for the existing ones would have failed 26
      // times in a row.
      //
      // Deliberately NOT getNavKeeperKeypair().publicKey: signer.ts falls back
      // to the server key when NAV_KEEPER_KEYPAIR_JSON is unset, which would
      // silently reintroduce exactly this mismatch.
      navKeeper: platformNavKeeper,
      seedLamports,
    },
  });

  const existing = await fetchVaultAccount(getConnection(), vault);
  if (existing) {
    return {
      vaultPda: vault.toBase58(),
      signature: "",
      explorerTx: "",
      explorerAddress: explorerAddress(vault.toBase58()),
      seedLamports: seedLamports.toString(),
      slot: null,
      feeLamports: null,
    };
  }

  const sent = await sendAndConfirm([ix], [], { label: `init_vault(${input.id})` });
  return {
    vaultPda: vault.toBase58(),
    signature: sent.signature,
    explorerTx: explorerTx(sent.signature),
    explorerAddress: explorerAddress(vault.toBase58()),
    seedLamports: seedLamports.toString(),
    slot: sent.slot,
    feeLamports: sent.feeLamports,
  };
}

export interface DepositOnChainResult {
  signature: string;
  explorerTx: string;
  initDepositor: boolean;
  depositorPda: string;
  amountLamports: string;
  /** Shares the chain actually minted (after − before), as a decimal string. */
  sharesMinted: string;
  /** What math.rs says should have been minted — the two must agree. */
  sharesExpected: string;
  before: { vault: Record<string, unknown>; depositor: Record<string, unknown> | null };
  after: { vault: Record<string, unknown>; depositor: Record<string, unknown> };
}

/**
 * Deposit into a real vault, signing with `depositor` (defaults to the
 * SERVER keypair).
 *
 * ⚠ SERVER-SIGNED DEPOSITS ARE A DEVNET PROOF ONLY. The depositor of
 * record is whoever signs — so with the default keypair the shares belong
 * to the PLATFORM's key, not to any user. A USER deposit must be signed by
 * the USER's wallet (Privy embedded wallet / session signer); that is a
 * separate task, and the only change required here is passing that
 * signature in instead of `getServerKeypair()` — the instructions this
 * function builds are already exactly the ones a user would sign.
 *
 * init_depositor is prepended in the SAME transaction when the record does
 * not exist yet: one signature, one fee, and no window where the record
 * exists but the deposit did not land.
 */
export async function depositOnChain(params: {
  vaultPda: PublicKey | string;
  amountLamports: bigint;
  depositor?: Keypair;
}): Promise<DepositOnChainResult> {
  const connection = getConnection();
  const vault = typeof params.vaultPda === "string" ? new PublicKey(params.vaultPda) : params.vaultPda;
  const signer = params.depositor ?? getServerKeypair();

  const before = await fetchVaultAccount(connection, vault);
  if (!before) throw new Error(`vault ${vault.toBase58()} does not exist on-chain`);

  const [depositorPda] = vaultDepositorPda(vault, signer.publicKey);
  const beforeDepositor = await fetchVaultDepositorAccount(connection, depositorPda);

  const ixs = [];
  if (!beforeDepositor) {
    ixs.push(buildInitDepositorIx({ authority: signer.publicKey, vault }).ix);
  }
  ixs.push(
    buildDepositIx({
      authority: signer.publicKey,
      vault,
      amountLamports: params.amountLamports,
    }).ix,
  );

  // Predict the mint from the pre-state, using the same formula the
  // program uses, so a silent interface drift shows up as a mismatch
  // instead of a plausible number.
  //
  // EXACT only when no profit is still locked. Pricing equity is
  // `nav − locked_profit_now`, and the lock drips against the ON-CHAIN
  // clock, so while a NAV gain is unlocking the mint depends on the exact
  // second the transaction executes — unknowable at build time. Treat
  // `sharesExpected` as a sanity bound in that case (it tracks
  // `sharesMinted` to ~1e-5), never as an authority: `sharesMinted` is
  // read back from the chain and is the truth.
  // Priced at FULL NAV, matching deposit.rs. It used to use effective_equity,
  // which is what WITHDRAWALS price against — a deliberate asymmetry that made
  // this prediction too high whenever any profit was still locked.
  const sharesExpected = sharesForDeposit(
    params.amountLamports,
    before.data.totalShares,
    before.data.navLamports,
  );

  // `payer: signer` makes the depositor the fee payer AND the only
  // signature required — sendAndConfirm signs with the payer first, so no
  // extra signer entry is needed (a duplicate would be deduped anyway).
  const sent = await sendAndConfirm(ixs, [], {
    label: `deposit(${vault.toBase58().slice(0, 8)}…)`,
    payer: signer,
  });

  const after = await fetchVaultAccount(connection, vault);
  const afterDepositor = await fetchVaultDepositorAccount(connection, depositorPda);
  if (!after || !afterDepositor) {
    throw new Error("deposit landed but the accounts could not be read back");
  }

  return {
    signature: sent.signature,
    explorerTx: explorerTx(sent.signature),
    initDepositor: !beforeDepositor,
    depositorPda: depositorPda.toBase58(),
    amountLamports: params.amountLamports.toString(),
    sharesMinted: (
      afterDepositor.data.shares - (beforeDepositor?.data.shares ?? 0n)
    ).toString(),
    sharesExpected: sharesExpected.toString(),
    before: {
      vault: vaultAccountToJson(before.data, before.lamports),
      depositor: beforeDepositor
        ? vaultDepositorToJson(beforeDepositor.data, beforeDepositor.lamports)
        : null,
    },
    after: {
      vault: vaultAccountToJson(after.data, after.lamports),
      depositor: vaultDepositorToJson(afterDepositor.data, afterDepositor.lamports),
    },
  };
}

export interface OnChainVaultView {
  vaultPda: string;
  explorerAddress: string;
  vault: Record<string, unknown>;
  /** Present only when `authority` was supplied and the record exists. */
  depositor: Record<string, unknown> | null;
}

/** Read + decode the live on-chain state of a vault (and one depositor). */
export async function readOnChainVault(
  vaultPda: PublicKey | string,
  authority?: PublicKey | string,
): Promise<OnChainVaultView | null> {
  const connection = getConnection();
  const vault = typeof vaultPda === "string" ? new PublicKey(vaultPda) : vaultPda;
  const fetched: FetchedVault | null = await fetchVaultAccount(connection, vault);
  if (!fetched) return null;

  let depositor: FetchedVaultDepositor | null = null;
  if (authority) {
    const auth = typeof authority === "string" ? new PublicKey(authority) : authority;
    const [pda] = vaultDepositorPda(vault, auth);
    depositor = await fetchVaultDepositorAccount(connection, pda);
  }

  return {
    vaultPda: vault.toBase58(),
    explorerAddress: explorerAddress(vault.toBase58()),
    vault: vaultAccountToJson(fetched.data, fetched.lamports),
    depositor: depositor ? vaultDepositorToJson(depositor.data, depositor.lamports) : null,
  };
}
