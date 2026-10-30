//! Per-vault governance: operator delegation, fee reduction, freeze /
//! unfreeze / close, mint allowlist. None of these move funds.

use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::state::*;

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

/// Trader-only vault operation (has_one pins the signer to vault.trader).
#[derive(Accounts)]
pub struct TraderOp<'info> {
    pub trader: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.creator.as_ref(), vault.name.as_ref()],
        bump = vault.bump,
        has_one = trader @ VaultError::Unauthorized,
    )]
    pub vault: Box<Account<'info, Vault>>,
}

/// Trader-or-platform vault operation; the handler decides who may do what.
#[derive(Accounts)]
pub struct FreezeOp<'info> {
    pub authority: Signer<'info>,

    #[account(mut, seeds = [VAULT_SEED, vault.creator.as_ref(), vault.name.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,

    #[account(seeds = [PLATFORM_CONFIG_SEED], bump = platform_config.bump)]
    pub platform_config: Box<Account<'info, PlatformConfig>>,
}

// ---------------------------------------------------------------------------
// set_operator
// ---------------------------------------------------------------------------

/// Delegates the trader's TRADE-ONLY powers (execute_swap / wrap / unwrap /
/// close_empty_ata) to an engine key — the mirror-vault execution path.
/// Pubkey::default() clears the delegation. Allowed for managed vaults too:
/// the operator can never do anything the trader could not.
pub fn handle_set_operator(ctx: Context<TraderOp>, new_operator: Pubkey) -> Result<()> {
    ctx.accounts.vault.operator = new_operator;
    Ok(())
}

// ---------------------------------------------------------------------------
// reduce_fees
// ---------------------------------------------------------------------------

/// Perf fee is a one-way ratchet DOWN after init (spec). Floor is 0.
/// WHY one-way: depositors priced their entry against a fee that can only
/// improve; there is no instruction anywhere that raises it.
pub fn handle_reduce_fees(ctx: Context<TraderOp>, new_perf_fee_bps: u16) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    require!(new_perf_fee_bps < vault.perf_fee_bps, VaultError::FeeNotReduced);
    vault.perf_fee_bps = new_perf_fee_bps;
    Ok(())
}

// ---------------------------------------------------------------------------
// freeze / unfreeze
// ---------------------------------------------------------------------------

/// Freezes TRADING and NEW DEPOSITS. Withdrawals are structurally unaffected
/// (no withdrawal instruction reads status). Trader or platform admin.
pub fn handle_freeze_vault(ctx: Context<FreezeOp>) -> Result<()> {
    let signer = ctx.accounts.authority.key();
    let vault = &mut ctx.accounts.vault;
    let is_admin = signer == ctx.accounts.platform_config.admin;
    let is_trader = signer == vault.trader;
    require!(is_admin || is_trader, VaultError::Unauthorized);
    require!(vault.status == VaultStatus::Active, VaultError::VaultNotActive);

    vault.status = VaultStatus::Frozen;
    // An admin freeze outranks a trader freeze: only the platform may undo it.
    vault.frozen_by = if is_admin { FrozenBy::Platform } else { FrozenBy::Trader };

    emit!(VaultStatusChanged {
        vault: vault.key(),
        status: vault.status,
        frozen_by: vault.frozen_by,
    });
    Ok(())
}

pub fn handle_unfreeze_vault(ctx: Context<FreezeOp>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let signer = ctx.accounts.authority.key();
    let vault = &mut ctx.accounts.vault;
    let is_admin = signer == ctx.accounts.platform_config.admin;
    let is_trader = signer == vault.trader;
    require!(is_admin || is_trader, VaultError::Unauthorized);
    require!(vault.status == VaultStatus::Frozen, VaultError::VaultNotFrozen);

    match vault.frozen_by {
        // Platform freezes are platform-only to lift.
        FrozenBy::Platform => require!(is_admin, VaultError::PlatformFrozen),
        // Breaker freezes: the trader must wait out the UTC day (otherwise
        // unfreezing would hand them a fresh, unearned loss budget mid-day);
        // the platform may override any time, and doing so intentionally
        // resets the day's accumulator so the very next post_nav does not
        // instantly re-trip on the same losses.
        FrozenBy::RiskBreaker => {
            if !is_admin {
                require!(
                    vault.day_bucket != now.div_euclid(SECONDS_PER_DAY),
                    VaultError::BreakerCooldown
                );
            } else {
                // The admin may lift a breaker freeze at any time, and doing
                // so clears the day's loss budget so the next post does not
                // instantly re-trip on the same losses.
                //
                // NOTE this does NOT reset `daily_gain_accumulator` or the
                // MAX_DAILY_NAV_MOVE_BPS ceiling, which is deliberate: that
                // ceiling is the bound on a compromised keeper (B1) and an
                // admin-resettable bound would be no bound at all. The
                // breaker is a risk control; the movement cap is a safety
                // limit, and they are not the same thing.
                vault.daily_loss_accumulator = 0;
            }
        }
        // Trader freezes: trader or platform.
        FrozenBy::Trader | FrozenBy::None => {}
    }

    vault.status = VaultStatus::Active;
    vault.frozen_by = FrozenBy::None;

    emit!(VaultStatusChanged {
        vault: vault.key(),
        status: vault.status,
        frozen_by: vault.frozen_by,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// close_vault
// ---------------------------------------------------------------------------

/// IRREVERSIBLE wind-down: trading and deposits off forever, withdrawals
/// keep working until everyone has exited. (unfreeze requires status ==
/// Frozen, so a Closed vault can never be resurrected.)
pub fn handle_close_vault(ctx: Context<TraderOp>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    require!(vault.status != VaultStatus::Closed, VaultError::VaultClosed);
    vault.status = VaultStatus::Closed;
    vault.frozen_by = FrozenBy::None;

    emit!(VaultStatusChanged {
        vault: vault.key(),
        status: vault.status,
        frozen_by: vault.frozen_by,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// set_mint_allowlist
// ---------------------------------------------------------------------------

/// Trader-managed allowlist for the non-SOL leg of swaps. Defense-in-depth
/// against fat-fingers and long-tail rugs — NOT a trust boundary against the
/// trader (who controls the list). An enforced empty list disables all
/// trading out of SOL.
pub fn handle_set_mint_allowlist(
    ctx: Context<TraderOp>,
    enforce: bool,
    mints: Vec<Pubkey>,
) -> Result<()> {
    require!(mints.len() <= MAX_ALLOWED_MINTS, VaultError::InvalidParameter);
    let vault = &mut ctx.accounts.vault;
    let mut list = [Pubkey::default(); MAX_ALLOWED_MINTS];
    for (slot, mint) in list.iter_mut().zip(mints.iter()) {
        require!(*mint != Pubkey::default(), VaultError::InvalidParameter);
        *slot = *mint;
    }
    vault.allowed_mints = list;
    vault.enforce_mint_allowlist = enforce;
    Ok(())
}
