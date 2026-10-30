// ── trader profile assembly ────────────────────────────────────────
// Resolves a User by handle and aggregates their vaults into a single
// public profile view. Vault shapes come from the shared assembly
// service (services/vaults.ts) — never reimplemented here — so the
// profile page and every other surface agree on the numbers.

import type { TraderProfile, Vault } from "@trader-vaults/shared";
import { prisma } from "../db.js";
import { assembleVaults, toTraderProfile } from "./vaults.js";

export interface TraderTotals {
  /** Sum of TVL across the trader's vaults, in SOL. */
  tvlSol: number;
  /** Unique depositors across all their vaults (not a per-vault sum). */
  depositors: number;
  /** Trades across their vaults in the last 30 days. */
  trades30d: number;
  /** TVL-weighted mean of the vaults' 30d returns (0 when no TVL). */
  pnlPct30dWeighted: number;
}

export interface TraderView {
  trader: TraderProfile;
  /** ALL their vaults — each carries `mode`, the client splits surfaces. */
  vaults: Vault[];
  /** REAL vaults only — the main platform column. */
  totals: TraderTotals;
  /** PAPER vaults only — the clearly-labeled sandbox column. */
  paperTotals: TraderTotals;
}

const nowSec = () => Math.floor(Date.now() / 1000);

function round(v: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function totalsFor(
  vaults: Vault[],
  depositRows: { userId: string; vaultId: string }[],
  trades30d: number,
): TraderTotals {
  const tvlSol = vaults.reduce((s, v) => s + v.tvlSol, 0);
  const weighted =
    tvlSol > 0 ? vaults.reduce((s, v) => s + v.stats.pnlPct30d * v.tvlSol, 0) / tvlSol : 0;
  return {
    tvlSol: round(tvlSol, 2),
    depositors: new Set(depositRows.map((d) => d.userId)).size,
    trades30d,
    pnlPct30dWeighted: round(weighted, 1),
  };
}

export async function getTraderView(handle: string): Promise<TraderView | undefined> {
  const user = await prisma.user.findUnique({ where: { handle } });
  if (!user) return undefined;

  const vaultRows = await prisma.vault.findMany({
    where: { traderId: user.id },
    select: { id: true },
  });
  const vaultIds = vaultRows.map((v) => v.id);

  const [vaults, depositRows] = await Promise.all([
    vaultIds.length
      ? assembleVaults({ ids: vaultIds }, { curvePoints: 240 })
      : Promise.resolve([] as Vault[]),
    vaultIds.length
      ? prisma.deposit.findMany({
          where: { vaultId: { in: vaultIds } },
          select: { userId: true, vaultId: true },
        })
      : Promise.resolve([] as { userId: string; vaultId: string }[]),
  ]);

  // real/paper split — totals never mix the sandbox into the main column
  const realIds = vaults.filter((v) => v.mode === "real").map((v) => v.id);
  const paperIds = vaults.filter((v) => v.mode === "paper").map((v) => v.id);
  const since = nowSec() - 30 * 86400;
  const [realTrades30d, paperTrades30d] = await Promise.all([
    realIds.length
      ? prisma.trade.count({ where: { vaultId: { in: realIds }, ts: { gte: since } } })
      : Promise.resolve(0),
    paperIds.length
      ? prisma.trade.count({ where: { vaultId: { in: paperIds }, ts: { gte: since } } })
      : Promise.resolve(0),
  ]);

  // Assembled vaults already embed the trader profile with onchainStats
  // aggregated across ALL their vaults — reuse it rather than recompute.
  const trader = vaults[0]?.trader ?? toTraderProfile(user, []);

  return {
    trader,
    vaults,
    totals: totalsFor(
      vaults.filter((v) => v.mode === "real"),
      depositRows.filter((d) => realIds.includes(d.vaultId)),
      realTrades30d,
    ),
    paperTotals: totalsFor(
      vaults.filter((v) => v.mode === "paper"),
      depositRows.filter((d) => paperIds.includes(d.vaultId)),
      paperTrades30d,
    ),
  };
}
