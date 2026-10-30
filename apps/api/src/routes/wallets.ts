import type { TrackedWallet, WalletSwap } from "@trader-vaults/shared";
import { Router } from "express";
import type { TrackedWallet as DbTrackedWallet } from "@prisma/client";
import { prisma } from "../db.js";
import { getDemoUser } from "../services/vaults.js";
import { scanWallet } from "../services/walletScan.js";

export const walletsRouter = Router();

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function parseSwaps(json: string | null): WalletSwap[] | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as WalletSwap[];
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toShape(row: DbTrackedWallet): TrackedWallet {
  return {
    address: row.address,
    label: row.label ?? undefined,
    stats: {
      winRatePct: row.winRatePct,
      pnlSol: row.pnlSol,
      trades: row.trades,
      profitFactor: row.profitFactor ?? undefined,
    },
    lastActiveAt: row.lastActiveAt,
    isVaultLeader: row.isVaultLeader,
    vaultId: row.vaultId ?? undefined,
    scanStatus: (row.scanStatus as TrackedWallet["scanStatus"]) ?? "unscanned",
    scannedAt: row.scannedAt ?? undefined,
    recentSwaps: parseSwaps(row.recentSwapsJson),
  };
}

/**
 * Run a real chain scan and store the result on the tracked-wallet row.
 * Placeholder/seeded stats survive only until this first runs — after
 * that the stored numbers are always real. One exception: a scan that
 * couldn't even list signatures (know-nothing partial) only stamps
 * scanStatus/scannedAt and leaves prior stats untouched.
 */
async function scanAndStore(
  userId: string,
  address: string,
  force = false,
): Promise<DbTrackedWallet> {
  const result = await scanWallet(address, force);
  const statsUpdate = result.sawChain
    ? {
        winRatePct: result.stats.winRatePct,
        pnlSol: result.stats.pnlSol,
        trades: result.stats.trades,
        profitFactor: result.stats.profitFactor ?? null,
        lastActiveAt: result.lastActiveAt,
        recentSwapsJson: JSON.stringify(result.swaps),
      }
    : {};
  return prisma.trackedWallet.update({
    where: { userId_address: { userId, address } },
    data: {
      ...statsUpdate,
      scannedAt: result.scannedAt,
      scanStatus: result.scanStatus,
    },
  });
}

// GET /api/wallets/tracked
walletsRouter.get("/tracked", async (_req, res, next) => {
  try {
    const user = await getDemoUser();
    const rows = await prisma.trackedWallet.findMany({
      where: { userId: user.id },
      orderBy: { pnlSol: "desc" },
    });
    res.json({ wallets: rows.map(toShape) });
  } catch (err) {
    next(err);
  }
});

// POST /api/wallets/tracked { address, label? } — adds the wallet and
// runs a real mainnet scan inline before responding (bounded ~15s).
walletsRouter.post("/tracked", async (req, res, next) => {
  try {
    const { address, label } = (req.body ?? {}) as { address?: string; label?: string };
    if (!address || !BASE58_RE.test(address)) {
      res.status(400).json({ error: "address must be a base58 Solana address" });
      return;
    }
    if (label !== undefined && typeof label !== "string") {
      // label?.trim() on a non-string threw and surfaced as a 500
      res.status(400).json({ error: "label must be a string" });
      return;
    }
    const user = await getDemoUser();

    // Create with zeroed stats — the real scan below fills them in. We
    // never fabricate placeholder numbers for user-added wallets.
    await prisma.trackedWallet.upsert({
      where: { userId_address: { userId: user.id, address } },
      update: { label: label?.trim() || null },
      create: {
        userId: user.id,
        address,
        label: label?.trim() || null,
        winRatePct: 0,
        pnlSol: 0,
        trades: 0,
        lastActiveAt: 0,
        isVaultLeader: false,
      },
    });
    const row = await scanAndStore(user.id, address);
    res.status(201).json({ wallet: toShape(row) });
  } catch (err) {
    next(err);
  }
});

// POST /api/wallets/tracked/:address/scan?force=1 — re-scan a tracked
// wallet. Serves the 10-minute scan cache unless force=1.
walletsRouter.post("/tracked/:address/scan", async (req, res, next) => {
  try {
    const address = req.params.address;
    if (!BASE58_RE.test(address)) {
      res.status(400).json({ error: "address must be a base58 Solana address" });
      return;
    }
    const user = await getDemoUser();
    const existing = await prisma.trackedWallet.findUnique({
      where: { userId_address: { userId: user.id, address } },
    });
    if (!existing) {
      res.status(404).json({ error: "wallet is not tracked" });
      return;
    }
    const force = req.query.force === "1" || req.query.force === "true";
    const row = await scanAndStore(user.id, address, force);
    res.json({ wallet: toShape(row) });
  } catch (err) {
    next(err);
  }
});
