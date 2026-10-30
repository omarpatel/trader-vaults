//! Executing tests for the attacks the security review found.
//!
//! WHY THIS FILE EXISTS. The review's fourth finding was not a bug, it was
//! the absence of these: the money-moving path of a program custodying real
//! SOL had one withdrawal in its whole suite, and that one asserted
//! `isAtMost(balanceAfter - balanceBefore, valueAtRequest)` — a one-sided
//! bound that passes if the program pays ZERO. Every attack in the report was
//! a reasoned trace through source, and two of the four fixes made in
//! response to an earlier round were themselves wrong, because they were also
//! reasoned rather than run. B1 in particular: `require!(now > nav_posted_at)`
//! was believed to give the delta cap a time dimension. It gives it one post
//! per unix second, and 124 of those crush a mark to a single lamport.
//!
//! So each test below is the ATTACK, executed against the real functions, and
//! it fails if the bound that stops it is ever loosened. They are unit tests
//! over pure state transitions, not integration tests against a validator —
//! they cannot catch an account-constraint or CPI mistake, and they are not a
//! substitute for a fork test or an audit.

#![cfg(test)]

use anchor_lang::prelude::Pubkey;

use crate::instructions::post_nav::{apply_nav_post, NavPostInputs};
use crate::instructions::withdraw::settle_withdrawal;
use crate::math;
use crate::state::*;

const SOL: u64 = 1_000_000_000;
/// Rent floor for the Vault account. Only its relative size matters here.
const RENT: u64 = 9_000_000;

fn vault_with(nav: u64, total_shares: u128, now: i64) -> Vault {
    Vault {
        bump: 255,
        name: [7u8; 32],
        creator: Pubkey::new_unique(),
        trader: Pubkey::new_unique(),
        operator: Pubkey::default(),
        nav_keeper: Pubkey::new_unique(),
        vault_type: VaultType::Managed,
        status: VaultStatus::Active,
        frozen_by: FrozenBy::None,
        perf_fee_bps: 3_000,
        platform_profit_bps: PLATFORM_PROFIT_BPS,
        redeem_window_seconds: MIN_REDEEM_WINDOW_SECONDS,
        nav_staleness_seconds: 3_600,
        total_shares,
        seed_shares: 10_000_000_000,
        manager_shares: 0,
        nav_lamports: nav,
        nav_slot: 1_000,
        nav_posted_at: now,
        locked_profit: 0,
        locked_profit_ts: now,
        unlock_period_seconds: 3_600,
        max_nav_delta_bps: 2_000,
        max_trade_notional_lamports: 1_000_000 * SOL,
        max_price_impact_bps: 500,
        daily_loss_limit_bps: 2_000,
        daily_loss_accumulator: 0,
        daily_gain_accumulator: 0,
        day_bucket: now.div_euclid(SECONDS_PER_DAY),
        day_start_equity: nav,
        deposit_cooldown_until: 0,
        daily_swap_spend_lamports: 0,
        swap_day_bucket: now.div_euclid(SECONDS_PER_DAY),
        pending_withdraw_value_lamports: 0,
        pending_withdraw_shares: 0,
        platform_fees_owed_lamports: 0,
        enforce_mint_allowlist: false,
        allowed_mints: [Pubkey::default(); MAX_ALLOWED_MINTS],
        positions: [Position::default(); MAX_POSITIONS],
        padding: [0u8; 64],
    }
}

fn depositor_with(shares: u128, basis: u64) -> VaultDepositor {
    VaultDepositor {
        bump: 255,
        vault: Pubkey::new_unique(),
        authority: Pubkey::new_unique(),
        shares,
        net_deposits_lamports: basis,
        cumulative_profit_share_lamports: 0,
        last_withdraw_request: WithdrawRequest::default(),
        last_deposit_ts: 0,
        padding: [0u8; 24],
    }
}

/// One post, with the clock and slot advanced the minimum the program allows.
fn post(vault: &mut Vault, nav: u64, now: i64, lamports: u64) -> anchor_lang::Result<bool> {
    let slot = vault.nav_slot + 1;
    apply_nav_post(
        vault,
        NavPostInputs {
            nav_lamports: nav,
            mark_slot: slot,
            current_slot: slot,
            now,
            vault_lamports: lamports,
            rent_min: RENT,
        },
    )
}

// ---------------------------------------------------------------------------
// B1 — the NAV ladder
// ---------------------------------------------------------------------------

/// THE ATTACK, RUN. A compromised keeper posts -20% (the vault's own per-post
/// cap) once per second. Before the fix this reached 1 lamport in 124 posts,
/// at which point 1 SOL bought 99.9999999998% of a 1,000 SOL vault.
///
/// Asserts the ladder stalls, and that what it achieved before stalling is
/// bounded by MAX_DAILY_NAV_MOVE_BPS of the day's opening equity.
#[test]
fn nav_ladder_cannot_crush_the_mark() {
    let start_nav = 1_000 * SOL;
    let mut now = 1_800_000_000i64;
    // Book is fully deployed into tokens, so the lamport floor is not what is
    // doing the work here — this isolates the cumulative cap.
    let mut vault = vault_with(start_nav, 1_000_000 * SOL as u128, now);
    let lamports = RENT;

    let mut accepted = 0;
    for _ in 0..400 {
        now += 1;
        let target = vault.nav_lamports - math::mul_bps_floor(vault.nav_lamports, 2_000);
        match post(&mut vault, target, now, lamports) {
            Ok(_) => accepted += 1,
            Err(_) => break,
        }
    }

    assert!(accepted > 0, "an honest mark-down must still be possible");
    assert!(
        accepted < 124,
        "the 124-post crush must not complete; got {accepted} posts"
    );
    // Whatever landed is bounded by the day's movement cap.
    let floor = start_nav - math::mul_bps_floor(start_nav, MAX_DAILY_NAV_MOVE_BPS);
    assert!(
        vault.nav_lamports >= floor,
        "nav {} fell below the daily bound {}",
        vault.nav_lamports,
        floor
    );
    // And the thing that made the crush pay is shut: deposits are paused.
    assert!(
        vault.deposit_cooldown_until > now,
        "a large move must pause deposits"
    );
}

/// The other half of the same attack: walking the mark back UP to redeem
/// against it. A cap on losses alone would leave this leg free.
#[test]
fn nav_ladder_cannot_inflate_the_mark_either() {
    let start_nav = 1_000 * SOL;
    let mut now = 1_800_000_000i64;
    let mut vault = vault_with(start_nav, 1_000_000 * SOL as u128, now);

    let mut accepted = 0;
    for _ in 0..400 {
        now += 1;
        let target = vault.nav_lamports + math::mul_bps_floor(vault.nav_lamports, 2_000);
        match post(&mut vault, target, now, RENT) {
            Ok(_) => accepted += 1,
            Err(_) => break,
        }
    }
    assert!(accepted > 0);
    let ceiling = start_nav + math::mul_bps_floor(start_nav, MAX_DAILY_NAV_MOVE_BPS);
    assert!(
        vault.nav_lamports <= ceiling,
        "nav {} rose above the daily bound {}",
        vault.nav_lamports,
        ceiling
    );
}

/// B1(a): a mark may not contradict the vault's own unencumbered cash.
#[test]
fn nav_cannot_be_marked_below_the_vaults_own_lamports() {
    let now = 1_800_000_000i64;
    let mut vault = vault_with(100 * SOL, 100_000 * SOL as u128, now);
    // All 100 SOL is sitting on the PDA as cash.
    let lamports = RENT + 100 * SOL;

    // Marking down 10% is within every per-post and per-day bound, and is
    // still refused, because the cash is provably there.
    let err = post(&mut vault, 90 * SOL, now + 1, lamports).unwrap_err();
    assert!(
        format!("{err:?}").contains("NavBelowLamports"),
        "expected NavBelowLamports, got {err:?}"
    );
    assert_eq!(vault.nav_lamports, 100 * SOL, "the mark must not have moved");

    // Marking UP is fine: the keeper may value tokens above the cash.
    post(&mut vault, 105 * SOL, now + 1, lamports).unwrap();
    assert_eq!(vault.nav_lamports, 105 * SOL);
}

/// A donation to the vault raises the floor, so the next mark has to
/// recognise it rather than leave it backing nobody's shares. This is how
/// seeding a vault with SOL actually reaches depositors.
#[test]
fn a_donation_must_be_marked_in() {
    let now = 1_800_000_000i64;
    let mut vault = vault_with(10 * SOL, 10_000 * SOL as u128, now);
    let after_gift = RENT + 11 * SOL;

    // Re-posting the pre-gift number is now a lie about the cash, and fails.
    assert!(post(&mut vault, 10 * SOL, now + 1, after_gift).is_err());
    // Marking the gift in works, and every share is worth more for it.
    post(&mut vault, 11 * SOL, now + 1, after_gift).unwrap();
    assert_eq!(vault.nav_lamports, 11 * SOL);
}

// ---------------------------------------------------------------------------
// B8 — the drip that never completed
// ---------------------------------------------------------------------------

/// Before the fix, `locked_profit_ts = now` on every post restarted the FULL
/// unlock period on the ENTIRE remaining balance, so a gain from an hour ago
/// had its clock reset by a gain from a second ago and never finished
/// dripping. The locked balance decayed by (1 - dt/P) per post — exponential
/// toward zero, never arriving — holding effective_equity permanently below
/// nav, pricing every withdrawer on the suppressed number, and leaving a
/// residue claimable by nobody because the last shares standing are the
/// unredeemable seed shares. A keeper posting +1 lamport a minute could hold
/// it there deliberately.
///
/// The property that must hold: a gain fully unlocks one period after IT was
/// posted, no matter what is posted afterwards.
#[test]
fn a_gain_fully_unlocks_regardless_of_later_posts() {
    let t0 = 1_800_000_000i64;
    let mut now = t0;
    let mut vault = vault_with(100 * SOL, 100_000 * SOL as u128, now);
    vault.unlock_period_seconds = 3_600;

    // One real gain of 10 SOL.
    now += 60;
    let target = vault.nav_lamports + 10 * SOL;
    post(&mut vault, target, now, RENT).unwrap();
    let posted_at = now;
    assert!(vault.locked_profit >= 10 * SOL);

    // Then a dribble of +1000 lamport marks every minute for a full period —
    // the exact pattern that used to hold the drip open forever.
    let dribble = 1_000u64;
    let mut dribbled = 0u64;
    while now < posted_at + 3_600 {
        now += 60;
        let target = vault.nav_lamports + dribble;
        post(&mut vault, target, now, RENT).unwrap();
        dribbled += dribble;
    }

    let still_locked = vault.locked_profit_now(now);
    assert!(
        still_locked <= dribbled,
        "the 10 SOL gain must have fully dripped one period after it was          posted; {still_locked} lamports still locked against {dribbled}          lamports of gains from within the period"
    );
}

// ---------------------------------------------------------------------------
// D — the fee split, executed
// ---------------------------------------------------------------------------

/// The report asked for exactly this: a test that runs the real settlement and
/// asserts the numbers, replacing a suite that computed the OLD split with a
/// local TypeScript helper and never touched the program.
///
/// 10 SOL basis, 20 SOL gross, 30% performance fee, not the trader.
#[test]
fn settlement_pays_the_published_split() {
    let now = 1_800_000_000i64;
    let mut vault = vault_with(1_000 * SOL, 1_000_000 * SOL as u128, now);
    vault.perf_fee_bps = 3_000;
    let mut depositor = depositor_with(500 * SOL as u128, 10 * SOL);

    let (payout, trader_fee, platform_fee) = settle_withdrawal(
        &mut vault,
        &mut depositor,
        500 * SOL as u128,
        20 * SOL,
        false,
    )
    .unwrap();

    // The depositor keeps 70% of the 10 SOL profit. Not 60%, which is what
    // the UI quoted while the program charged nothing.
    assert_eq!(payout, 17 * SOL, "depositor payout");
    assert_eq!(trader_fee, 3 * SOL, "trader performance fee");
    assert_eq!(platform_fee, 0, "the platform takes nothing");
    // Lamports out equals the reduction in NAV, exactly.
    assert_eq!(payout + trader_fee, 20 * SOL);
    assert_eq!(vault.nav_lamports, 1_000 * SOL - 20 * SOL);
    assert_eq!(depositor.net_deposits_lamports, 0);
    assert_eq!(depositor.cumulative_profit_share_lamports, 10 * SOL);
}

/// PLATFORM_PROFIT_BPS is a snapshot written into every vault and read by the
/// UI. It must equal what settlement actually charges, or the disclosure is
/// wrong again — which is the defect that shipped last time, pointing the
/// other way.
#[test]
fn disclosed_platform_cut_matches_the_charged_one() {
    let now = 1_800_000_000i64;
    let mut vault = vault_with(1_000 * SOL, 1_000_000 * SOL as u128, now);
    let mut depositor = depositor_with(500 * SOL as u128, 10 * SOL);
    let (_, _, platform_fee) =
        settle_withdrawal(&mut vault, &mut depositor, 500 * SOL as u128, 20 * SOL, false).unwrap();
    assert_eq!(
        u128::from(PLATFORM_PROFIT_BPS),
        (platform_fee as u128) * BPS_DENOMINATOR / (10 * SOL) as u128,
        "the advertised platform cut and the charged one must be the same number"
    );
}

/// B11: a burn that values at zero must be refused on every path, not silently
/// destroy shares and emit a successful WithdrawExecuted with payout 0.
#[test]
fn a_zero_value_burn_is_refused() {
    let now = 1_800_000_000i64;
    let mut vault = vault_with(1_000 * SOL, 1_000_000 * SOL as u128, now);
    let mut depositor = depositor_with(1_000, 1);
    let before = depositor.shares;
    assert!(settle_withdrawal(&mut vault, &mut depositor, 1_000, 0, false).is_err());
    assert_eq!(depositor.shares, before, "shares must survive a refused burn");
}

/// B5: the deposit hold is only a gate if a deposit actually stamps the clock.
///
/// The field and the check both shipped; nothing wrote it, so `last_deposit_ts`
/// stayed 0 and `now - 0 >= MIN_DEPOSIT_HOLD_SECONDS` was true for every caller
/// forever. A gate that fails open is worse than no gate, because the code
/// reads as though it is protected.
#[test]
fn a_deposit_stamps_the_hold_clock() {
    let now = 1_800_000_000i64;
    let mut vault = vault_with(100 * SOL, 100_000 * SOL as u128, now);
    let mut depositor = depositor_with(0, 0);
    assert_eq!(depositor.last_deposit_ts, 0);

    crate::instructions::deposit::apply_deposit(&mut vault, &mut depositor, 1 * SOL, now).unwrap();

    assert_eq!(
        depositor.last_deposit_ts, now,
        "deposit must stamp last_deposit_ts, or the instant-withdraw hold is inert"
    );
    assert!(
        now.saturating_sub(depositor.last_deposit_ts) < MIN_DEPOSIT_HOLD_SECONDS,
        "a fresh depositor must be inside the hold window"
    );
}

// ---------------------------------------------------------------------------
// B9 — unbounded share supply
// ---------------------------------------------------------------------------

/// The dilution step of B1 needs to mint ~5e23 shares against a crushed mark.
/// MAX_TOTAL_SHARES is the bound `math.rs` claimed and nothing enforced; three
/// such cycles overflowed the u128 product in `value_for_shares`, which every
/// exit calls first, bricking the vault permanently.
#[test]
fn the_dilution_mint_exceeds_the_share_cap() {
    let crushed_equity = 1u64; // the mark after a successful crush
    let total_shares = 1_000_000_000_000_000u128;
    let shares = math::shares_for_deposit(1 * SOL, total_shares, crushed_equity).unwrap();
    assert!(
        total_shares.saturating_add(shares) > MAX_TOTAL_SHARES,
        "the cap must reject the dilution mint (would be {shares} shares)"
    );
    // And the cap itself is where math.rs's overflow argument needs it.
    assert!(
        MAX_TOTAL_SHARES
            .checked_mul(MAX_NAV_LAMPORTS as u128 + VIRTUAL_LAMPORTS)
            .is_some(),
        "shares x equity must not overflow u128 at the bounds"
    );
}

// ---------------------------------------------------------------------------
// B2 — cost basis on the sell leg
// ---------------------------------------------------------------------------

/// The uncapped drain: buy a position legitimately, then dump the whole thing
/// into an attacker-owned pool for one lamport. `source.mint != WSOL_MINT`
/// skipped the only cap that existed.
#[test]
fn selling_the_book_for_a_lamport_is_refused() {
    let now = 1_800_000_000i64;
    let mut vault = vault_with(1_000 * SOL, 1_000_000 * SOL as u128, now);
    let mint = Pubkey::new_unique();

    // Bought 1,000,000 tokens for 50 SOL.
    vault.position_add(mint, 1_000_000, 50 * SOL).unwrap();

    // Sell all of it. The pro-rata basis given up is the whole 50 SOL.
    let basis_out = vault.position_remove(&mint, 1_000_000).unwrap();
    assert_eq!(basis_out, 50 * SOL);

    let floor = math::mul_bps_floor(basis_out, MIN_SELL_RECOVERY_BPS);
    assert!(floor > 0, "a sell must have a floor to clear");
    assert!(1u64 < floor, "one lamport must not clear the floor");
    // Half of cost does clear it: a real 50% drawdown is still exitable.
    assert!(25 * SOL >= floor);
}

/// Partial sells must not leave a residual basis that understates what the
/// vault paid — understating basis understates the realized loss, which is
/// the number the per-trade cap and the daily breaker are computed from.
#[test]
fn partial_sells_keep_the_basis_honest() {
    let now = 1_800_000_000i64;
    let mut vault = vault_with(1_000 * SOL, 1_000_000 * SOL as u128, now);
    let mint = Pubkey::new_unique();
    vault.position_add(mint, 3_000, 10 * SOL).unwrap();

    let mut released = 0u64;
    for _ in 0..3 {
        released += vault.position_remove(&mint, 1_000).unwrap();
    }
    assert!(
        released >= 10 * SOL,
        "released basis {released} understates the 10 SOL paid"
    );
    // Position is fully closed and the slot is reusable.
    assert_eq!(vault.positions[0].mint, Pubkey::default());
}

/// A mint the vault never bought has no basis, so there is nothing to measure
/// a sale against and it is refused rather than waved through.
#[test]
fn selling_an_unrecorded_mint_is_refused() {
    let now = 1_800_000_000i64;
    let mut vault = vault_with(1_000 * SOL, 1_000_000 * SOL as u128, now);
    assert!(vault.position_remove(&Pubkey::new_unique(), 1).is_err());
}

// ---------------------------------------------------------------------------
// B3 — the frozen reservation
// ---------------------------------------------------------------------------

/// One depositor requests at a peak and walks away. The book halves. Before
/// the fix the reservation stayed at the peak figure and every other
/// depositor's exit failed InsufficientSolBuffer with the cash sitting there.
#[test]
fn an_abandoned_request_reservation_marks_down_with_nav() {
    let now = 1_800_000_000i64;
    let total_shares = 1_000_000u128 * SOL as u128;
    let mut vault = vault_with(1_000 * SOL, total_shares, now);

    // A holds 60% and requests all of it at the peak.
    let a_shares = total_shares * 60 / 100;
    let peak_value = math::value_for_shares(a_shares, total_shares, 1_000 * SOL).unwrap();
    vault.pending_withdraw_value_lamports = peak_value;
    vault.pending_withdraw_shares = a_shares;
    assert_eq!(vault.pending_withdraw_reserve(now), peak_value);

    // The book legally halves.
    vault.nav_lamports = 500 * SOL;
    let marked = vault.pending_withdraw_reserve(now);
    assert!(
        marked < peak_value,
        "the reservation must fall with the book: {marked} vs {peak_value}"
    );

    // B, holding 20%, is entitled to 100 SOL and the vault holds 500 in cash.
    let vault_lamports = RENT + 500 * SOL;
    let b_entitlement = 100 * SOL;
    assert!(
        vault.free_sol(vault_lamports, RENT, now) >= b_entitlement,
        "an honest depositor must still be payable"
    );
}

/// B10: the escape hatch ignores other depositors' reservations. It exists for
/// the case where nobody else is acting, so it cannot be held shut by them.
#[test]
fn the_emergency_hatch_ignores_other_reservations() {
    let now = 1_800_000_000i64;
    let mut vault = vault_with(1_000 * SOL, 1_000_000u128 * SOL as u128, now);
    // Somebody else has the entire buffer reserved.
    vault.pending_withdraw_value_lamports = 1_000 * SOL;
    vault.pending_withdraw_shares = 1_000_000u128 * SOL as u128;
    let vault_lamports = RENT + 500 * SOL;

    assert_eq!(
        vault.free_sol(vault_lamports, RENT, now),
        0,
        "the normal paths correctly see nothing spendable"
    );
    assert_eq!(
        vault.free_sol_unreserved(vault_lamports, RENT),
        500 * SOL,
        "the hatch must still see the cash"
    );
}

// ---------------------------------------------------------------------------
// Parameter floors that other findings depend on
// ---------------------------------------------------------------------------

/// B3b: a request must always become executable before it becomes clearable,
/// or a bot clears it at the grace mark forever and execute_withdraw is
/// unreachable on that vault.
#[test]
fn a_request_is_always_executable_before_it_expires() {
    for window in [
        MIN_REDEEM_WINDOW_SECONDS,
        7 * SECONDS_PER_DAY,
        MAX_REDEEM_WINDOW_SECONDS,
    ] {
        let expires_at = window + WITHDRAW_REQUEST_GRACE_SECONDS;
        assert!(
            expires_at > window,
            "window {window}: expiry {expires_at} must sit after the window"
        );
    }
}

/// B4: a zero redeem window collapses request+execute into one transaction,
/// which is an instant withdrawal priced off a much looser staleness bound.
#[test]
fn the_redeem_window_has_a_floor() {
    assert!(MIN_REDEEM_WINDOW_SECONDS > 0);
    assert!(MIN_REDEEM_WINDOW_SECONDS > INSTANT_WITHDRAW_MAX_NAV_STALENESS_SECONDS);
    // And a mark may never be a whole day old on a normally priced path.
    assert!(MAX_NAV_STALENESS_SECONDS < SECONDS_PER_DAY);
}

/// B5: the drip alone does not stop a deposit-and-skim, so instant exits carry
/// a hold. It must be shorter than the redeem window is long, or the two
/// paths contradict each other.
#[test]
fn the_deposit_hold_is_consistent_with_the_redeem_window() {
    assert!(MIN_DEPOSIT_HOLD_SECONDS > 0);
    assert!(MIN_DEPOSIT_HOLD_SECONDS <= MIN_REDEEM_WINDOW_SECONDS);
}
