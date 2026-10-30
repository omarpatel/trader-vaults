// ── fee crystallization ─────────────────────────────────────────────
// The 70/30 money flow, per-portion:
//
//   profit    = gross proceeds − proportional cost basis of the shares
//               being burned (never negative)
//   perfFee   = profit × perfFeeBps / 10_000       (creator-set 10–30%)
//     ├─ traderFee    = perfFee − vested           (paid to the trader now)
//     └─ traderVested = profit × vestedBps / 10_000 (escrow, locked 60d)
//   payout    = gross − perfFee
//
// THE DEPOSITOR INVARIANT: `paidSol === grossSol − perfFeeSol`, and
// perfFeeSol is derived from perfFeeBps alone. The vesting split is
// computed from perfFeeSol AFTERWARDS and the immediate leg is the
// remainder, so no rounding in the split can ever move the depositor's
// payout by a single lamport. A depositor's economics under 30% with
// vesting are byte-identical to a flat 30%.
//
// There is NO platform cut. The 10 points that used to fund the buyback
// are the trader's — they just cannot be touched for 60 days.
//
// Losses pay gross with zero fees. Fees accrue on the vault OUTSIDE tvl
// (they are owed, not depositor equity), so per-share value is untouched
// by a fair exit and remaining depositors never subsidize fees.

import type { FeeBreakdown } from "@trader-vaults/shared";
import { splitPerfFeeBps, VEST_LOCK_SECONDS } from "@trader-vaults/shared";

export function crystallize(opts: {
  grossSol: number;
  /** depositor's remaining cost basis across their whole position */
  positionCostSol: number;
  /** shares being burned */
  shares: number;
  /** depositor's total shares before this exit */
  positionShares: number;
  perfFeeBps: number;
}): FeeBreakdown {
  const { grossSol, positionCostSol, shares, positionShares, perfFeeBps } = opts;
  const fraction = positionShares > 0 ? Math.min(1, shares / positionShares) : 1;
  const costBasisSol = positionCostSol * fraction;
  const profitSol = Math.max(0, grossSol - costBasisSol);

  // The depositor's whole cost, computed once, from the headline rate.
  const perfFeeSol = (profitSol * perfFeeBps) / 10_000;
  // Then split the TRADER's side. immediate = total − vested keeps the
  // two legs summing back to perfFeeSol exactly.
  const { vestedBps } = splitPerfFeeBps(perfFeeBps);
  const traderVestedSol = (profitSol * vestedBps) / 10_000;
  const traderFeeSol = perfFeeSol - traderVestedSol;

  const paidSol = grossSol - perfFeeSol;
  return {
    grossSol,
    costBasisSol,
    profitSol,
    perfFeeSol,
    traderFeeSol,
    traderVestedSol,
    paidSol,
  };
}

/** unix seconds at which a tranche crystallized `atSec` unlocks. */
export function unlockAt(atSec: number): number {
  return atSec + VEST_LOCK_SECONDS;
}
