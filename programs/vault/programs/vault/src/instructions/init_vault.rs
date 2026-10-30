//! Vault creation. The creator becomes the trader and must seed the vault
//! with a minimum deposit whose shares are recorded as `seed_shares` and
//! owned by NOBODY (economically burned). Together with the virtual-share
//! decimal offset in math.rs this closes the first-depositor inflation attack.

use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::VaultError;
use crate::math;
use crate::state::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitVaultParams {
    /// Fixed 32-byte vault name. Part of the PDA seeds ALONGSIDE the creator,
    /// so it is unique per creator rather than globally (B12).
    pub name: [u8; 32],
    pub vault_type: VaultType,
    /// Must be within [MIN_PERF_FEE_BPS_AT_INIT, MAX_PERF_FEE_BPS].
    pub perf_fee_bps: u16,
    pub redeem_window_seconds: i64,
    pub nav_staleness_seconds: i64,
    pub unlock_period_seconds: i64,
    pub max_nav_delta_bps: u16,
    pub max_trade_notional_lamports: u64,
    pub max_price_impact_bps: u16,
    pub daily_loss_limit_bps: u16,
    pub nav_keeper: Pubkey,
    /// Burned seed deposit, >= MIN_SEED_LAMPORTS.
    pub seed_lamports: u64,
}

#[derive(Accounts)]
#[instruction(params: InitVaultParams)]
pub struct InitVault<'info> {
    /// Creator = trader. Pays rent and the burned seed deposit.
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        init,
        payer = creator,
        space = 8 + Vault::INIT_SPACE,
        seeds = [VAULT_SEED, creator.key().as_ref(), params.name.as_ref()],
        bump
    )]
    pub vault: Box<Account<'info, Vault>>,

    /// Platform must be bootstrapped first (kill switch / treasury exist).
    #[account(seeds = [PLATFORM_CONFIG_SEED], bump = platform_config.bump)]
    pub platform_config: Box<Account<'info, PlatformConfig>>,

    pub system_program: Program<'info, System>,
}

pub fn handle_init_vault(ctx: Context<InitVault>, params: InitVaultParams) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let slot = Clock::get()?.slot;

    // ---- parameter validation --------------------------------------------
    require!(
        params.perf_fee_bps >= MIN_PERF_FEE_BPS_AT_INIT && params.perf_fee_bps <= MAX_PERF_FEE_BPS,
        VaultError::InvalidParameter
    );
    require!(
        (MIN_REDEEM_WINDOW_SECONDS..=MAX_REDEEM_WINDOW_SECONDS)
            .contains(&params.redeem_window_seconds),
        VaultError::InvalidParameter
    );
    require!(
        (MIN_NAV_STALENESS_SECONDS..=MAX_NAV_STALENESS_SECONDS)
            .contains(&params.nav_staleness_seconds),
        VaultError::InvalidParameter
    );
    require!(
        (MIN_UNLOCK_PERIOD_SECONDS..=MAX_UNLOCK_PERIOD_SECONDS)
            .contains(&params.unlock_period_seconds),
        VaultError::InvalidParameter
    );
    require!(
        params.max_nav_delta_bps >= MIN_NAV_DELTA_BPS
            && params.max_nav_delta_bps <= MAX_NAV_DELTA_BPS,
        VaultError::InvalidParameter
    );
    // B13: zero was legal and switched the breaker off entirely, with no
    // instruction anywhere to switch it back on - `daily_loss_limit_bps` is
    // written once, at init, and never again.
    require!(
        (MIN_DAILY_LOSS_LIMIT_BPS..=MAX_DAILY_LOSS_LIMIT_BPS)
            .contains(&params.daily_loss_limit_bps),
        VaultError::InvalidParameter
    );
    // B13: this went straight to state with no validation at all, and
    // u64::MAX was the platform's own default - so the "per-trade notional
    // cap" capped nothing on every vault the platform created.
    require!(
        params.max_trade_notional_lamports > 0
            && params.max_trade_notional_lamports <= MAX_TRADE_NOTIONAL_CEILING,
        VaultError::InvalidParameter
    );
    // B13: written at init, read at ZERO enforcement sites. Keep the field
    // (indexers surface it) but stop pretending it is a control: it is bounded
    // so it cannot be surfaced as a nonsense number, and execute_swap's
    // comment says plainly that impact is not checked on-chain.
    require!(
        params.max_price_impact_bps as u128 <= BPS_DENOMINATOR,
        VaultError::InvalidParameter
    );
    // The creator may not appoint their own NAV keeper.
    //
    // init_vault is permissionless, and NAV is the sole input to payout
    // pricing. A creator who names themselves keeper can mark their own book
    // up and withdraw the whole vault, including other people's deposits.
    // Validating only against Pubkey::default() was no validation at all.
    //
    // The keeper is the platform's DEDICATED keeper key - not the admin, and
    // not the upgrade authority (B1). Pinning it to the admin closed the
    // creator-rug and opened something worse: one key that prices every vault,
    // referees the circuit breaker, and can rewrite the program, which has to
    // be online to post NAV hourly or withdrawals stop.
    require!(
        params.nav_keeper == ctx.accounts.platform_config.nav_keeper,
        VaultError::Unauthorized
    );
    require!(params.seed_lamports >= MIN_SEED_LAMPORTS, VaultError::SeedTooSmall);

    // ---- burned seed deposit ---------------------------------------------
    // Inflow: creator -> vault PDA (system transfer; creator is a normal
    // system-owned signer so a CPI transfer is the right tool).
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.creator.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        ),
        params.seed_lamports,
    )?;

    // Empty-pool mint: seed_lamports * VIRTUAL_SHARES shares.
    let seed_shares = math::shares_for_deposit(params.seed_lamports, 0, 0)?;
    require!(seed_shares > 0, VaultError::ZeroShares);

    let vault = &mut ctx.accounts.vault;
    vault.bump = ctx.bumps.vault;
    vault.name = params.name;
    vault.creator = ctx.accounts.creator.key();
    vault.trader = ctx.accounts.creator.key();
    vault.operator = Pubkey::default();
    vault.nav_keeper = params.nav_keeper;
    vault.vault_type = params.vault_type;
    vault.status = VaultStatus::Active;
    vault.frozen_by = FrozenBy::None;

    vault.perf_fee_bps = params.perf_fee_bps;
    vault.platform_profit_bps = PLATFORM_PROFIT_BPS;

    vault.redeem_window_seconds = params.redeem_window_seconds;
    vault.nav_staleness_seconds = params.nav_staleness_seconds;

    // seed shares are counted in total supply but owned by no depositor:
    // they can never be redeemed, permanently anchoring the share price.
    vault.total_shares = seed_shares;
    vault.seed_shares = seed_shares;
    vault.manager_shares = 0;

    // The vault starts with a self-evident NAV: the seed lamports. Marked
    // fresh so the vault is immediately usable; the keeper takes over from
    // the first post_nav.
    vault.nav_lamports = params.seed_lamports;
    vault.nav_slot = slot;
    vault.nav_posted_at = now;

    vault.locked_profit = 0;
    vault.locked_profit_ts = now;
    vault.unlock_period_seconds = params.unlock_period_seconds;

    vault.max_nav_delta_bps = params.max_nav_delta_bps;
    vault.max_trade_notional_lamports = params.max_trade_notional_lamports;
    vault.max_price_impact_bps = params.max_price_impact_bps;
    vault.daily_loss_limit_bps = params.daily_loss_limit_bps;
    vault.daily_loss_accumulator = 0;
    vault.daily_gain_accumulator = 0;
    vault.day_bucket = now.div_euclid(SECONDS_PER_DAY);
    vault.day_start_equity = params.seed_lamports;
    vault.deposit_cooldown_until = 0;
    vault.daily_swap_spend_lamports = 0;
    vault.swap_day_bucket = now.div_euclid(SECONDS_PER_DAY);

    vault.pending_withdraw_value_lamports = 0;
    vault.pending_withdraw_shares = 0;
    vault.platform_fees_owed_lamports = 0;

    vault.enforce_mint_allowlist = false;
    vault.allowed_mints = [Pubkey::default(); MAX_ALLOWED_MINTS];
    vault.positions = [Position::default(); MAX_POSITIONS];
    vault.padding = [0u8; 64];

    emit!(VaultInitialized {
        vault: vault.key(),
        trader: vault.trader,
        seed_lamports: params.seed_lamports,
        seed_shares,
    });
    Ok(())
}
