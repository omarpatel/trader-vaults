// ── NAV keeper ─────────────────────────────────────────────────────
// The scheduled `post_nav` poster. It exists for exactly one reason:
//
//   deposit.rs (and every withdrawal path) calls `vault.assert_nav_fresh`,
//   which reverts with NavStale once `now - nav_posted_at` exceeds the
//   vault's `nav_staleness_seconds`. Our vaults are created with
//   navStalenessSeconds = 3600 (onchainVaults.ts PLATFORM_VAULT_DEFAULTS),
//   so a real vault becomes UN-DEPOSITABLE one hour after its last mark.
//   Nothing else in this codebase posts marks. Without this loop, every
//   real vault silently bricks itself an hour after creation.
//
// WHAT THIS TICK IS *NOT*: a revaluation. A real vault's true NAV is its
// SOL buffer plus the mark-to-market value of its token positions, and on
// devnet those positions do not exist yet (both live vaults hold zero
// token accounts). So the mark this keeper posts is the vault's CURRENT
// on-chain equity — the same number the program is already carrying —
// re-posted with a fresh slot and timestamp. See `decideMark` for the full
// argument and for the marked extension point where real position marks
// (via the price oracle) get folded in once vaults hold tokens.
//
// PROGRAM GUARDS THIS LOOP OBEYS (post_nav.rs — read it before changing
// anything here; every one of these is a revert, i.e. a burned fee):
//   • keeper must be `vault.nav_keeper`      → InvalidNavKeeper  (6021)
//   • mark_slot > vault.nav_slot             → NavSlotNotMonotonic (6025)
//   • mark_slot <= clock.slot                → NavSlotNotMonotonic (6025)
//   • clock.slot - mark_slot <= 750          → NavMarkTooOld     (6026)
//   • |nav - old_nav| <= max_nav_delta_bps   → NavDeltaTooLarge  (6027)
//   • nav <= MAX_NAV_LAMPORTS                → NavCapExceeded    (6019)
// The slot is read at CONFIRMED commitment: a processed-level slot can be
// ahead of the slot the transaction actually executes at, which reverts as
// NavSlotNotMonotonic (that lesson is already written down in program.ts).
//
// DEVNET SOL IS SCARCE (~2.18 SOL, faucets rate-limit hard). Every post
// costs a signature fee (5000 lamports), so this loop skips aggressively:
// it posts only when a vault is approaching staleness, never on a whim,
// and logs the fee it actually paid plus a running total.

import { PublicKey } from "@solana/web3.js";
import { prisma } from "../db.js";
import {
  MAX_NAV_LAMPORTS,
  StaleVaultLayoutError,
  VAULT_ACCOUNT_BYTES,
  buildPostNavIx,
  effectiveEquity,
  explorerTx,
  fetchVaultAccount,
  lamportsToSol,
  type VaultAccount,
} from "./program.js";
import {
  OnChainError,
  getConfirmedSlot,
  getConnection,
  getLamports,
  sendAndConfirm,
  tryGetNavKeeperKeypair,
} from "./signer.js";

// ── cadence ────────────────────────────────────────────────────────

/**
 * Tick every 10 minutes. This is deliberately far inside the vaults'
 * `nav_staleness_seconds` (3600s): the loop gets six chances per staleness
 * window, so an RPC blip, a devnet fork or a single failed send costs a
 * retry rather than a bricked vault.
 */
const NAV_TICK_MS = 10 * 60_000;

/**
 * A vault is re-marked when its NAV is within this many seconds of going
 * stale — i.e. two whole ticks of head-room before deposits would start
 * reverting, and no sooner.
 *
 * WHY NOT JUST POST EVERY TICK: post_nav re-baselines the locked-profit
 * drip on EVERY post, including a zero-delta one. Its loss/flat branch sets
 * `locked_profit = locked_profit_now(now)` and `locked_profit_ts = now`, so
 * each post restarts the unlock clock from whatever is left. Posting every
 * 10 minutes against a 3600s unlock period would turn the program's LINEAR
 * unlock into a geometric one that never reaches zero — profit already
 * earned by depositors would stay locked out of the share price forever.
 * Posting late (this lead) lets ~2/3 of each drip complete before the clock
 * restarts. It also costs a third as many signature fees. Both reasons
 * point the same way: post as late as safety allows, never as often as
 * possible.
 */
const REFRESH_LEAD_TICKS = 2n;
const REFRESH_LEAD_SECONDS = REFRESH_LEAD_TICKS * BigInt(NAV_TICK_MS / 1000);

/**
 * First tick runs shortly after boot rather than a full interval later: a
 * process that restarts every deploy must not leave a vault un-depositable
 * for ten minutes each time.
 */
const FIRST_TICK_DELAY_MS = 5_000;

/** Base signature fee, used only for the pre-flight affordability check. */
const SIGNATURE_FEE_LAMPORTS = 5_000n;

/** Below this the keeper starts shouting; devnet faucets are rate-limited. */
const LOW_BALANCE_WARN_LAMPORTS = 100_000_000n; // 0.1 SOL

const SECONDS_PER_DAY = 86_400n;
const BPS_DENOMINATOR = 10_000n;

// ── module state ───────────────────────────────────────────────────

let navTimer: NodeJS.Timeout | null = null;
let firstTickTimer: NodeJS.Timeout | null = null;
let tickRunning = false;

/** Rent-exempt minimum for a Vault account — same for every vault, fetched once. */
/**
 * Vaults whose on-chain account predates the current program layout.
 *
 * They cannot be decoded, cannot be posted to, and will never become valid
 * again — the PDA seeds changed. Remembering them means one warning instead
 * of one per vault per tick.
 */
const warnedStaleLayout = new Set<string>();

let rentExemptMinimum: bigint | null = null;

/** Lifetime fee accounting, so "where did the devnet SOL go" is answerable. */
let feesSpentLamports = 0n;
let postsSent = 0;

const nowSec = (): bigint => BigInt(Math.floor(Date.now() / 1000));

// ── start / stop ───────────────────────────────────────────────────

/** Shares are stored on-chain in units of 1e12 per SOL. */
const SHARE_UNITS_PER_SOL = 1_000_000_000_000n;

/**
 * Cache the on-chain truth into the Vault row so every existing surface
 * (explore board, vault page, sparklines) reports a real vault honestly
 * without any of them needing to speak Solana.
 */
async function syncOnChainVaultToDb(
  vaultId: string,
  v: { navLamports: bigint; totalShares: bigint },
): Promise<void> {
  const tvlSol = Number(v.navLamports) / 1e9;
  const sharesSol = Number(v.totalShares) / Number(SHARE_UNITS_PER_SOL);
  const sharePriceSol = sharesSol > 0 ? tvlSol / sharesSol : 1;
  await prisma.vault.update({
    where: { id: vaultId },
    data: { tvlSol, totalShares: sharesSol, sharePriceSol },
  });
}

export function startNavKeeper(): void {
  if (navTimer) return; // already running
  navTimer = setInterval(() => void navTick(), NAV_TICK_MS);
  firstTickTimer = setTimeout(() => void navTick(), FIRST_TICK_DELAY_MS);
  console.log(
    `[nav] keeper started — tick every ${NAV_TICK_MS / 60_000}m, re-mark when NAV is ` +
      `within ${REFRESH_LEAD_SECONDS}s of its staleness window`,
  );
}

export function stopNavKeeper(): void {
  if (navTimer) clearInterval(navTimer);
  if (firstTickTimer) clearTimeout(firstTickTimer);
  navTimer = null;
  firstTickTimer = null;
}

// ── the mark ───────────────────────────────────────────────────────

interface MarkDecision {
  /** The NAV we intend to post, before the program's own caps are applied. */
  targetLamports: bigint;
  /** Equity implied by the vault account's own lamports (the cross-check). */
  lamportsEquity: bigint;
  /** lamportsEquity − nav_lamports. Non-zero means the two disagree. */
  driftLamports: bigint;
}

/**
 * Decide what to post.
 *
 * BE HONEST ABOUT WHAT THIS IS. A vault's real NAV is
 *
 *      SOL buffer  +  Σ (position size × live price)
 *
 * and the second term does not exist yet: neither live devnet vault holds a
 * single token account, and nothing in this API has ever executed a swap on
 * chain. Inventing a revaluation here would be inventing a number. So the
 * mark is the vault's CURRENT equity, which is `vault.nav_lamports` — the
 * figure the PROGRAM maintains, seeded at init with the burned seed deposit
 * and adjusted by the program itself for every deposit (+) and withdrawal
 * (−) since (state.rs, `nav_lamports`). Re-posting it changes no valuation;
 * it only refreshes `nav_slot` / `nav_posted_at`.
 *
 * THE POINT OF THIS TICK IS FRESHNESS, NOT REVALUATION.
 *
 * The lamports-derived figure is computed too, but only as a CROSS-CHECK:
 * `account lamports − rent-exempt minimum − platform fees owed` is exactly
 * what the program treats as vault-owned SOL (state.rs `free_sol`, minus
 * the pending-withdrawal reservation, which is still NAV until the
 * withdrawal executes). For a vault holding no tokens the two must agree —
 * and for the DB-tracked vault they do, to the lamport. When they do NOT
 * agree, the difference is logged and DELIBERATELY not acted on: the same
 * gap is produced by an unaccounted SOL donation (a real gain), by SOL
 * wrapped into a trading wSOL account (not a loss at all — the value moved
 * to an account these lamports do not count), and by an earlier synthetic
 * test mark. A keeper that cannot tell those apart must not mark the book.
 *
 * ┌─ EXTENSION POINT: real position marks ──────────────────────────┐
 * │ When vaults start holding tokens, THIS is the function to grow:  │
 * │   1. enumerate the vault PDA's token accounts (incl. its wSOL    │
 * │      ATA — wrapped SOL is vault equity that lives off-account);  │
 * │   2. price each mint through services/prices.ts (the same        │
 * │      multi-tier oracle the paper engine marks against), and      │
 * │      ABORT the whole mark when any held mint has no live price   │
 * │      — a partial book is worse than a stale one, because it      │
 * │      posts a fake loss the size of the unpriced position;        │
 * │   3. target = free SOL + Σ marks, and let the delta cap and the  │
 * │      daily-loss breaker below do their jobs.                     │
 * │ Until all three exist, the honest mark is the one below.         │
 * └──────────────────────────────────────────────────────────────────┘
 */
function decideMark(v: VaultAccount, accountLamports: bigint, rentExempt: bigint): MarkDecision {
  const owned = accountLamports - rentExempt - v.platformFeesOwedLamports;
  const lamportsEquity = owned > 0n ? owned : 0n;
  return {
    targetLamports: v.navLamports,
    lamportsEquity,
    driftLamports: lamportsEquity - v.navLamports,
  };
}

// ── program guards, applied client-side ────────────────────────────

/**
 * post_nav caps |nav − old_nav| at `mul_bps_floor(old_nav, max_nav_delta_bps)`
 * and reverts with NavDeltaTooLarge otherwise. Clamp to the largest legal
 * step instead of reverting: a partial move toward the truth, posted, beats
 * a correct number rejected — and the next tick moves the rest of the way.
 *
 * NOTE the degenerate case: when `old_nav` is 0 the cap is 0, so the ONLY
 * legal post is 0. A vault marked to zero can never be marked back up.
 */
function clampToDeltaCap(
  oldNav: bigint,
  target: bigint,
  maxNavDeltaBps: number,
): { nav: bigint; clampedBy: bigint } {
  const cap = (oldNav * BigInt(maxNavDeltaBps)) / BPS_DENOMINATOR; // floor, as on-chain
  if (target > oldNav + cap) return { nav: oldNav + cap, clampedBy: target - (oldNav + cap) };
  if (target + cap < oldNav) return { nav: oldNav - cap, clampedBy: oldNav - cap - target };
  return { nav: target, clampedBy: 0n };
}

/**
 * Would this post trip the daily-loss circuit breaker (post_nav.rs) and
 * freeze the vault? A frozen vault still allows withdrawals but REJECTS
 * deposits (deposit.rs requires VaultStatus::Active), so this is worth
 * saying out loud before it happens. We warn rather than clamp: the breaker
 * is a risk control, and a keeper that quietly shaves its marks to stay
 * under it would be defeating the control instead of respecting it.
 */
function wouldTripDailyBreaker(v: VaultAccount, loss: bigint, now: bigint): boolean {
  if (v.dailyLossLimitBps === 0 || v.status !== "Active") return false;
  const today = now / SECONDS_PER_DAY; // timestamps are positive; matches div_euclid
  // A day roll inside post_nav resets the accumulator and re-bases the
  // threshold on the equity the day opens with — model that before testing.
  const rolled = v.dayBucket !== today;
  const accumulator = rolled ? 0n : v.dailyLossAccumulator;
  // effectiveEquity is program.ts's port of state.rs `effective_equity`
  // (nav − the ceil-rounded locked-profit remainder) — reused, not re-derived.
  const base = rolled ? effectiveEquity(v, now) : v.dayStartEquity;
  const threshold = (base * BigInt(v.dailyLossLimitBps)) / BPS_DENOMINATOR;
  return accumulator + loss > threshold;
}

// ── the tick ───────────────────────────────────────────────────────

async function navTick(): Promise<void> {
  if (tickRunning) return; // previous tick still in flight
  tickRunning = true;
  const tickFeesBefore = feesSpentLamports;
  try {
    // Real + on-chain only. A paper vault has no PDA and no NAV to post;
    // a real row whose init_vault never landed has nothing to post to.
    const rows = await prisma.vault.findMany({
      where: { mode: "real", onchainVaultPda: { not: null } },
      select: { id: true, name: true, onchainVaultPda: true },
    });
    if (rows.length === 0) return;

    // Degrade instead of throwing when the keypair is absent (a deploy
    // without SOLANA_KEYPAIR_PATH is a legitimate read-only deployment).
    const key = tryGetNavKeeperKeypair();
    if ("error" in key) {
      console.warn(`[nav] no keeper keypair — cannot post NAV for ${rows.length} vault(s): ${key.error}`);
      return;
    }
    const keeper = key.keypair;
    const connection = getConnection();

    if (rentExemptMinimum === null) {
      rentExemptMinimum = BigInt(
        await connection.getMinimumBalanceForRentExemption(VAULT_ACCOUNT_BYTES),
      );
    }

    const balance = await getLamports(keeper.publicKey);
    if (balance < LOW_BALANCE_WARN_LAMPORTS) {
      console.warn(
        `[nav] keeper balance is ${lamportsToSol(balance)} SOL — ` +
          `~${balance / SIGNATURE_FEE_LAMPORTS} posts left before real vaults go stale`,
      );
    }

    const now = nowSec();
    let posted = 0;
    let skipped = 0;

    for (const row of rows) {
      if (warnedStaleLayout.has(row.id)) continue;
      // Each vault is isolated — one failure never kills the tick.
      try {
        const pda = new PublicKey(row.onchainVaultPda as string);
        const fetched = await fetchVaultAccount(connection, pda);
        if (!fetched) {
          console.warn(`[nav] ${row.id}: no account at ${pda.toBase58()} — nothing to mark`);
          skipped += 1;
          continue;
        }
        const v = fetched.data;
        const label = `${row.name} (${pda.toBase58().slice(0, 8)}…)`;

        // Posting with the wrong key is a guaranteed InvalidNavKeeper
        // revert; the platform admin has to rotate the keeper first.
        if (!v.navKeeper.equals(keeper.publicKey)) {
          console.warn(
            `[nav] ${label}: nav_keeper is ${v.navKeeper.toBase58()}, not this server ` +
              `(${keeper.publicKey.toBase58()}) — skipping, ask the admin to rotate it`,
          );
          skipped += 1;
          continue;
        }

        const age = now - v.navPostedAt;
        const decision = decideMark(v, BigInt(fetched.lamports), rentExemptMinimum);
        const dueAt = v.navStalenessSeconds - REFRESH_LEAD_SECONDS;
        const due = age >= dueAt;
        const changed = decision.targetLamports !== v.navLamports;

        console.log(
          `[nav] ${label}: nav=${lamportsToSol(v.navLamports)} SOL age=${age}s/` +
            `${v.navStalenessSeconds}s slot=${v.navSlot} status=${v.status}` +
            (decision.driftLamports === 0n
              ? " (lamports agree)"
              : ` (lamports imply ${lamportsToSol(decision.lamportsEquity)} SOL, ` +
                `drift ${decision.driftLamports > 0n ? "+" : ""}${decision.driftLamports} lamports — ` +
                "NOT acted on; see decideMark)"),
        );

        // Mirror the CHAIN back into the DB row every tick, whether or not
        // we post. Without this a real vault's page shows the paper
        // tvlSol/sharePriceSol columns (0.00) while the program holds real
        // SOL — the UI would be quietly lying about a live vault. The chain
        // is the source of truth for real vaults; these columns are a cache
        // of it so lists and sparklines cost no RPC.
        //   nav_lamports → SOL, and shares are 1e12 units per SOL (the
        //   1000x virtual-share offset), so divide to get SOL-equivalents.
        await syncOnChainVaultToDb(row.id, v);

        // Fresh AND unchanged ⇒ posting would burn a fee and a slot to
        // write the same number. Skip.
        if (!due && !changed) {
          skipped += 1;
          continue;
        }

        // mark_slot must be STRICTLY greater than the stored nav_slot and
        // no more than 750 slots behind execution. Confirmed commitment:
        // a processed slot can lead the execution slot and revert.
        const markSlot = await getConfirmedSlot();
        if (markSlot <= v.navSlot) {
          console.warn(
            `[nav] ${label}: confirmed slot ${markSlot} is not ahead of nav_slot ${v.navSlot} — ` +
              "retrying next tick (posting would revert NavSlotNotMonotonic)",
          );
          skipped += 1;
          continue;
        }

        const { nav: capped, clampedBy } = clampToDeltaCap(
          v.navLamports,
          decision.targetLamports,
          v.maxNavDeltaBps,
        );
        if (clampedBy > 0n) {
          console.warn(
            `[nav] ${label}: intended ${decision.targetLamports} lamports exceeds the ` +
              `${v.maxNavDeltaBps}bps per-post cap — CLAMPED to ${capped} ` +
              `(${clampedBy} lamports short; the remainder follows next tick)`,
          );
        }
        const navToPost = capped > MAX_NAV_LAMPORTS ? MAX_NAV_LAMPORTS : capped;

        if (navToPost < v.navLamports) {
          const loss = v.navLamports - navToPost;
          if (wouldTripDailyBreaker(v, loss, now)) {
            console.warn(
              `[nav] ${label}: this ${loss}-lamport down-mark trips the daily-loss breaker — ` +
                "the vault will be FROZEN by RiskBreaker and stop accepting deposits " +
                "(withdrawals keep working). Posting anyway: the breaker is a control, not a bug.",
            );
          }
        }

        const reason = due
          ? `age ${age}s >= ${dueAt}s (staleness ${v.navStalenessSeconds}s − ${REFRESH_LEAD_SECONDS}s lead)`
          : "mark changed";
        console.log(
          `[nav] ${label}: posting ${lamportsToSol(navToPost)} SOL at slot ${markSlot} — ${reason}`,
        );

        const ix = buildPostNavIx({
          vault: pda,
          keeper: keeper.publicKey,
          navLamports: navToPost,
          markSlot,
        });
        // The keeper signs; the server key pays. Keeping the fee payer
        // separate means the keeper wallet only ever needs to exist, not to
        // be funded, which is one less reason to touch it.
        const sent = await sendAndConfirm([ix], [keeper], { label: `post_nav(${row.id})` });

        const fee = BigInt(sent.feeLamports ?? Number(SIGNATURE_FEE_LAMPORTS));
        feesSpentLamports += fee;
        postsSent += 1;
        posted += 1;

        // Read the account back: the tx landing is not the claim — the
        // stored nav_slot / nav_posted_at moving is.
        const after = await fetchVaultAccount(connection, pda);
        console.log(
          `[nav] ${label}: POSTED ${sent.signature} (${fee} lamports) ${explorerTx(sent.signature)}`,
        );
        if (after) {
          console.log(
            `[nav] ${label}: nav_slot ${v.navSlot} → ${after.data.navSlot}, ` +
              `nav_posted_at ${v.navPostedAt} → ${after.data.navPostedAt} ` +
              `(age now ${nowSec() - after.data.navPostedAt}s), ` +
              `nav ${v.navLamports} → ${after.data.navLamports} lamports, ` +
              `status ${after.data.status} — depositable for another ${after.data.navStalenessSeconds}s`,
          );
        }
      } catch (err) {
        if (err instanceof StaleVaultLayoutError) {
          // Written by an older program layout: unreachable, unpriceable and
          // never coming back. Warn once per vault per process rather than
          // every tick, forever.
          if (!warnedStaleLayout.has(row.id)) {
            warnedStaleLayout.add(row.id);
            console.warn(
              `[nav] ${row.id}: skipping permanently — ${err.message}. ` +
                "Clear onchainVaultPda on this row to stop it being polled.",
            );
          }
        } else if (err instanceof OnChainError) {
          // NEVER let a bare Custom(6022) be the whole story: the Anchor
          // error name and the program's own log lines are the diagnosis.
          console.error(
            `[nav] ${row.id}: post_nav failed in ${err.phase} — ` +
              `AnchorError ${err.anchorErrorCode ?? "(none in logs)"}` +
              (err.signature ? ` sig ${err.signature}` : ""),
          );
          for (const line of err.logs) console.error(`[nav]   ${line}`);
        } else {
          console.error(`[nav] ${row.id}: NAV post failed:`, err);
        }
      }
    }

    const tickFees = feesSpentLamports - tickFeesBefore;
    console.log(
      `[nav] tick done — ${posted} posted, ${skipped} skipped, ${tickFees} lamports ` +
        `(${lamportsToSol(tickFees)} SOL) this tick; ${postsSent} posts / ` +
        `${lamportsToSol(feesSpentLamports)} SOL since boot`,
    );
  } catch (err) {
    console.error("[nav] tick failed:", err);
  } finally {
    tickRunning = false;
  }
}
