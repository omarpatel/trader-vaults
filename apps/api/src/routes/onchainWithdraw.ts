// ── USER-SIGNED on-chain WITHDRAWALS ───────────────────────────────
//
// The mirror of onchain.ts's deposit routes, and it did not exist. The API
// could build a deposit and nothing else: `program.ts` had no withdrawal
// instruction builders at all, `withdrawals.ts` only settles PAPER vaults, and
// no route anywhere produced a withdrawal transaction for a real vault. A
// depositor's only exit was a raw RPC client and a hand-encoded instruction.
//
// A vault you can pay into and not out of is not a vault. Deposits must not be
// reopened until this is here, which is why it is here.
//
// THE ONE RULE THIS FILE FOLLOWS: nothing in it may ever gate an exit on
// something the platform controls.
//   · No DEPOSITS_OPEN check. That switch protects people from putting money
//     IN. Applying it to withdrawals would trap the money already in, which is
//     the exact opposite of what it is for.
//   · No VaultStatus check, no kill-switch check. The program deliberately
//     reads neither on any withdrawal path; so does this.
//   · The preflight below REFUSES to build transactions that would revert, but
//     `emergency` is exempt from the buffer check the way the program exempts
//     it — that path exists precisely for when everything else is stuck.
//
// Four actions, all user-signed:
//   request   -> start the redeem window (reserves the value)
//   cancel    -> release the reservation, keep the shares (never NAV-gated)
//   execute   -> settle a matured request, priced at execution
//   instant   -> skip the window when free SOL covers it (tight staleness
//                bound + a hold since the depositor's last deposit)
//   emergency -> the permissionless hatch: keeper silent for a week, or this
//                depositor's own request stuck past its window + grace

import { Router } from "express";
import { PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

import { prisma } from "../db.js";
import { env } from "../env.js";
import {
  buildCancelWithdrawRequestIx,
  buildEmergencyWithdrawIx,
  buildExecuteWithdrawIx,
  buildInstantWithdrawIx,
  buildRequestWithdrawIx,
  StaleVaultLayoutError,
  VAULT_ACCOUNT_BYTES,
  VAULT_PROGRAM_ID,
  effectiveEquity,
  fetchVaultAccount,
  fetchVaultDepositorAccount,
  vaultDepositorPda,
  valueForShares,
} from "../services/program.js";
import { getConnection } from "../services/signer.js";
import { requirePrivyUser } from "../services/privyAuth.js";
import { respondAuthError } from "./onchain.js";

export const onchainWithdrawRouter = Router();

// Mirrors state.rs. Kept here rather than imported from the program so the
// numbers a user is shown and the numbers the program enforces are visibly
// the same numbers in review.
const INSTANT_WITHDRAW_MAX_NAV_STALENESS_SECONDS = 300;
const MIN_DEPOSIT_HOLD_SECONDS = 3_600;
const NAV_EMERGENCY_GRACE_SECONDS = 7 * 86_400;
const WITHDRAW_REQUEST_GRACE_SECONDS = 14 * 86_400;
const EMERGENCY_PAYOUT_BPS = 9_500n;

const ACTIONS = ["request", "cancel", "execute", "instant", "emergency"] as const;
type Action = (typeof ACTIONS)[number];

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function lamportsToSol(l: bigint): number {
  return Number(l) / 1e9;
}

interface Loaded {
  vaultId: string;
  vaultPda: PublicKey;
  traderWallet: PublicKey;
  vault: NonNullable<Awaited<ReturnType<typeof fetchVaultAccount>>>;
}

/**
 * Resolve the vault and its live on-chain account.
 *
 * Deliberately NOT gated on vault status: a frozen or closed vault must still
 * be withdrawable, and the program agrees.
 */
async function loadVault(
  res: import("express").Response,
  vaultId: unknown,
): Promise<Loaded | null> {
  if (typeof vaultId !== "string" || vaultId.length === 0) {
    res.status(400).json({ error: "vaultId is required" });
    return null;
  }
  const row = await prisma.vault.findUnique({ where: { id: vaultId } });
  if (!row) {
    res.status(404).json({ error: "vault not found" });
    return null;
  }
  if (row.mode !== "real") {
    res.status(409).json({
      error: "this route is on-chain only; paper vaults use /api/vaults/:id/withdraw",
      code: "not_a_real_vault",
    });
    return null;
  }
  if (!row.onchainVaultPda) {
    res.status(409).json({
      error: "vault has no on-chain account",
      code: "no_onchain_account",
    });
    return null;
  }

  const vaultPda = new PublicKey(row.onchainVaultPda);
  let vault;
  try {
    vault = await fetchVaultAccount(getConnection(), vaultPda);
  } catch (e) {
    if (e instanceof StaleVaultLayoutError) {
      res.status(409).json({
        error:
          "this vault's on-chain account was written by an older program layout " +
          "and cannot be read. It holds no depositor funds. Contact support.",
        code: "stale_vault_layout",
        vaultPda: row.onchainVaultPda,
      });
      return null;
    }
    throw e;
  }
  if (!vault) {
    res.status(502).json({
      error: "on-chain vault account not found",
      code: "vault_missing_onchain",
      vaultPda: row.onchainVaultPda,
    });
    return null;
  }

  return {
    vaultId: row.id,
    vaultPda,
    traderWallet: vault.data.trader,
    vault,
  };
}

/**
 * Everything the caller needs to know about their own exit, right now.
 *
 * The point of this endpoint is that a depositor should never discover a gate
 * by having a signed transaction revert. Every reason a withdrawal could fail
 * is computed here and named, before anyone signs anything.
 */
onchainWithdrawRouter.get("/quote", async (req, res, next) => {
  try {
    const { identity } = await requirePrivyUser(req);
    const loaded = await loadVault(res, req.query.vaultId);
    if (!loaded) return;

    const connection = getConnection();
    const authority = new PublicKey(identity.wallet);
    const [depositorPda] = vaultDepositorPda(loaded.vaultPda, authority);
    const depositor = await fetchVaultDepositorAccount(connection, depositorPda);

    const v = loaded.vault.data;
    const now = nowSec();
    const navAge = now - Number(v.navPostedAt);
    const shares = depositor?.data.shares ?? 0n;
    const req_ = depositor?.data.lastWithdrawRequest;
    const hasRequest = (req_?.shares ?? 0n) > 0n;

    // Effective equity, computed by the SAME helper the deposit path uses:
    // posted NAV less whatever locked profit has not yet dripped in. Rolling
    // a second copy of the drip here is how the two sides drift apart.
    const equity = effectiveEquity(v, BigInt(now));
    const currentValue = shares > 0n ? valueForShares(shares, v.totalShares, equity) : 0n;

    // The vault's spendable lamports, mirroring Vault::free_sol.
    const rentMin = BigInt(
      await connection.getMinimumBalanceForRentExemption(VAULT_ACCOUNT_BYTES),
    );
    const pendingReserve =
      v.pendingWithdrawShares > 0n
        ? (() => {
            const marked = valueForShares(v.pendingWithdrawShares, v.totalShares, equity);
            return marked < v.pendingWithdrawValueLamports
              ? marked
              : v.pendingWithdrawValueLamports;
          })()
        : 0n;
    const vaultLamports = BigInt(loaded.vault.lamports);
    const unreserved =
      vaultLamports > rentMin + v.platformFeesOwedLamports
        ? vaultLamports - rentMin - v.platformFeesOwedLamports
        : 0n;
    const freeSol = unreserved > pendingReserve ? unreserved - pendingReserve : 0n;

    // ── why each action would or would not work ──────────────────────
    const holdRemaining = depositor
      ? Math.max(0, MIN_DEPOSIT_HOLD_SECONDS - (now - Number(depositor.data.lastDepositTs)))
      : 0;

    const instantBlockers: string[] = [];
    if (shares <= 0n) instantBlockers.push("you hold no shares in this vault");
    if (hasRequest) instantBlockers.push("cancel your pending withdrawal request first");
    if (navAge > Number(v.navStalenessSeconds))
      instantBlockers.push(`the vault's mark is stale (${navAge}s old)`);
    if (navAge > INSTANT_WITHDRAW_MAX_NAV_STALENESS_SECONDS)
      instantBlockers.push(
        `instant withdrawals need a mark under ${INSTANT_WITHDRAW_MAX_NAV_STALENESS_SECONDS}s old; this one is ${navAge}s`,
      );
    if (holdRemaining > 0)
      instantBlockers.push(
        `instant withdrawal opens ${Math.ceil(holdRemaining / 60)} min after your last deposit`,
      );
    if (currentValue > freeSol)
      instantBlockers.push(
        `the vault's spendable SOL (${lamportsToSol(freeSol).toFixed(6)}) does not cover ${lamportsToSol(currentValue).toFixed(6)}`,
      );

    const requestBlockers: string[] = [];
    if (shares <= 0n) requestBlockers.push("you hold no shares in this vault");
    if (hasRequest) requestBlockers.push("you already have a pending request");
    if (navAge > Number(v.navStalenessSeconds))
      requestBlockers.push(`the vault's mark is stale (${navAge}s old)`);

    const windowEndsAt = hasRequest
      ? Number(req_!.requestedAt) + Number(v.redeemWindowSeconds)
      : null;
    const executeBlockers: string[] = [];
    if (!hasRequest) executeBlockers.push("no pending request");
    else {
      if (now < windowEndsAt!)
        executeBlockers.push(
          `redeem window ends in ${Math.ceil((windowEndsAt! - now) / 60)} min`,
        );
      if (navAge > Number(v.navStalenessSeconds))
        executeBlockers.push(`the vault's mark is stale (${navAge}s old)`);
    }

    const stuckSince = hasRequest
      ? Number(req_!.requestedAt) +
        Number(v.redeemWindowSeconds) +
        WITHDRAW_REQUEST_GRACE_SECONDS
      : null;
    const emergencyOpen =
      navAge >= NAV_EMERGENCY_GRACE_SECONDS || (stuckSince !== null && now >= stuckSince);

    res.json({
      vaultId: loaded.vaultId,
      vaultPda: loaded.vaultPda.toBase58(),
      wallet: identity.wallet,
      depositorPda: depositorPda.toBase58(),
      shares: shares.toString(),
      currentValueLamports: currentValue.toString(),
      currentValueSol: lamportsToSol(currentValue),
      netDepositsLamports: (depositor?.data.netDepositsLamports ?? 0n).toString(),
      perfFeeBps: v.perfFeeBps,
      // The platform takes nothing. Stated explicitly because the UI used to
      // quote a 10% cut the program never charged.
      platformFeeBps: 0,
      vault: {
        navLamports: v.navLamports.toString(),
        equityLamports: equity.toString(),
        totalShares: v.totalShares.toString(),
        navAgeSeconds: navAge,
        navStalenessSeconds: Number(v.navStalenessSeconds),
        redeemWindowSeconds: Number(v.redeemWindowSeconds),
        freeSolLamports: freeSol.toString(),
        freeSolSol: lamportsToSol(freeSol),
        status: v.status,
      },
      pendingRequest: hasRequest
        ? {
            shares: req_!.shares.toString(),
            valueAtRequestLamports: req_!.valueAtRequestLamports.toString(),
            requestedAt: Number(req_!.requestedAt),
            windowEndsAt,
            executableIn: Math.max(0, windowEndsAt! - now),
          }
        : null,
      actions: {
        request: { available: requestBlockers.length === 0, blockers: requestBlockers },
        cancel: {
          available: hasRequest,
          blockers: hasRequest ? [] : ["no pending request"],
        },
        execute: { available: executeBlockers.length === 0, blockers: executeBlockers },
        instant: { available: instantBlockers.length === 0, blockers: instantBlockers },
        emergency: {
          available: emergencyOpen && shares > 0n,
          // The haircut is the price of exiting on a mark nobody has refreshed.
          haircutBps: Number(10_000n - EMERGENCY_PAYOUT_BPS),
          estimatedPayoutLamports: ((currentValue * EMERGENCY_PAYOUT_BPS) / 10_000n).toString(),
          blockers: emergencyOpen
            ? shares > 0n
              ? []
              : ["you hold no shares in this vault"]
            : [
                navAge < NAV_EMERGENCY_GRACE_SECONDS
                  ? `the keeper is still posting marks (last ${navAge}s ago); the hatch opens after ${NAV_EMERGENCY_GRACE_SECONDS}s of silence`
                  : "not open",
              ],
        },
      },
    });
  } catch (err) {
    if (respondAuthError(res, err)) return;
    next(err);
  }
});

/**
 * Build an unsigned withdrawal transaction for the caller's OWN wallet.
 *
 * The server never signs it and never can: `authority` and `feePayer` are both
 * the depositor's wallet, and this process holds no key for it.
 */
onchainWithdrawRouter.post("/prepare", async (req, res, next) => {
  try {
    const { identity, user } = await requirePrivyUser(req);
    const body = (req.body ?? {}) as {
      vaultId?: unknown;
      action?: unknown;
      shares?: unknown;
    };

    const action = String(body.action ?? "") as Action;
    if (!ACTIONS.includes(action)) {
      res.status(400).json({
        error: `action must be one of ${ACTIONS.join(", ")}`,
        code: "bad_action",
      });
      return;
    }

    const loaded = await loadVault(res, body.vaultId);
    if (!loaded) return;

    const connection = getConnection();
    const authority = new PublicKey(identity.wallet);
    const [depositorPda] = vaultDepositorPda(loaded.vaultPda, authority);
    const depositor = await fetchVaultDepositorAccount(connection, depositorPda);

    if (!depositor) {
      res.status(409).json({
        error: "you have no position in this vault",
        code: "no_depositor_account",
      });
      return;
    }

    const v = loaded.vault.data;
    const now = nowSec();
    const navAge = now - Number(v.navPostedAt);
    const held = depositor.data.shares;
    const pending = depositor.data.lastWithdrawRequest;
    const hasRequest = pending.shares > 0n;

    // ── shares argument ───────────────────────────────────────────────
    let shares = 0n;
    if (action === "request" || action === "instant" || action === "emergency") {
      const raw = body.shares;
      if (raw === "max" || raw === undefined || raw === null) {
        shares = held;
      } else {
        try {
          shares = BigInt(String(raw));
        } catch {
          res.status(400).json({ error: "shares must be an integer string", code: "bad_shares" });
          return;
        }
      }
      if (shares <= 0n) {
        res.status(400).json({ error: "shares must be > 0", code: "bad_shares" });
        return;
      }
      if (shares > held) {
        res.status(400).json({
          error: `you hold ${held} shares, cannot withdraw ${shares}`,
          code: "insufficient_shares",
          held: held.toString(),
        });
        return;
      }
    }

    // ── preflight: refuse to build what the program would revert ──────
    // Every message here names the gate, so a rejection is something the user
    // can act on rather than an Anchor code.
    const refuse = (code: string, error: string, extra: Record<string, unknown> = {}) => {
      res.status(409).json({ error, code, ...extra });
    };

    if (action === "request") {
      if (hasRequest) return refuse("request_pending", "you already have a pending withdrawal request");
      if (navAge > Number(v.navStalenessSeconds))
        return refuse(
          "nav_stale",
          `the vault's mark is ${navAge}s old and requests need one under ${v.navStalenessSeconds}s. ` +
            "The keeper posts hourly; try again shortly, or use the emergency exit if it has been silent for a week.",
        );
    }
    if (action === "cancel" && !hasRequest) {
      return refuse("no_request", "you have no pending withdrawal request to cancel");
    }
    if (action === "execute") {
      if (!hasRequest) return refuse("no_request", "you have no pending withdrawal request");
      const endsAt = Number(pending.requestedAt) + Number(v.redeemWindowSeconds);
      if (now < endsAt)
        return refuse(
          "window_open",
          `your redeem window ends in ${Math.ceil((endsAt - now) / 60)} minutes`,
          { windowEndsAt: endsAt, secondsRemaining: endsAt - now },
        );
      if (navAge > Number(v.navStalenessSeconds))
        return refuse("nav_stale", `the vault's mark is ${navAge}s old; withdrawals need one under ${v.navStalenessSeconds}s`);
    }
    if (action === "instant") {
      if (hasRequest)
        return refuse("request_pending", "cancel your pending request before withdrawing instantly");
      if (navAge > INSTANT_WITHDRAW_MAX_NAV_STALENESS_SECONDS)
        return refuse(
          "nav_too_stale_for_instant",
          `instant withdrawals need a mark under ${INSTANT_WITHDRAW_MAX_NAV_STALENESS_SECONDS}s old; this one is ${navAge}s. ` +
            "Use a normal withdrawal request instead.",
        );
      const heldFor = now - Number(depositor.data.lastDepositTs);
      if (heldFor < MIN_DEPOSIT_HOLD_SECONDS)
        return refuse(
          "deposit_hold",
          `instant withdrawal opens ${Math.ceil((MIN_DEPOSIT_HOLD_SECONDS - heldFor) / 60)} minutes after your last deposit. ` +
            "A normal withdrawal request works now.",
          { secondsRemaining: MIN_DEPOSIT_HOLD_SECONDS - heldFor },
        );
    }
    if (action === "emergency") {
      const stuckSince =
        hasRequest
          ? Number(pending.requestedAt) +
            Number(v.redeemWindowSeconds) +
            WITHDRAW_REQUEST_GRACE_SECONDS
          : null;
      const open = navAge >= NAV_EMERGENCY_GRACE_SECONDS || (stuckSince !== null && now >= stuckSince);
      if (!open)
        return refuse(
          "emergency_not_open",
          "the emergency exit opens after the keeper has been silent for 7 days, or once your own " +
            `request has been unsettleable for its window plus 14 days. The last mark was ${navAge}s ago.`,
        );
    }

    // ── build ─────────────────────────────────────────────────────────
    const trader = loaded.traderWallet;
    let ix;
    switch (action) {
      case "request":
        ix = buildRequestWithdrawIx({ authority, vault: loaded.vaultPda, shares }).ix;
        break;
      case "cancel":
        ix = buildCancelWithdrawRequestIx({ authority, vault: loaded.vaultPda }).ix;
        break;
      case "execute":
        ix = buildExecuteWithdrawIx({ authority, vault: loaded.vaultPda, trader }).ix;
        break;
      case "instant":
        ix = buildInstantWithdrawIx({ authority, vault: loaded.vaultPda, trader, shares }).ix;
        break;
      case "emergency":
        ix = buildEmergencyWithdrawIx({ authority, vault: loaded.vaultPda, trader, shares }).ix;
        break;
    }

    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: authority,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    const serialized = Buffer.from(tx.serialize()).toString("base64");

    // A wallet with zero SOL cannot pay the signature fee. Say so here rather
    // than letting the send fail — and note this is the one case where an exit
    // genuinely does need the depositor to hold a little SOL.
    const balance = BigInt(await connection.getBalance(authority, "confirmed"));
    if (balance < 10_000n) {
      res.status(400).json({
        error:
          `your wallet holds ${lamportsToSol(balance).toFixed(9)} SOL, which is not enough to pay ` +
          "the network fee for this transaction. Send it a small amount of SOL and try again.",
        code: "insufficient_fee_balance",
        balanceLamports: balance.toString(),
      });
      return;
    }

    res.json({
      transaction: serialized,
      encoding: "base64",
      transactionVersion: 0,
      signed: false,
      action,
      vaultId: loaded.vaultId,
      vaultPda: loaded.vaultPda.toBase58(),
      programId: VAULT_PROGRAM_ID.toBase58(),
      depositorPda: depositorPda.toBase58(),
      authority: identity.wallet,
      feePayer: identity.wallet,
      userId: user.id,
      shares: shares > 0n ? shares.toString() : null,
      blockhash,
      lastValidBlockHeight,
      cluster: env.solanaCluster,
      instruction: {
        name: action,
        accounts: ix.keys.map((k) => ({
          pubkey: k.pubkey.toBase58(),
          isSigner: k.isSigner,
          isWritable: k.isWritable,
        })),
      },
    });
  } catch (err) {
    if (respondAuthError(res, err)) return;
    next(err);
  }
});

/**
 * Verify a broadcast withdrawal on chain and report what actually happened.
 *
 * Like deposit/confirm, this REFUSES to trust the signature: the transaction
 * is fetched, checked for success, checked to have run our program against
 * this vault and this depositor, and the numbers reported back come from the
 * accounts as they are now — not from what the client said it did.
 */
onchainWithdrawRouter.post("/confirm", async (req, res, next) => {
  try {
    const { identity } = await requirePrivyUser(req);
    const body = (req.body ?? {}) as { vaultId?: unknown; signature?: unknown };
    const signature = typeof body.signature === "string" ? body.signature.trim() : "";
    if (!signature) {
      res.status(400).json({ error: "signature is required", code: "bad_signature" });
      return;
    }

    const loaded = await loadVault(res, body.vaultId);
    if (!loaded) return;

    const connection = getConnection();
    const authority = new PublicKey(identity.wallet);
    const [depositorPda] = vaultDepositorPda(loaded.vaultPda, authority);

    // Our RPC can lag the one the wallet broadcast through.
    const deadline = Date.now() + 30_000;
    let tx = null;
    for (;;) {
      tx = await connection
        .getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })
        .catch(() => null);
      if (tx || Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 1_500));
    }
    if (!tx) {
      res.status(404).json({
        error: "transaction not found on chain yet — it may still be confirming",
        code: "tx_not_found",
        signature,
      });
      return;
    }
    if (tx.meta?.err) {
      res.status(400).json({
        error: "the transaction failed on chain",
        code: "tx_failed",
        signature,
        chainError: tx.meta.err,
        logs: tx.meta.logMessages ?? [],
      });
      return;
    }

    // It must have touched OUR program, THIS vault and THIS depositor.
    const keys = tx.transaction.message
      .getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses })
      .staticAccountKeys.map((k) => k.toBase58());
    const all = new Set([
      ...keys,
      ...(tx.meta?.loadedAddresses?.writable ?? []).map((k) => k.toBase58()),
      ...(tx.meta?.loadedAddresses?.readonly ?? []).map((k) => k.toBase58()),
    ]);
    for (const [label, needed] of [
      ["program", VAULT_PROGRAM_ID.toBase58()],
      ["vault", loaded.vaultPda.toBase58()],
      ["depositor", depositorPda.toBase58()],
    ] as const) {
      if (!all.has(needed)) {
        res.status(400).json({
          error: `that transaction does not reference this vault's ${label}`,
          code: "tx_mismatch",
          signature,
        });
        return;
      }
    }

    // Report the position as it stands NOW, read back from chain.
    const [vaultAfter, depositorAfter] = await Promise.all([
      fetchVaultAccount(connection, loaded.vaultPda),
      fetchVaultDepositorAccount(connection, depositorPda),
    ]);

    // Keep the DB's cached TVL honest rather than letting the vault page show
    // a number the chain disagrees with.
    if (vaultAfter) {
      await prisma.vault
        .update({
          where: { id: loaded.vaultId },
          data: { tvlSol: lamportsToSol(vaultAfter.data.navLamports) },
        })
        .catch(() => {});
    }

    res.json({
      ok: true,
      signature,
      vaultId: loaded.vaultId,
      slot: tx.slot,
      feeLamports: tx.meta?.fee ?? null,
      logs: (tx.meta?.logMessages ?? []).filter((l) => l.startsWith("Program log:")),
      position: {
        shares: (depositorAfter?.data.shares ?? 0n).toString(),
        netDepositsLamports: (depositorAfter?.data.netDepositsLamports ?? 0n).toString(),
        cumulativeProfitShareLamports: (
          depositorAfter?.data.cumulativeProfitShareLamports ?? 0n
        ).toString(),
        hasPendingRequest: (depositorAfter?.data.lastWithdrawRequest.shares ?? 0n) > 0n,
      },
      vault: vaultAfter
        ? {
            navLamports: vaultAfter.data.navLamports.toString(),
            totalShares: vaultAfter.data.totalShares.toString(),
          }
        : null,
    });
  } catch (err) {
    if (respondAuthError(res, err)) return;
    next(err);
  }
});
