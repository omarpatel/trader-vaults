//! Platform-level operations: global kill switch, NAV keeper rotation,
//! platform fee collection and treasury sweep.

use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::instructions::withdraw::pay_from_vault;
use crate::state::*;

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct AdminPlatformOp<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [PLATFORM_CONFIG_SEED],
        bump = platform_config.bump,
        has_one = admin @ VaultError::Unauthorized,
    )]
    pub platform_config: Account<'info, PlatformConfig>,
}

#[derive(Accounts)]
pub struct SetNavKeeper<'info> {
    pub admin: Signer<'info>,

    #[account(
        seeds = [PLATFORM_CONFIG_SEED],
        bump = platform_config.bump,
        has_one = admin @ VaultError::Unauthorized,
    )]
    pub platform_config: Account<'info, PlatformConfig>,

    #[account(mut, seeds = [VAULT_SEED, vault.creator.as_ref(), vault.name.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
}

/// Two-step admin rotation. `propose_admin` stages, `accept_admin` commits.
#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,

    #[account(
        mut,
        seeds = [PLATFORM_CONFIG_SEED],
        bump = platform_config.bump,
    )]
    pub platform_config: Account<'info, PlatformConfig>,
}

#[derive(Accounts)]
pub struct CollectPlatformFees<'info> {
    #[account(mut, seeds = [VAULT_SEED, vault.creator.as_ref(), vault.name.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,

    #[account(seeds = [PLATFORM_CONFIG_SEED], bump = platform_config.bump)]
    pub platform_config: Account<'info, PlatformConfig>,

    /// The ONLY destination fees can ever be collected to: the seed-pinned
    /// Treasury PDA. There is no account or argument through which a caller
    /// could redirect this.
    #[account(mut, seeds = [TREASURY_SEED], bump = platform_config.treasury_bump)]
    pub treasury: Account<'info, Treasury>,
}

#[derive(Accounts)]
pub struct SweepTreasury<'info> {
    pub admin: Signer<'info>,

    #[account(
        seeds = [PLATFORM_CONFIG_SEED],
        bump = platform_config.bump,
        has_one = admin @ VaultError::Unauthorized,
    )]
    pub platform_config: Account<'info, PlatformConfig>,

    #[account(mut, seeds = [TREASURY_SEED], bump = platform_config.treasury_bump)]
    pub treasury: Account<'info, Treasury>,

    /// CHECK: admin-chosen destination for PLATFORM (never vault) funds.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// Global kill switch: halts NEW trades (and trade-prep wraps) on every
/// vault. By construction it cannot touch withdrawals — no withdrawal-path
/// instruction reads it.
pub fn handle_set_kill_switch(ctx: Context<AdminPlatformOp>, on: bool) -> Result<()> {
    ctx.accounts.platform_config.kill_switch = on;
    Ok(())
}

/// Stage an admin handover. Nothing changes until the proposed key signs
/// `accept_admin`, so a typo cannot brick platform governance.
///
/// B1: `admin` used to be write-once and permanently equal to the program
/// upgrade authority. With the keeper split off (below), the admin role can
/// now be moved to a multisig without breaking NAV posting - which is the
/// whole point, and was impossible before.
pub fn handle_propose_admin(ctx: Context<AdminPlatformOp>, new_admin: Pubkey) -> Result<()> {
    require!(new_admin != Pubkey::default(), VaultError::InvalidParameter);
    ctx.accounts.platform_config.pending_admin = new_admin;
    Ok(())
}

/// Commit a staged handover. Signed by the incoming key, which proves it
/// exists and is controlled.
pub fn handle_accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let cfg = &mut ctx.accounts.platform_config;
    require!(cfg.pending_admin != Pubkey::default(), VaultError::NoPendingAdmin);
    require!(
        ctx.accounts.new_admin.key() == cfg.pending_admin,
        VaultError::Unauthorized
    );
    cfg.admin = cfg.pending_admin;
    cfg.pending_admin = Pubkey::default();
    Ok(())
}

/// Point the platform at a new NAV keeper key. Existing vaults keep pointing
/// at the old one until `set_nav_keeper` is run against each of them.
pub fn handle_set_platform_nav_keeper(
    ctx: Context<AdminPlatformOp>,
    new_keeper: Pubkey,
) -> Result<()> {
    require!(new_keeper != Pubkey::default(), VaultError::InvalidParameter);
    ctx.accounts.platform_config.nav_keeper = new_keeper;
    Ok(())
}

/// NAV keeper rotation, platform-admin only.
/// WHY admin and not trader: the keeper's marks price every share; a
/// trader-appointed keeper could mark the trader's own book up.
/// WHY this must exist at all: deposits/withdrawals are gated on NAV
/// freshness, so a dead keeper key would otherwise brick withdrawals — the
/// platform restores liveness by rotating to a working keeper.
pub fn handle_set_nav_keeper(ctx: Context<SetNavKeeper>, new_keeper: Pubkey) -> Result<()> {
    require!(new_keeper != Pubkey::default(), VaultError::InvalidParameter);
    // The liveness argument above justifies rotating a DEAD keeper back to
    // the platform. It does not justify pointing a live vault's pricing at an
    // arbitrary key: admin could name any address and drain that vault
    // through the same NAV path a creator could. Rotation is only ever to the
    // platform's declared keeper - which is a dedicated key, NOT the admin
    // and NOT the upgrade authority (B1).
    require!(
        new_keeper == ctx.accounts.platform_config.nav_keeper,
        VaultError::Unauthorized
    );
    ctx.accounts.vault.nav_keeper = new_keeper;
    Ok(())
}

/// Permissionless: anyone may push accrued platform fees from a vault to the
/// pinned treasury. Safe to open up because the destination is fixed by
/// seeds and the amount is fixed by the vault's own accounting.
pub fn handle_collect_platform_fees(ctx: Context<CollectPlatformFees>) -> Result<()> {
    let vault_ai = ctx.accounts.vault.to_account_info();
    let vault = &mut ctx.accounts.vault;

    let owed = vault.platform_fees_owed_lamports;
    require!(owed > 0, VaultError::NoFeesOwed);

    // The owed lamports are always physically present: every spend path
    // (withdrawals, wraps) excludes them via free_sol. The min() below is
    // pure defense-in-depth so an accounting bug could never turn into a
    // withdrawal-blocking rent violation.
    let rent_min = Rent::get()?.minimum_balance(vault_ai.data_len());
    let now = Clock::get()?.unix_timestamp;
    let physically_available = vault_ai
        .lamports()
        .saturating_sub(rent_min)
        .saturating_sub(vault.pending_withdraw_reserve(now));
    let amount = owed.min(physically_available);
    require!(amount > 0, VaultError::NoFeesOwed);

    vault.platform_fees_owed_lamports = vault
        .platform_fees_owed_lamports
        .checked_sub(amount)
        .ok_or(VaultError::MathOverflow)?;

    pay_from_vault(&vault_ai, &ctx.accounts.treasury.to_account_info(), amount)?;
    Ok(())
}

/// Moves PLATFORM fee revenue (never vault assets) out of the treasury.
/// Admin-gated; keeps the treasury rent-exempt.
pub fn handle_sweep_treasury(ctx: Context<SweepTreasury>, amount: u64) -> Result<()> {
    let treasury_ai = ctx.accounts.treasury.to_account_info();
    let rent_min = Rent::get()?.minimum_balance(treasury_ai.data_len());
    let available = treasury_ai.lamports().saturating_sub(rent_min);
    require!(amount > 0 && amount <= available, VaultError::InvalidParameter);

    // Treasury is program-owned, so the same direct-lamport pattern applies.
    pay_from_vault(&treasury_ai, &ctx.accounts.destination.to_account_info(), amount)?;
    Ok(())
}
