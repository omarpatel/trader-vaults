//! Investor deposit: SOL in, shares out.
//!
//! Pricing invariant: shares are ALWAYS minted against effective equity
//! (posted NAV minus still-locked profit) BEFORE the deposit is added, using
//! the virtual-offset formula in math.rs (floor). NAV freshness is enforced so
//! nobody can buy shares against a mark the keeper has abandoned.

use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::VaultError;
use crate::math;
use crate::state::*;

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.creator.as_ref(), vault.name.as_ref()],
        bump = vault.bump
    )]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        mut,
        seeds = [VAULT_DEPOSITOR_SEED, vault.key().as_ref(), authority.key().as_ref()],
        bump = depositor.bump,
    )]
    pub depositor: Box<Account<'info, VaultDepositor>>,

    pub system_program: Program<'info, System>,
}

pub fn handle_deposit(ctx: Context<Deposit>, amount_lamports: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    // Validate, price and book FIRST. The whole transaction reverts as one, so
    // ordering the CPI after this is safe, and it keeps every number this
    // instruction decides inside a function a test can call.
    let shares = {
        let vault = &mut ctx.accounts.vault;
        let depositor = &mut ctx.accounts.depositor;
        apply_deposit(vault, depositor, amount_lamports, now)?
    };

    // Inflow: user -> vault PDA lamports.
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.authority.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        ),
        amount_lamports,
    )?;

    let vault = &ctx.accounts.vault;
    let depositor = &ctx.accounts.depositor;
    emit!(Deposited {
        vault: vault.key(),
        depositor: depositor.authority,
        amount_lamports,
        shares_minted: shares,
        total_shares: vault.total_shares,
        nav_lamports: vault.nav_lamports,
    });
    Ok(())
}

/// Everything `deposit` decides, with no Context and no CPI.
///
/// Split out so it can be EXECUTED by a test — the same reason post_nav was
/// split. It earned that immediately: `last_deposit_ts` was declared, checked
/// by instant_withdraw, and written by nothing, so the hold gate was inert.
/// Returns the shares minted.
pub fn apply_deposit(
    vault: &mut Vault,
    depositor: &mut VaultDepositor,
    amount_lamports: u64,
    now: i64,
) -> Result<u128> {

    // Deposits only into a healthy vault. (Withdrawals, by contrast, are
    // never status-gated — see withdraw.rs.)
    require!(vault.status == VaultStatus::Active, VaultError::VaultNotActive);
    // No depositor ops while a withdrawal request is pending (spec).
    require!(!depositor.has_pending_request(), VaultError::WithdrawRequestPending);
    require!(amount_lamports >= MIN_DEPOSIT_LAMPORTS, VaultError::DepositTooSmall);
    vault.assert_nav_fresh(now)?;
    // B1: no minting against a mark that just moved hard. Crushing the price
    // is only profitable if you can buy at it; this is the hour that makes
    // that impossible. Exits are deliberately not gated on this.
    require!(
        now >= vault.deposit_cooldown_until,
        VaultError::DepositCooldown
    );

    // Price BEFORE the deposit lands, at FULL nav — not the drip-suppressed
    // equity that withdrawals use.
    //
    // EXPLOIT FIXED: both sides used effective_equity(), which subtracts
    // still-locked profit. After a gain is posted the locked portion makes
    // equity look smaller, so shares look cheap — and a depositor arriving
    // just after a posted gain bought in below fair value and collected the
    // drip as it unlocked. The drip exists to stop a sandwich AROUND a NAV
    // post; pricing deposits with it handed away the same value to anyone
    // who simply arrived after one.
    //
    // The asymmetry is deliberate and both halves favour existing holders:
    // deposits pay the full price, withdrawals receive the conservative one.
    let equity = vault.nav_lamports;
    // The vault always has seed equity, but a catastrophic 100% NAV loss could
    // zero it; refuse to mint infinite shares against nothing.
    require!(equity > 0, VaultError::ZeroEquity);

    let shares = math::shares_for_deposit(amount_lamports, vault.total_shares, equity)?;
    require!(shares > 0, VaultError::ZeroShares);

    // B9: the bound math.rs asserted and nothing enforced.
    //
    // The mint rate is (S + 1000) / (E + 1), which grows without bound as E
    // falls toward 1 while S stays large - so a depressed mark plus one
    // deposit takes total_shares to ~5e20, and a couple more cycles overflow
    // the u128 product in `value_for_shares`. Every withdrawal path calls
    // that first, so the vault would revert MathOverflow on every exit,
    // permanently, curable only by a program upgrade.
    let new_total_shares = vault
        .total_shares
        .checked_add(shares)
        .ok_or(VaultError::MathOverflow)?;
    require!(
        new_total_shares <= MAX_TOTAL_SHARES,
        VaultError::ShareCapExceeded
    );

    // Global NAV cap preserves u128 headroom for all share math (state.rs).
    let new_nav = vault
        .nav_lamports
        .checked_add(amount_lamports)
        .ok_or(VaultError::MathOverflow)?;
    require!(new_nav <= MAX_NAV_LAMPORTS, VaultError::NavCapExceeded);

    // Bookkeeping. NAV grows by exactly the deposited lamports: the keeper
    // marks value changes, the program tracks flows.
    vault.total_shares = new_total_shares;
    vault.nav_lamports = new_nav;

    // B5: stamp the deposit so instant_withdraw can enforce the hold.
    //
    // The field and the check both existed; nothing ever WROTE it, so it stayed
    // zero forever and `now - 0 >= MIN_DEPOSIT_HOLD_SECONDS` was true on the
    // first block of 1970. The gate was inert, and inert in the direction that
    // fails open. Caught by the withdrawal e2e reporting a depositor who had
    // "held for 1787486933s".
    depositor.last_deposit_ts = now;

    depositor.shares = depositor
        .shares
        .checked_add(shares)
        .ok_or(VaultError::MathOverflow)?;
    depositor.net_deposits_lamports = depositor
        .net_deposits_lamports
        .checked_add(amount_lamports)
        .ok_or(VaultError::MathOverflow)?;

    // Manager co-invest tracking.
    if depositor.authority == vault.trader {
        vault.manager_shares = vault
            .manager_shares
            .checked_add(shares)
            .ok_or(VaultError::MathOverflow)?;
    }

    Ok(shares)
}
