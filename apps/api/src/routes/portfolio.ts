import type { Holding } from "@trader-vaults/shared";
import { Router } from "express";
import { prisma } from "../db.js";
import { requirePrivyUser } from "../services/privyAuth.js";
import { respondAuthError } from "./onchain.js";
import { getDemoUser, toWithdrawRequest } from "../services/vaults.js";
import { PublicKey } from "@solana/web3.js";
import {
  effectiveEquity,
  fetchVaultAccount,
  fetchVaultDepositorAccount,
  valueForShares,
  vaultDepositorPda,
} from "../services/program.js";
import { getConnection } from "../services/signer.js";
import { privyConfigured } from "../services/privyAuth.js";

export const portfolioRouter = Router();

/**
 * GET /api/portfolio — the CALLER's holdings and withdraw requests.
 *
 * Two things were wrong here and they compounded.
 *
 * First, the route called getDemoUser() and ignored the caller's identity
 * entirely, so every visitor — signed in or not — was served the same shared
 * "you" account's positions. That is both a false display and a leak of one
 * account's ledger to everyone.
 *
 * Second, it read ONLY the paper ledger (prisma.vaultDepositor). The real
 * deposit path writes an OnChainDeposit index row and nothing else; the
 * authoritative position lives in the VaultDepositor PDA on chain. So a user
 * who deposited real mainnet SOL saw zero holdings, which is the worst
 * possible thing for a page whose entire job is "where is my money".
 *
 * Real positions are now read FROM THE CHAIN for the caller's own wallet and
 * priced with the program's own share math (effective equity → value_for_shares),
 * never by multiplying a cached DB share price that nothing refreshes.
 */
portfolioRouter.get("/", async (req, res, next) => {
  try {
    // Demo mode (no Privy configured) keeps working against the shared
    // account; a configured deployment requires a real session and returns an
    // empty portfolio rather than someone else's.
    let user;
    let wallet: string | null = null;
    if (privyConfigured()) {
      try {
        const auth = await requirePrivyUser(req);
        user = auth.user;
        wallet = auth.identity.wallet;
      } catch {
        res.json({ holdings: [], withdrawRequests: [] });
        return;
      }
    } else {
      user = await getDemoUser();
    }

    const [depositors, withdrawals, onchainRows] = await Promise.all([
      prisma.vaultDepositor.findMany({
        where: { userId: user.id },
        include: { vault: true },
      }),
      prisma.withdrawRequest.findMany({
        where: { userId: user.id },
        orderBy: { requestedAt: "desc" },
      }),
      // Which real vaults has this user ever deposited into? The index row is
      // used only to know WHERE to look; the position itself comes from chain.
      wallet
        ? prisma.onChainDeposit.findMany({
            where: { userId: user.id },
            select: { vaultId: true },
            distinct: ["vaultId"],
          })
        : Promise.resolve([]),
    ]);

    // ── paper holdings ────────────────────────────────────────────────
    const holdings: Holding[] = depositors
      .filter((d) => d.shares > 1e-9)
      .map((d) => {
        const valueSol = d.shares * d.vault.sharePriceSol;
        const pnlSol = valueSol - d.costSol;
        return {
          vaultId: d.vaultId,
          vaultName: d.vault.name,
          vaultType: d.vault.type as Holding["vaultType"],
          shares: d.shares,
          valueSol,
          costSol: d.costSol,
          pnlSol,
          pnlPct: d.costSol > 0 ? (pnlSol / d.costSol) * 100 : 0,
        };
      });

    // ── real, on-chain holdings ───────────────────────────────────────
    if (wallet && onchainRows.length > 0) {
      const walletKey = new PublicKey(wallet);
      const connection = getConnection();
      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      const vaults = await prisma.vault.findMany({
        where: { id: { in: onchainRows.map((r) => r.vaultId) } },
        select: { id: true, name: true, type: true, onchainVaultPda: true },
      });

      const reads = await Promise.all(
        vaults.map(async (v) => {
          if (!v.onchainVaultPda) return null;
          try {
            // One unreadable vault must not take the whole page down — a
            // portfolio that 500s is indistinguishable from one that is
            // empty, and the difference matters a great deal here.
            const vaultKey = new PublicKey(v.onchainVaultPda);
            const [vaultAcc, depositorAcc] = await Promise.all([
              fetchVaultAccount(connection, vaultKey),
              fetchVaultDepositorAccount(
                connection,
                vaultDepositorPda(vaultKey, walletKey)[0],
              ),
            ]);
            if (!vaultAcc || !depositorAcc || depositorAcc.data.shares === 0n) return null;
            return { v, vaultAcc, depositorAcc };
          } catch {
            return null;
          }
        }),
      );

      for (const r of reads) {
        if (!r) continue;
        // Priced with the PROGRAM's own share math against effective equity —
        // the same numbers a withdrawal would produce — not by multiplying a
        // cached DB share price that nothing on this deployment refreshes.
        const equity = effectiveEquity(r.vaultAcc.data, nowSec);
        const valueLamports = valueForShares(
          r.depositorAcc.data.shares,
          r.vaultAcc.data.totalShares,
          equity,
        );
        const valueSol = Number(valueLamports) / 1e9;
        const costSol = Number(r.depositorAcc.data.netDepositsLamports) / 1e9;
        const pnlSol = valueSol - costSol;
        holdings.push({
          vaultId: r.v.id,
          vaultName: r.v.name,
          vaultType: r.v.type as Holding["vaultType"],
          // Program shares are u128; scaled here for display only. Value and
          // cost are the authority.
          shares: Number(r.depositorAcc.data.shares) / 1e12,
          valueSol,
          costSol,
          pnlSol,
          pnlPct: costSol > 0 ? (pnlSol / costSol) * 100 : 0,
        });
      }
    }

    holdings.sort((a, b) => b.valueSol - a.valueSol);

    res.json({
      holdings,
      withdrawRequests: withdrawals.map(toWithdrawRequest),
    });
  } catch (err) {
    if (respondAuthError(res, err)) return;
    next(err);
  }
});
