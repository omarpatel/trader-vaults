//! NAV keeper marks. Audit surface #2 (NAV bounds).
//!
//! The keeper is trusted to VALUE the book, but the program clamps how much
//! damage a compromised keeper can do per post:
//!   - only the appointed keeper key may post,
//!   - the mark's slot must be monotonic, not in the future, and recent,
//!   - |delta| per post is capped at max_nav_delta_bps of the previous NAV,
//!   - increases do not hit share pricing immediately — they drip in through
//!     the Meteora-style locked-profit unlock,
//!   - decreases hit share pricing IMMEDIATELY (losses are never smoothed —
//!     smoothing a loss would let withdrawers exit above fair value at the
//!     expense of everyone remaining),
//!   - keeper-posted losses feed the daily circuit breaker, which freezes
//!     TRADING (never withdrawals) when breached.
//!
//! Note on flows: nav_lamports is program-adjusted for deposits/withdrawals
//! between posts, so the keeper must always mark from current on-chain
//! holdings, not from its previous mark (a mark computed before a deposit
//! landed will look like a large negative delta and be rejected by the cap —
//! the correct failure mode).

use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::state::*;

#[derive(Accounts)]
pub struct PostNav<'info> {
    // vault is declared before keeper so the keeper's address constraint can
    // reference it (constraint expressions should only look "up" the struct).
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.creator.as_ref(), vault.name.as_ref()],
        bump = vault.bump
    )]
    pub vault: Box<Account<'info, Vault>>,

    #[account(address = vault.nav_keeper @ VaultError::InvalidNavKeeper)]
    pub keeper: Signer<'info>,
}

pub fn handle_post_nav(ctx: Context<PostNav>, nav_lamports: u64, mark_slot: u64) -> Result<()> {
    let clock = Clock::get()?;
    let vault_ai = ctx.accounts.vault.to_account_info();
    let vault_lamports = vault_ai.lamports();
    let rent_min = Rent::get()?.minimum_balance(vault_ai.data_len());
    let vault = &mut ctx.accounts.vault;

    let tripped = apply_nav_post(
        vault,
        NavPostInputs {
            nav_lamports,
            mark_slot,
            current_slot: clock.slot,
            now: clock.unix_timestamp,
            vault_lamports,
            rent_min,
        },
    )?;

    emit!(NavPosted {
        vault: vault.key(),
        nav_lamports,
        nav_slot: mark_slot,
        locked_profit: vault.locked_profit,
        daily_loss_accumulator: vault.daily_loss_accumulator,
        deposit_cooldown_until: vault.deposit_cooldown_until,
        frozen_by_breaker: tripped,
    });
    Ok(())
}

/// Everything `post_nav` does to the vault, with no Context and no sysvars.
///
/// Split out so it can be EXECUTED by a test. The review that found B1 also
/// found that this program's money-moving logic had effectively no executing
/// coverage - one withdrawal in the whole suite, asserting a one-sided bound
/// that passes if the program pays zero - and that every attack in it was a
/// reasoned trace through source rather than a demonstrated exploit. The
/// ladder that crushed NAV to one lamport in 124 seconds is now a test
/// (`nav_ladder_cannot_crush_the_mark`) that fails if this bound is ever
/// loosened again.
pub struct NavPostInputs {
    pub nav_lamports: u64,
    pub mark_slot: u64,
    pub current_slot: u64,
    pub now: i64,
    pub vault_lamports: u64,
    pub rent_min: u64,
}

/// Returns true when this post tripped the circuit breaker.
pub fn apply_nav_post(vault: &mut Vault, input: NavPostInputs) -> Result<bool> {
    let NavPostInputs {
        nav_lamports,
        mark_slot,
        current_slot,
        now,
        vault_lamports,
        rent_min,
    } = input;

    // ---- mark recency / monotonicity -------------------------------------
    require!(mark_slot > vault.nav_slot, VaultError::NavSlotNotMonotonic);
    require!(mark_slot <= current_slot, VaultError::NavSlotNotMonotonic);
    require!(
        current_slot.saturating_sub(mark_slot) <= MAX_NAV_MARK_AGE_SLOTS,
        VaultError::NavMarkTooOld
    );
    require!(nav_lamports <= MAX_NAV_LAMPORTS, VaultError::NavCapExceeded);

    // Time must advance between posts. Necessary, and nowhere near
    // sufficient on its own - see the cumulative bound below.
    require!(now > vault.nav_posted_at, VaultError::NavSlotNotMonotonic);

    // ---- B1(a): the mark may not contradict the vault's own cash ----------
    //
    // NAV is the keeper's opinion of what the book is worth. The SOL sitting
    // on the vault PDA is not an opinion: it is worth its face value, it is
    // unencumbered except for rent and fees already owed to the treasury, and
    // the keeper cannot make it smaller. So a mark below it is provably
    // wrong, and refusing those costs an honest keeper nothing.
    //
    // This is what stops the crush. Walking a mark down to 1 lamport is only
    // possible while the vault holds no cash; the moment depositor SOL is
    // sitting there, the floor moves with it.
    //
    // Deliberately NOT subtracting pending withdrawal reservations: those
    // lamports still back live shares until the payout executes, so they are
    // part of NAV.
    //
    // Side effect, and a wanted one: a plain lamport donation to the vault
    // raises the floor, so the next mark must recognise the donation instead
    // of quietly leaving it unattributed to any share.
    let lamport_floor = vault_lamports
        .saturating_sub(rent_min)
        .saturating_sub(vault.platform_fees_owed_lamports);
    require!(nav_lamports >= lamport_floor, VaultError::NavBelowLamports);

    // ---- per-post delta cap ----------------------------------------------
    let old_nav = vault.nav_lamports;
    let delta_cap = crate::math::mul_bps_floor(old_nav, vault.max_nav_delta_bps);
    let (gain, loss) = if nav_lamports >= old_nav {
        (nav_lamports - old_nav, 0u64)
    } else {
        (0u64, old_nav - nav_lamports)
    };
    require!(gain.max(loss) <= delta_cap, VaultError::NavDeltaTooLarge);

    // ---- daily buckets ----------------------------------------------------
    // Roll the UTC day BEFORE applying this post, so day_start_equity is the
    // equity the day opened with.
    let today = now.div_euclid(SECONDS_PER_DAY);
    if vault.day_bucket != today {
        vault.day_bucket = today;
        vault.daily_loss_accumulator = 0;
        vault.daily_gain_accumulator = 0;
        vault.day_start_equity = vault.effective_equity(now);
    }

    // ---- B1(b): cumulative daily movement cap -----------------------------
    //
    // The per-post cap is a percentage of the PREVIOUS mark, so it composes:
    // each post shrinks the base for the next one and the sequence converges
    // to zero geometrically. The only brake was one post per unix second,
    // which bounds nothing that matters - 124 posts is 124 seconds.
    //
    // This bounds the day's total instead. Both directions, because the
    // attack needs to walk the mark back UP before it can redeem, and a cap
    // on losses alone would leave that half free.
    //
    // Measured against the day's OPENING equity, which no post inside the day
    // can move, so it cannot be ratcheted the way the per-post base can.
    let move_cap = vault.daily_nav_move_cap();
    let projected_loss = vault
        .daily_loss_accumulator
        .checked_add(loss)
        .ok_or(VaultError::MathOverflow)?;
    let projected_gain = vault
        .daily_gain_accumulator
        .checked_add(gain)
        .ok_or(VaultError::MathOverflow)?;
    require!(
        projected_loss <= move_cap && projected_gain <= move_cap,
        VaultError::DailyNavMoveExceeded
    );

    // ---- route the delta --------------------------------------------------
    let remaining_locked = vault.locked_profit_now(now);
    if gain > 0 {
        // Meteora relock: still-locked remainder + the new gain drip in
        // together. Depositors/withdrawers price against nav - locked, so the
        // gain phases into the share price over unlock_period_seconds instead
        // of being sandwichable.
        //
        // B8 - the clock is advanced PROPORTIONALLY, not reset to now.
        //
        // Resetting it restarted the full unlock period on the entire
        // remaining balance every single post. With posts every dt and period
        // P the locked balance is multiplied by (1 - dt/P) each time:
        // exponential decay toward zero that never arrives. Simulated at
        // P = 7 days and a post every 60 s, locked_profit converged to
        // profit_rate * P and sat there forever - effective_equity
        // permanently ~2% under nav_lamports, every withdrawer priced on the
        // suppressed number, and the residue claimable by nobody because the
        // last shares standing are the unredeemable seed shares. A keeper
        // posting +1 lamport a minute could hold it there on purpose.
        //
        // The blend below preserves the elapsed fraction the old balance had
        // already earned: the new timestamp is set back from `now` by the
        // share of the schedule that balance has already served.
        let new_locked = remaining_locked
            .checked_add(gain)
            .ok_or(VaultError::MathOverflow)?;
        let period = vault.unlock_period_seconds.max(1) as u128;
        let elapsed_of_old = {
            let e = now.saturating_sub(vault.locked_profit_ts).max(0) as u128;
            e.min(period)
        };
        // credit = elapsed_of_old * remaining_locked / new_locked
        let credit = if new_locked == 0 {
            0u128
        } else {
            elapsed_of_old
                .checked_mul(remaining_locked as u128)
                .ok_or(VaultError::MathOverflow)?
                / (new_locked as u128)
        };
        vault.locked_profit = new_locked;
        vault.locked_profit_ts = now.saturating_sub(credit as i64);
        vault.daily_gain_accumulator = projected_gain;
    } else {
        // Losses: locked profit is NOT used to absorb the loss (that would
        // hold the share price up artificially). We only clamp so that
        // effective equity (nav - locked) can never underflow below zero.
        let clamped = remaining_locked.min(nav_lamports);
        // A flat post (gain == 0, loss == 0) with the balance unchanged must
        // not touch the clock at all - that was the other half of B8.
        if clamped != vault.locked_profit {
            vault.locked_profit = clamped;
            // The balance shrank; the schedule it was on is re-baselined to
            // whatever remains of the current period.
            let period = vault.unlock_period_seconds.max(1);
            let elapsed = now.saturating_sub(vault.locked_profit_ts).max(0).min(period);
            vault.locked_profit_ts = now.saturating_sub(elapsed);
        }
        if loss > 0 {
            vault.daily_loss_accumulator = projected_loss;
        }
    }

    vault.nav_lamports = nav_lamports;
    vault.nav_slot = mark_slot;
    vault.nav_posted_at = now;

    // ---- B1(c): a large move pauses DEPOSITS (never withdrawals) ----------
    //
    // Crushing a mark is only worth doing if you can then buy at the crushed
    // price - step 2 is the entire attack. A move of this size is either real
    // news, in which case an hour's pause before minting shares against it is
    // correct, or someone walking the mark, in which case the pause is the
    // defence. Either way nobody's exit is affected: no withdrawal path reads
    // this field.
    let large_move = crate::math::mul_bps_floor(old_nav, LARGE_NAV_MOVE_BPS);
    if gain.max(loss) > large_move {
        vault.deposit_cooldown_until = now.saturating_add(DEPOSIT_COOLDOWN_SECONDS);
    }

    // ---- circuit breaker --------------------------------------------------
    // Freezes TRADING only. Withdrawals ignore status by construction.
    let mut tripped = false;
    if vault.status == VaultStatus::Active && vault.daily_loss_breached(now) {
        vault.status = VaultStatus::Frozen;
        vault.frozen_by = FrozenBy::RiskBreaker;
        tripped = true;
    }

    Ok(tripped)
}
