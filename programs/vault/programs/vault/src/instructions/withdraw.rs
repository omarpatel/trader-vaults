//! Withdrawal family: request -> (redeem window) -> execute, plus
//! instant_withdraw when the SOL buffer covers it, plus cancel, plus the
//! permissionless stale-NAV escape hatch emergency_withdraw.
//!
//! INVARIANT (custody): these are the ONLY instructions in the whole program
//! that move lamports from the vault to a non-vault account, and the only
//! recipients are (a) the withdrawing depositor and (b) the vault's trader,
//! for the performance fee crystallized by that same withdrawal.
//!
//! INVARIANT (liveness): nothing here checks VaultStatus or the platform kill
//! switch. A frozen/closed/killed vault can always be withdrawn from. The
//! normally priced paths additionally gate on NAV freshness (spec), and the
//! platform can restore freshness by rotating the NAV keeper
//! (platform.rs::set_nav_keeper) — but withdrawal ENTITLEMENT must not depend
//! on anyone choosing to act, so `emergency_withdraw` opens once the mark has
//! been stale for NAV_EMERGENCY_GRACE_SECONDS and needs no keeper, no admin
//! and no trader. Between them, no combination of keeper, trader and platform
//! inaction can hold a depositor's shares hostage.
//!
//! PROFIT-SHARE SCHEME (documented deviation from full-position Drift
//! crystallization): fees are crystallized on the WITHDRAWN PORTION using its
//! pro-rata cost basis, and paid FROM PROCEEDS:
//!
//! ```text
//! basis  = net_deposits * shares_withdrawn / depositor_shares   (floor)
//! profit = max(0, gross_payout - basis)
//! trader fee   = profit * perf_fee_bps / 10_000                 (floor)
//! platform fee = 0 — the platform takes no cut of profit
//! ```
//!
//! WHY the deviation: Drift crystallizes unrealized profit on the FULL
//! position at withdrawal time and settles the fee in shares. With
//! fee-from-proceeds (spec's chosen settlement), full-position crystallization
//! can produce a fee larger than the proceeds of a small partial withdrawal.
//! Realizing per-portion keeps fee <= proceeds ALWAYS, charges each share
//! cohort's profit exactly once (at exit), and preserves high-water behavior:
//! a position that round-trips down and back to its basis pays zero fee.
//! `cumulative_profit_share_lamports` still ratchets up with every
//! crystallized profit as the per-depositor lifetime record (Drift-pattern
//! bookkeeping, used off-chain and by audits).

use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::math;
use crate::state::*;

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct WithdrawRequestOp<'info> {
    pub authority: Signer<'info>,

    #[account(mut, seeds = [VAULT_SEED, vault.creator.as_ref(), vault.name.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        mut,
        seeds = [VAULT_DEPOSITOR_SEED, vault.key().as_ref(), authority.key().as_ref()],
        bump = depositor.bump,
    )]
    pub depositor: Box<Account<'info, VaultDepositor>>,
}

/// Clearing an EXPIRED request needs a context where the depositor account is
/// passed directly rather than derived from the signer — WithdrawRequestOp
/// seeds the PDA on `authority.key()`, so a third party signing there resolves
/// a different account entirely and can never reach the abandoned one.
#[derive(Accounts)]
pub struct ClearExpiredRequest<'info> {
    /// Anyone. Pays the fee, gains nothing.
    pub cranker: Signer<'info>,

    #[account(mut, seeds = [VAULT_SEED, vault.creator.as_ref(), vault.name.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,

    /// Seeded on the depositor's OWN authority, so the account cannot be
    /// substituted for one belonging to a different vault or user.
    #[account(
        mut,
        seeds = [VAULT_DEPOSITOR_SEED, vault.key().as_ref(), depositor.authority.as_ref()],
        bump = depositor.bump,
        has_one = vault @ VaultError::Unauthorized,
    )]
    pub depositor: Box<Account<'info, VaultDepositor>>,
}

#[derive(Accounts)]
pub struct ExecuteWithdraw<'info> {
    /// Receives the payout lamports. Must sign: only the depositor can
    /// trigger (and thereby time) their own withdrawal.
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(mut, seeds = [VAULT_SEED, vault.creator.as_ref(), vault.name.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        mut,
        seeds = [VAULT_DEPOSITOR_SEED, vault.key().as_ref(), authority.key().as_ref()],
        bump = depositor.bump,
    )]
    pub depositor: Box<Account<'info, VaultDepositor>>,

    /// CHECK: pinned to the vault's trader wallet; receives the crystallized
    /// performance fee. NOTE: if this wallet somehow held zero lamports, a
    /// dust fee below rent-exemption would fail the runtime rent check — in
    /// practice the trader wallet is the funded vault creator.
    #[account(mut, address = vault.trader @ VaultError::InvalidTraderAccount)]
    pub trader: UncheckedAccount<'info>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Move lamports out of the program-owned vault PDA. The system program
/// cannot transfer from an account with data, so this is the canonical
/// direct-lamport-manipulation pattern; the runtime permits the debit because
/// this program owns the vault account.
pub(crate) fn pay_from_vault<'info>(
    vault_ai: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let new_vault = vault_ai
        .lamports()
        .checked_sub(amount)
        .ok_or(VaultError::InsufficientSolBuffer)?;
    let new_to = to
        .lamports()
        .checked_add(amount)
        .ok_or(VaultError::MathOverflow)?;
    **vault_ai.try_borrow_mut_lamports()? = new_vault;
    **to.try_borrow_mut_lamports()? = new_to;
    Ok(())
}

/// Drop a request's hold on the vault's free SOL. Every path that ends a
/// request goes through here so the two counters can never drift.
fn release_reservation(vault: &mut Vault, req: &WithdrawRequest) -> Result<()> {
    vault.pending_withdraw_value_lamports = vault
        .pending_withdraw_value_lamports
        .checked_sub(req.value_at_request_lamports)
        .ok_or(VaultError::MathOverflow)?;
    vault.pending_withdraw_shares = vault
        .pending_withdraw_shares
        .checked_sub(req.shares)
        .ok_or(VaultError::MathOverflow)?;
    Ok(())
}

/// Crystallize fees for `shares_w` being withdrawn at gross value `gross`,
/// and apply all share/NAV bookkeeping. Returns (payout, trader_fee,
/// platform_fee). Lamports are NOT moved here.
pub fn settle_withdrawal(
    vault: &mut Vault,
    depositor: &mut VaultDepositor,
    shares_w: u128,
    gross: u64,
    is_trader: bool,
) -> Result<(u64, u64, u64)> {
    require!(shares_w > 0, VaultError::InsufficientShares);
    require!(shares_w <= depositor.shares, VaultError::InsufficientShares);
    // B11: refuse a burn that pays nothing.
    //
    // `instant_withdraw` was missing the `gross > 0` guard its two siblings
    // both had, and `value_for_shares` floors: at the genesis price of 1000
    // shares per lamport, any burn under ~1000 shares values at zero. The
    // shares were destroyed, total_shares decremented and the pro-rata cost
    // basis deducted, for nothing, in a SUCCESSFUL transaction emitting a
    // WithdrawExecuted with payout_lamports: 0. After a heavy loss the
    // window widens a long way. The guard lives here now so no future
    // withdrawal path can be added without it.
    require!(gross > 0, VaultError::InvalidParameter);

    // Pro-rata cost basis of the withdrawn shares.
    // ROUNDING: floor -> basis low -> profit high -> fee never undercharged.
    let basis = math::proportional_floor(depositor.net_deposits_lamports, shares_w, depositor.shares)?;
    let profit = gross.saturating_sub(basis);

    // The trader pays no performance fee on their own co-invest.
    //
    // NOTE, because the comment that used to sit here justified this by "it
    // would be a wash that only leaked the platform cut of their own money -
    // platform cut still applies below, uniformly", and the platform cut is
    // now zero, in this same function. That rationale is void. The exemption
    // is kept as a deliberate product decision (a trader should not pay
    // themselves a fee out of their own principal), and it is why the trader
    // is the only participant who realizes profit at 100% of gross - which is
    // exactly what made the B5 sandwich free for them, and why
    // MIN_DEPOSIT_HOLD_SECONDS now applies to everyone including the trader.
    let trader_fee = if is_trader {
        0
    } else {
        // ROUNDING: floor (fee paid from proceeds; can only undercharge dust).
        math::mul_bps_floor(profit, vault.perf_fee_bps)
    };
    // THE PLATFORM TAKES NOTHING.
    //
    // This used to charge PLATFORM_PROFIT_BPS (10%) on top of the trader's
    // fee, so a 30% vault left the depositor 60% of profit while the site
    // and every public post said 70%. The published terms are now what the
    // program enforces: depositor keeps gross minus the trader's fee, and
    // nothing else is taken.
    let platform_fee: u64 = 0;

    // perf_fee_bps <= 3000, so the fee is at most 30% of profit <= gross.
    let payout = gross
        .checked_sub(trader_fee)
        .ok_or(VaultError::MathOverflow)?;

    // -- depositor bookkeeping ---------------------------------------------
    depositor.shares = depositor
        .shares
        .checked_sub(shares_w)
        .ok_or(VaultError::MathOverflow)?;
    // basis <= net_deposits by proportional_floor's numerator<=denominator.
    depositor.net_deposits_lamports = depositor
        .net_deposits_lamports
        .checked_sub(basis)
        .ok_or(VaultError::MathOverflow)?;
    // The Drift-pattern lifetime ratchet: monotonically non-decreasing.
    depositor.cumulative_profit_share_lamports = depositor
        .cumulative_profit_share_lamports
        .checked_add(profit)
        .ok_or(VaultError::MathOverflow)?;

    // -- vault bookkeeping --------------------------------------------------
    vault.total_shares = vault
        .total_shares
        .checked_sub(shares_w)
        .ok_or(VaultError::MathOverflow)?;
    // gross <= current value of shares_w <= effective equity <= nav.
    vault.nav_lamports = vault
        .nav_lamports
        .checked_sub(gross)
        .ok_or(VaultError::MathOverflow)?;
    // Platform fee lamports physically stay on the vault until collected,
    // but leave NAV now (they are a liability, not equity).
    vault.platform_fees_owed_lamports = vault
        .platform_fees_owed_lamports
        .checked_add(platform_fee)
        .ok_or(VaultError::MathOverflow)?;
    if is_trader {
        // Tracks co-invest; saturating on principle (shares can only enter
        // manager_shares via the trader's own deposits, so this is exact).
        vault.manager_shares = vault.manager_shares.saturating_sub(shares_w);
    }

    Ok((payout, trader_fee, platform_fee))
}

// ---------------------------------------------------------------------------
// request_withdraw
// ---------------------------------------------------------------------------

pub fn handle_request_withdraw(ctx: Context<WithdrawRequestOp>, shares: u128) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let vault = &mut ctx.accounts.vault;
    let depositor = &mut ctx.accounts.depositor;

    // One pending request per depositor (spec).
    require!(!depositor.has_pending_request(), VaultError::WithdrawRequestPending);
    require!(shares > 0 && shares <= depositor.shares, VaultError::InsufficientShares);
    // Deliberately NOT status-gated; only NAV freshness (spec).
    vault.assert_nav_fresh(now)?;

    let equity = vault.effective_equity(now);
    // ROUNDING: floor — locks in the smaller of the two candidate values for
    // the later worse-of comparison.
    let value = math::value_for_shares(shares, vault.total_shares, equity)?;
    require!(value > 0, VaultError::InvalidParameter);

    depositor.last_withdraw_request = WithdrawRequest {
        shares,
        value_at_request_lamports: value,
        requested_at: now,
    };

    // Reserve the request's value: value_at_request is an upper bound on the
    // eventual payout (worse-of), so reserving it guarantees instant
    // withdrawals and wraps can never strand a matured request.
    vault.pending_withdraw_value_lamports = vault
        .pending_withdraw_value_lamports
        .checked_add(value)
        .ok_or(VaultError::MathOverflow)?;
    vault.pending_withdraw_shares = vault
        .pending_withdraw_shares
        .checked_add(shares)
        .ok_or(VaultError::MathOverflow)?;

    emit!(WithdrawRequested {
        vault: vault.key(),
        depositor: depositor.authority,
        shares,
        value_at_request_lamports: value,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// cancel_withdraw_request
// ---------------------------------------------------------------------------

pub fn handle_cancel_withdraw_request(ctx: Context<WithdrawRequestOp>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let depositor = &mut ctx.accounts.depositor;
    require!(depositor.has_pending_request(), VaultError::NoWithdrawRequest);

    let req = depositor.last_withdraw_request;

    // Owner-only by construction: the depositor PDA is seeded on
    // authority.key(). Expired requests are cleared by anyone through
    // clear_expired_request below.
    release_reservation(vault, &req)?;
    depositor.last_withdraw_request = WithdrawRequest::default();
    Ok(())
}

/// PERMISSIONLESS: release the reservation held by an expired request.
///
/// Only the reservation is released. The depositor keeps every share and may
/// request again immediately. Without this, one abandoned request froze
/// instant withdrawals for every other depositor in the vault, forever.
pub fn handle_clear_expired_request(ctx: Context<ClearExpiredRequest>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let vault = &mut ctx.accounts.vault;
    let depositor = &mut ctx.accounts.depositor;
    require!(depositor.has_pending_request(), VaultError::NoWithdrawRequest);

    let req = depositor.last_withdraw_request;
    // B3b: the grace runs from the END of the vault's redeem window, not from
    // the request. A flat 14-day expiry against a window that may be 30 days
    // let anyone delete a request that was not yet executable - clear at day
    // 14, depositor re-requests, cleared again at day 14, and
    // execute_withdraw was unreachable on that vault forever.
    let expires_at = req
        .requested_at
        .saturating_add(vault.redeem_window_seconds)
        .saturating_add(WITHDRAW_REQUEST_GRACE_SECONDS);
    require!(now >= expires_at, VaultError::WithdrawRequestPending);

    release_reservation(vault, &req)?;
    depositor.last_withdraw_request = WithdrawRequest::default();
    Ok(())
}

// ---------------------------------------------------------------------------
// execute_withdraw
// ---------------------------------------------------------------------------

pub fn handle_execute_withdraw(ctx: Context<ExecuteWithdraw>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let vault_ai = ctx.accounts.vault.to_account_info();
    let vault = &mut ctx.accounts.vault;
    let depositor = &mut ctx.accounts.depositor;

    require!(depositor.has_pending_request(), VaultError::NoWithdrawRequest);
    let req = depositor.last_withdraw_request;
    let waited = now.saturating_sub(req.requested_at);
    require!(
        waited >= vault.redeem_window_seconds,
        VaultError::RedeemWindowNotElapsed
    );
    vault.assert_nav_fresh(now)?;
    // B4: a short wait is an instant withdrawal by another name, so it is
    // held to the instant path's tighter staleness bound. MIN_REDEEM_WINDOW
    // makes this unreachable for vaults created under this build; it stays
    // because `redeem_window_seconds` is per-vault immutable state and older
    // vaults carry whatever they were created with, including zero.
    if waited < INSTANT_WITHDRAW_MAX_NAV_STALENESS_SECONDS {
        require!(
            now.saturating_sub(vault.nav_posted_at)
                <= INSTANT_WITHDRAW_MAX_NAV_STALENESS_SECONDS,
            VaultError::NavTooStaleForInstant
        );
    }

    // Priced at EXECUTION, capped at the request-time value only when the
    // vault has genuinely gained since.
    //
    // B7: the cap used to be an unconditional min(), and the drip only ever
    // moves equity UP between posts, so min() systematically selected the
    // stale request-time number. A depositor who requested and then watched a
    // legal +10% mark land during their window was paid the pre-mark price
    // and forfeited the gain to whoever stayed. The doc claimed worse-of
    // "removes every timing edge a withdrawing depositor could hold"; it did
    // not remove the edge, it inverted it - the requester held a strictly
    // negative option and the stayers held a free one, and nothing in the
    // emitted event said so.
    //
    // The edge worse-of exists to close is a depositor locking in a price the
    // vault subsequently LOST. That is the `current < request` case, and it
    // is still capped. The `current > request` case is not a timing edge -
    // the shares really are worth more - so it is paid.
    let equity = vault.effective_equity(now);
    let gross = math::value_for_shares(req.shares, vault.total_shares, equity)?;

    let is_trader = depositor.authority == vault.trader;
    let (payout, trader_fee, platform_fee) =
        settle_withdrawal(vault, depositor, req.shares, gross, is_trader)?;

    // Release this request's reservation before the buffer check so the check
    // sees reservations for OTHER requests only.
    release_reservation(vault, &req)?;
    depositor.last_withdraw_request = WithdrawRequest::default();

    // SOL buffer check: rent floor + other requests + platform fees owed
    // (including this withdrawal's own platform fee, added in settle) must
    // survive the payout. If the trader has the funds deployed in tokens,
    // this fails until they unwind — the NAV breaker and platform freeze
    // exist to force exactly that.
    let rent_min = Rent::get()?.minimum_balance(vault_ai.data_len());
    let outflow = payout
        .checked_add(trader_fee)
        .ok_or(VaultError::MathOverflow)?;
    require!(
        vault.free_sol(vault_ai.lamports(), rent_min, now) >= outflow,
        VaultError::InsufficientSolBuffer
    );

    pay_from_vault(&vault_ai, &ctx.accounts.authority.to_account_info(), payout)?;
    pay_from_vault(&vault_ai, &ctx.accounts.trader.to_account_info(), trader_fee)?;

    emit!(WithdrawExecuted {
        vault: vault.key(),
        depositor: depositor.authority,
        instant: false,
        shares_burned: req.shares,
        gross_lamports: gross,
        payout_lamports: payout,
        trader_fee_lamports: trader_fee,
        platform_fee_lamports: platform_fee,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// instant_withdraw
// ---------------------------------------------------------------------------

pub fn handle_instant_withdraw(ctx: Context<ExecuteWithdraw>, shares: u128) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let vault_ai = ctx.accounts.vault.to_account_info();
    let vault = &mut ctx.accounts.vault;
    let depositor = &mut ctx.accounts.depositor;

    // Instant path is one of the "other depositor ops" blocked while a
    // request is pending (spec) — otherwise the same shares could be spent
    // twice (once reserved, once instantly).
    require!(!depositor.has_pending_request(), VaultError::WithdrawRequestPending);
    require!(shares > 0 && shares <= depositor.shares, VaultError::InsufficientShares);

    // B5: a deposit cannot be instantly withdrawn.
    //
    // The drip stops a same-block sandwich around a NAV post. It does not
    // stop the same play stretched over the drip: deposit, wait for the
    // locked profit to unlock to ALL shares including the ones just minted,
    // exit with a slice of a gain somebody else's capital earned. The trader
    // ran it for free, since is_trader waives the performance fee. Anyone
    // genuinely investing is unaffected by an hour; anyone arriving to skim
    // one unlock is not.
    require!(
        now.saturating_sub(depositor.last_deposit_ts) >= MIN_DEPOSIT_HOLD_SECONDS,
        VaultError::DepositHoldNotElapsed
    );

    // Skipping the redeem window demands a tighter staleness bound: the mark
    // must be at most INSTANT_WITHDRAW_MAX_NAV_STALENESS_SECONDS old AND
    // inside the vault's own window (whichever is stricter).
    vault.assert_nav_fresh(now)?;
    require!(
        now.saturating_sub(vault.nav_posted_at) <= INSTANT_WITHDRAW_MAX_NAV_STALENESS_SECONDS,
        VaultError::NavTooStaleForInstant
    );

    let equity = vault.effective_equity(now);
    // ROUNDING: floor (vault's favor).
    let gross = math::value_for_shares(shares, vault.total_shares, equity)?;

    let is_trader = depositor.authority == vault.trader;
    let (payout, trader_fee, platform_fee) =
        settle_withdrawal(vault, depositor, shares, gross, is_trader)?;

    // Buffer check: instant withdrawals may only spend FREE SOL — never the
    // rent floor, never lamports reserved for matured/maturing requests,
    // never platform fees owed.
    let rent_min = Rent::get()?.minimum_balance(vault_ai.data_len());
    let outflow = payout
        .checked_add(trader_fee)
        .ok_or(VaultError::MathOverflow)?;
    require!(
        vault.free_sol(vault_ai.lamports(), rent_min, now) >= outflow,
        VaultError::InsufficientSolBuffer
    );

    pay_from_vault(&vault_ai, &ctx.accounts.authority.to_account_info(), payout)?;
    pay_from_vault(&vault_ai, &ctx.accounts.trader.to_account_info(), trader_fee)?;

    emit!(WithdrawExecuted {
        vault: vault.key(),
        depositor: depositor.authority,
        instant: true,
        shares_burned: shares,
        gross_lamports: gross,
        payout_lamports: payout,
        trader_fee_lamports: trader_fee,
        platform_fee_lamports: platform_fee,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// emergency_withdraw
// ---------------------------------------------------------------------------

/// PERMISSIONLESS stale-NAV escape hatch (review finding H1).
///
/// WHY: every other withdrawal path calls `assert_nav_fresh`. A keeper that
/// stops posting — whether it died or the platform declines to rotate it —
/// would otherwise freeze withdrawals forever, with a platform-gated
/// `set_nav_keeper` as the only cure. That makes entitlement conditional on
/// someone else's cooperation, which contradicts the whole custody model. This
/// path removes that condition: after NAV_EMERGENCY_GRACE_SECONDS of silence
/// the depositor redeems their OWN shares against the LAST POSTED mark, with
/// no keeper, no admin, no trader and no status/kill-switch involvement of any
/// kind (note the context carries no PlatformConfig and nothing below reads
/// `vault.status` — that is deliberate and must stay that way).
///
/// WHY it is safe for everyone who stays: the price is a stale mark, so it is
/// haircut by EMERGENCY_HAIRCUT_BPS before fees. The withheld lamports never
/// leave the vault while the shares are fully burned, so remaining depositors
/// are strictly better off per share; and since the haircut makes this path
/// always worse than waiting for a fresh post, it can never be farmed as an
/// arbitrage against a stale-high mark. Residual risk (accepted, and the
/// reason for the long grace period): if the book actually lost more than the
/// haircut since the last mark, an early exiter still leaves with too much —
/// bounded by the fact that no fresh valuation exists to do better with.
pub fn handle_emergency_withdraw(ctx: Context<ExecuteWithdraw>, shares: u128) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let vault_ai = ctx.accounts.vault.to_account_info();
    let vault = &mut ctx.accounts.vault;
    let depositor = &mut ctx.accounts.depositor;

    // B10: the hatch opens on EITHER of two conditions.
    //
    // It used to test only keeper liveness, which is a predicate about the
    // keeper and not about whether this depositor can actually get out. A
    // keeper posting every six hours refreshes nav_posted_at forever, so the
    // hatch never opened - while a vault configured with a 60-second
    // staleness window left withdrawals possible for 60 seconds out of every
    // 21,600, at instants only the keeper knew in advance. `lib.rs` promised
    // this path made entitlement unconditional; it was conditional on the
    // keeper's cadence and on every other depositor's behaviour.
    let nav_age = now.saturating_sub(vault.nav_posted_at);
    let keeper_abandoned = nav_age >= NAV_EMERGENCY_GRACE_SECONDS;
    // ... or this depositor's own request matured and still cannot be settled.
    let exit_blocked = depositor.has_pending_request() && {
        let req = depositor.last_withdraw_request;
        now.saturating_sub(req.requested_at)
            >= vault
                .redeem_window_seconds
                .saturating_add(WITHDRAW_REQUEST_GRACE_SECONDS)
    };
    require!(
        keeper_abandoned || exit_blocked,
        VaultError::NavNotStaleEnough
    );

    // Release this depositor's own reservation if they hold one, so the
    // shares are not counted twice. It is their request; nobody else's state
    // is touched.
    if depositor.has_pending_request() {
        let req = depositor.last_withdraw_request;
        release_reservation(vault, &req)?;
        depositor.last_withdraw_request = WithdrawRequest::default();
    }
    require!(shares > 0 && shares <= depositor.shares, VaultError::InsufficientShares);

    // Priced on the last posted mark — by construction there is no fresh one.
    // Same pricing function as every other path; NAV_EMERGENCY_GRACE_SECONDS
    // is >= MAX_UNLOCK_PERIOD_SECONDS, so the locked-profit drip has always
    // fully unlocked by now and this is simply nav_lamports.
    let stale_nav = vault.nav_lamports; // captured for the event before settle
    let equity = vault.effective_equity(now);
    // ROUNDING: floor (vault's favor), as everywhere else.
    let gross_before_haircut = math::value_for_shares(shares, vault.total_shares, equity)?;
    // The haircut applies to the GROSS, before fee crystallization, so the
    // trader and the platform are paid on the same reduced amount the
    // depositor is. ROUNDING: floor of the RETAINED fraction rather than
    // gross - floor(haircut), so the sub-lamport dust also stays with the pool
    // (math.rs policy).
    let gross = math::mul_bps_floor(gross_before_haircut, EMERGENCY_PAYOUT_BPS);
    // Refuse a zero-value burn: the depositor would destroy shares for nothing
    // (same guard request_withdraw applies to its own valuation).
    require!(gross > 0, VaultError::InvalidParameter);

    let is_trader = depositor.authority == vault.trader;
    let (payout, trader_fee, platform_fee) =
        settle_withdrawal(vault, depositor, shares, gross, is_trader)?;

    // Rent floor and the treasury's fees are still respected. Other
    // depositors' RESERVATIONS deliberately are not (B10): this hatch exists
    // precisely for the case where nobody else is acting, and running the
    // same reservation check as every other path meant a third party's stale
    // request held the escape hatch shut too - the exact failure the hatch
    // was written to make impossible. If the buffer is short because the
    // float is wrapped, sol_ops::settle_unwrap forces it back permissionlessly.
    let rent_min = Rent::get()?.minimum_balance(vault_ai.data_len());
    let outflow = payout
        .checked_add(trader_fee)
        .ok_or(VaultError::MathOverflow)?;
    require!(
        vault.free_sol_unreserved(vault_ai.lamports(), rent_min) >= outflow,
        VaultError::InsufficientSolBuffer
    );

    pay_from_vault(&vault_ai, &ctx.accounts.authority.to_account_info(), payout)?;
    pay_from_vault(&vault_ai, &ctx.accounts.trader.to_account_info(), trader_fee)?;

    emit!(EmergencyWithdrawExecuted {
        vault: vault.key(),
        depositor: depositor.authority,
        shares_burned: shares,
        stale_nav_lamports: stale_nav,
        nav_age_seconds: nav_age,
        gross_before_haircut_lamports: gross_before_haircut,
        gross_lamports: gross,
        payout_lamports: payout,
        trader_fee_lamports: trader_fee,
        platform_fee_lamports: platform_fee,
    });
    Ok(())
}
