import { prisma } from "../db.js";
import { env } from "../env.js";

/**
 * Distributing pump.fun creator rewards into vaults.
 *
 * The easy half is sending SOL. The hard half is choosing who gets it
 * without the choice being farmable, because the moment a rule pays out on a
 * number, someone manufactures that number.
 *
 * Three attacks this has to survive:
 *
 *   Sybil      — one person opens twenty vaults, seeds each with dust, and
 *                collects twenty allocations. Defended by a per-trader cap,
 *                not just a per-vault cap.
 *   Wash       — a trader deposits into their own vault to look funded, or
 *                trades against themselves to manufacture volume. Defended
 *                by counting DISTINCT depositors other than the trader, and
 *                by scoring per-share value rather than TVL.
 *   Flash      — a vault is created the day of a distribution with a lucky
 *                trade and a huge percentage return. Defended by a minimum
 *                age and by scoring over a window, not a moment.
 *
 * Nothing here moves lamports. `planDistribution` returns what WOULD be sent
 * so it can be reviewed, published, and diffed against what actually lands.
 * Handing an automated process the keys to a live wallet is a decision that
 * should be made deliberately, not inherited from a helper function.
 */

// ── eligibility ──────────────────────────────────────────────────────

/**
 * Eligibility mode.
 *
 * "open"  — every active real vault shares the pot equally, regardless of
 *           performance or depositor count. Owner's decision: fees fund
 *           anyone, good or bad.
 * "merit" — the scored version below.
 *
 * The tradeoff is real and worth stating: under "open", one person can open
 * N vaults and take N shares of every distribution, because nothing
 * distinguishes a real vault from a wallet with a name. If that starts
 * happening, MIN_INDEPENDENT_DEPOSITORS is the switch that stops it.
 */
export type EligibilityMode = "open" | "merit";
export const DEFAULT_MODE: EligibilityMode = "open";

/** A vault younger than this cannot have a track record worth funding. */
const MIN_AGE_DAYS = 14;

/**
 * Distinct depositors other than the trader.
 *
 * This is the anti-sybil load-bearing rule. A vault nobody else has funded is
 * indistinguishable from a vault created to farm this distribution.
 */
const MIN_INDEPENDENT_DEPOSITORS = 3;

/** Share of the pot any single vault can take. */
const MAX_VAULT_SHARE = 0.25;

/**
 * Share any one TRADER can take across all their vaults.
 *
 * Without this the per-vault cap is theatre: five vaults at 25% each is one
 * person taking the entire pot.
 */
const MAX_TRADER_SHARE = 0.35;

/** Leave the wallet enough to pay for its own claim transactions. */
const RESERVE_SOL = 0.05;

/** Below this a distribution costs more in fees and attention than it moves. */
const MIN_DISTRIBUTION_SOL = 0.1;

/** Nothing smaller than this is worth a transaction and rent. */
const MIN_ALLOCATION_SOL = 0.01;

export interface VaultScore {
  vaultId: string;
  vaultName: string;
  traderId: string;
  /** per-share return over the window, as a fraction (0.2 = +20%) */
  returnPct: number;
  independentDepositors: number;
  ageDays: number;
  tvlSol: number;
  score: number;
}

export interface Allocation {
  vaultId: string;
  vaultName: string;
  traderId: string;
  amountSol: number;
  reason: string;
}

export interface DistributionPlan {
  wallet: string | null;
  poolSol: number;
  distributableSol: number;
  allocations: Allocation[];
  /** Vaults considered and rejected, with why. Published alongside the plan. */
  excluded: { vaultId: string; vaultName: string; reason: string }[];
  totalAllocatedSol: number;
  generatedAt: number;
}

/**
 * Per-share return over `windowDays`.
 *
 * Per-share, not TVL: TVL grows when someone deposits, which is not
 * performance and would pay a trader for taking money in rather than for
 * doing anything with it.
 */
async function windowReturn(vaultId: string, windowDays: number): Promise<number | null> {
  const since = Math.floor(Date.now() / 1000) - windowDays * 86_400;
  // EquityPoint.v is the SHARE PRICE, not vault equity — the column comment
  // in schema.prisma still says equity and is stale, left over from before
  // the curve was switched to per-share. Per-share is what this needs:
  // equity rises when someone deposits, which is not performance.
  const points = await prisma.equityPoint.findMany({
    where: { vaultId, t: { gte: since } },
    orderBy: { t: "asc" },
    select: { t: true, v: true },
  });
  if (points.length < 2) return null;

  const first = points[0]!.v;
  const last = points[points.length - 1]!.v;
  if (!(first > 0)) return null;
  return last / first - 1;
}

/**
 * Score the vaults eligible for funding.
 *
 * Real vaults only. Funding a paper vault would be paying out on simulated
 * fills, which is the one thing the whole real/paper wall exists to prevent.
 */
export async function scoreVaults(windowDays = 30): Promise<{
  scored: VaultScore[];
  excluded: { vaultId: string; vaultName: string; reason: string }[];
}> {
  const vaults = await prisma.vault.findMany({
    where: { mode: "real", status: "active" },
    select: { id: true, name: true, traderId: true, createdAt: true, tvlSol: true },
  });

  const scored: VaultScore[] = [];
  const excluded: { vaultId: string; vaultName: string; reason: string }[] = [];

  for (const v of vaults) {
    const ageDays = (Date.now() - v.createdAt.getTime()) / 86_400_000;
    if (ageDays < MIN_AGE_DAYS) {
      excluded.push({ vaultId: v.id, vaultName: v.name, reason: `too new (${ageDays.toFixed(1)}d < ${MIN_AGE_DAYS}d)` });
      continue;
    }

    // Depositors who are not the trader. A vault funded only by its own
    // trader tells us nothing except that its trader has a second wallet.
    const depositors = await prisma.vaultDepositor.findMany({
      where: { vaultId: v.id, shares: { gt: 0 } },
      select: { userId: true },
    });
    const independent = new Set(depositors.map((d) => d.userId).filter((u) => u !== v.traderId));
    if (independent.size < MIN_INDEPENDENT_DEPOSITORS) {
      excluded.push({
        vaultId: v.id,
        vaultName: v.name,
        reason: `only ${independent.size} independent depositor(s), need ${MIN_INDEPENDENT_DEPOSITORS}`,
      });
      continue;
    }

    const ret = await windowReturn(v.id, windowDays);
    if (ret === null) {
      excluded.push({ vaultId: v.id, vaultName: v.name, reason: "not enough history to measure a return" });
      continue;
    }
    if (ret <= 0) {
      excluded.push({ vaultId: v.id, vaultName: v.name, reason: `flat or down over ${windowDays}d (${(ret * 100).toFixed(1)}%)` });
      continue;
    }

    // Weight return by the square root of independent depositor count.
    // Linear weighting would make recruiting depositors dominate the score;
    // sqrt says a vault trusted by more people is worth more without letting
    // that swamp the thing being measured.
    scored.push({
      vaultId: v.id,
      vaultName: v.name,
      traderId: v.traderId,
      returnPct: ret,
      independentDepositors: independent.size,
      ageDays,
      tvlSol: v.tvlSol,
      score: ret * Math.sqrt(independent.size),
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return { scored, excluded };
}

/**
 * Build the distribution plan for a pool of SOL.
 *
 * Pure: reads state, moves nothing.
 */
export async function planDistribution(
  poolSol: number,
  windowDays = 30,
  mode: EligibilityMode = DEFAULT_MODE,
): Promise<DistributionPlan> {
  if (mode === "open") return planOpenDistribution(poolSol);
  const { scored, excluded } = await scoreVaults(windowDays);
  const distributable = Math.max(0, poolSol - RESERVE_SOL);

  const plan: DistributionPlan = {
    wallet: env.creatorRewardsWallet ?? null,
    poolSol,
    distributableSol: distributable,
    allocations: [],
    excluded,
    totalAllocatedSol: 0,
    generatedAt: Date.now(),
  };

  if (distributable < MIN_DISTRIBUTION_SOL || scored.length === 0) return plan;

  const totalScore = scored.reduce((s, v) => s + v.score, 0);
  if (totalScore <= 0) return plan;

  const perVaultCap = distributable * MAX_VAULT_SHARE;
  const perTraderCap = distributable * MAX_TRADER_SHARE;
  const traderTaken = new Map<string, number>();

  for (const v of scored) {
    const proRata = distributable * (v.score / totalScore);
    const takenByTrader = traderTaken.get(v.traderId) ?? 0;
    const headroom = Math.max(0, perTraderCap - takenByTrader);
    const amount = Math.min(proRata, perVaultCap, headroom);

    if (amount < MIN_ALLOCATION_SOL) continue;

    const caps: string[] = [];
    if (amount < proRata - 1e-9) {
      caps.push(amount === headroom ? "trader cap" : "vault cap");
    }
    plan.allocations.push({
      vaultId: v.vaultId,
      vaultName: v.vaultName,
      traderId: v.traderId,
      amountSol: Number(amount.toFixed(6)),
      reason:
        `+${(v.returnPct * 100).toFixed(1)}% per-share over ${windowDays}d, ` +
        `${v.independentDepositors} independent depositors` +
        (caps.length ? ` (capped by ${caps.join(", ")})` : ""),
    });
    traderTaken.set(v.traderId, takenByTrader + amount);
  }

  plan.totalAllocatedSol = Number(
    plan.allocations.reduce((s, a) => s + a.amountSol, 0).toFixed(6),
  );
  return plan;
}

/**
 * Equal split across every active real vault, no performance test.
 *
 * Still refuses paper vaults. Simulated fills funded with real SOL is the
 * one line the real/paper wall exists to hold, and no product decision
 * about generosity changes that.
 */
async function planOpenDistribution(poolSol: number): Promise<DistributionPlan> {
  const vaults = await prisma.vault.findMany({
    where: { mode: "real", status: "active" },
    select: { id: true, name: true, traderId: true },
  });

  const distributable = Math.max(0, poolSol - RESERVE_SOL);
  const plan: DistributionPlan = {
    wallet: env.creatorRewardsWallet ?? null,
    poolSol,
    distributableSol: distributable,
    allocations: [],
    excluded: [],
    totalAllocatedSol: 0,
    generatedAt: Date.now(),
  };
  if (vaults.length === 0 || distributable < MIN_DISTRIBUTION_SOL) return plan;

  const each = distributable / vaults.length;
  if (each < MIN_ALLOCATION_SOL) {
    plan.excluded = vaults.map((v) => ({
      vaultId: v.id,
      vaultName: v.name,
      reason: `split across ${vaults.length} vaults is ${each.toFixed(6)} SOL, below the ${MIN_ALLOCATION_SOL} minimum`,
    }));
    return plan;
  }

  plan.allocations = vaults.map((v) => ({
    vaultId: v.id,
    vaultName: v.name,
    traderId: v.traderId,
    amountSol: Number(each.toFixed(6)),
    reason: `equal share of ${distributable.toFixed(4)} SOL across ${vaults.length} active real vaults`,
  }));
  plan.totalAllocatedSol = Number(plan.allocations.reduce((s, a) => s + a.amountSol, 0).toFixed(6));
  return plan;
}
