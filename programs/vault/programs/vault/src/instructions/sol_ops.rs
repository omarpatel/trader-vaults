//! SOL <-> wSOL plumbing and rent reclamation. Every move in this module is
//! VAULT-TO-VAULT: lamports travel between the vault PDA and token accounts
//! whose authority is the vault PDA. Nothing here can exfiltrate value.
//!
//! Wrapping (into the trading float) is trade-authority gated; unwrapping
//! (back into the withdrawal buffer) exists twice: `unwrap_sol` for the trade
//! authority at any time, and `settle_unwrap` for ANYONE once the vault has a
//! matured withdrawal request it cannot pay. WHY the second one: settlement
//! must not be something a trader can decline to perform.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    close_account, CloseAccount, TokenAccount, TokenInterface,
};

use crate::errors::VaultError;
use crate::instructions::withdraw::pay_from_vault;
use crate::state::*;

// ---------------------------------------------------------------------------
// wrap_sol: vault SOL -> vault wSOL ATA (trade float)
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct WrapSol<'info> {
    /// Trader or operator.
    pub authority: Signer<'info>,

    #[account(mut, seeds = [VAULT_SEED, vault.creator.as_ref(), vault.name.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,

    #[account(seeds = [PLATFORM_CONFIG_SEED], bump = platform_config.bump)]
    pub platform_config: Box<Account<'info, PlatformConfig>>,

    /// Vault-owned wSOL token account. (Anyone can create the vault's ATA
    /// permissionlessly via the Associated Token program — the vault program
    /// itself never needs to.)
    #[account(
        mut,
        token::authority = vault,
        constraint = wsol_account.mint == WSOL_MINT @ VaultError::NotWsol,
    )]
    pub wsol_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_wrap_sol(ctx: Context<WrapSol>, amount_lamports: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let vault_ai = ctx.accounts.vault.to_account_info();
    let vault = &ctx.accounts.vault;

    // Wrapping is trade preparation: it moves SOL out of the instant-withdraw
    // buffer into the trading float, so it is gated exactly like a trade.
    require!(vault.status == VaultStatus::Active, VaultError::VaultNotActive);
    require!(!ctx.accounts.platform_config.kill_switch, VaultError::TradingHalted);
    require!(
        vault.is_trade_authority(&ctx.accounts.authority.key()),
        VaultError::Unauthorized
    );
    require!(amount_lamports > 0, VaultError::InvalidParameter);

    // Only FREE SOL may be wrapped: never the rent floor, never lamports
    // reserved for pending withdrawal requests, never platform fees owed.
    let rent_min = Rent::get()?.minimum_balance(vault_ai.data_len());
    require!(
        vault.free_sol(vault_ai.lamports(), rent_min, now) >= amount_lamports,
        VaultError::InsufficientSolBuffer
    );

    // Vault PDA -> vault wSOL account. Vault-to-vault: the destination is
    // constrained to `token::authority = vault` and the wSOL mint, so this
    // cannot pay anyone.
    //
    // The `sync_native` CPI that used to follow is gone, and wrap_sol has
    // never worked with it: the runtime verifies the caller's account changes
    // BEFORE executing a CPI, and a direct lamport credit into an account
    // owned by the Token program does not survive that check — the
    // instruction failed "sum of account balances before and after
    // instruction do not match" with the Token program never logging an
    // invoke at all.
    //
    // Syncing is now the caller's job: append a plain SyncNative instruction
    // after this one (buildWrapSolIx's caller does). Splitting them is also
    // the more honest shape — this instruction moves lamports, and telling
    // the Token program to notice is a separate, permissionless act that
    // anyone can perform on a native account.
    pay_from_vault(
        &vault_ai,
        &ctx.accounts.wsol_account.to_account_info(),
        amount_lamports,
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// unwrap_sol: close the vault wSOL account, ALL its lamports -> vault PDA
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct UnwrapSol<'info> {
    /// Trader or operator.
    pub authority: Signer<'info>,

    #[account(mut, seeds = [VAULT_SEED, vault.creator.as_ref(), vault.name.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        mut,
        token::authority = vault,
        constraint = wsol_account.mint == WSOL_MINT @ VaultError::NotWsol,
    )]
    pub wsol_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_unwrap_sol(ctx: Context<UnwrapSol>) -> Result<()> {
    let vault = &ctx.accounts.vault;
    // Deliberately NOT status-gated: returning float to the withdrawal buffer
    // must always be possible, frozen or not.
    require!(
        vault.is_trade_authority(&ctx.accounts.authority.key()),
        VaultError::Unauthorized
    );

    // SPL token allows closing a NATIVE account with a non-zero balance; the
    // destination receives rent + wrapped lamports in one move. Destination is
    // the vault PDA itself, so this is strictly vault-to-vault.
    let vault_name = vault.name;
    let vault_creator = vault.creator;
    let vault_bump = vault.bump;
    let signer_seeds: &[&[u8]] =
        &[VAULT_SEED, vault_creator.as_ref(), vault_name.as_ref(), &[vault_bump]];
    close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.wsol_account.to_account_info(),
            destination: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        },
        &[signer_seeds],
    ))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// settle_unwrap: PERMISSIONLESS unwrap when settlement is genuinely owed
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct SettleUnwrap<'info> {
    // No signer field, exactly like platform.rs::collect_platform_fees: there
    // is nothing for a caller to steer. The destination is the vault PDA
    // (fixed by seeds), the amount is fixed by the token account's own
    // balance, and the handler's own preconditions decide whether it may run
    // at all — so "who called it" carries no authority here.
    #[account(mut, seeds = [VAULT_SEED, vault.creator.as_ref(), vault.name.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,

    /// WITNESS, read-only: a depositor of THIS vault whose withdrawal request
    /// has matured. Nothing is written to it; it exists only to point at the
    /// specific matured request that justifies forcing the unwind.
    /// NOTE(api): the seeds expression reads a field of the account being
    /// validated (`depositor.authority`), the same self-reference `bump =
    /// depositor.bump` already relies on. If Anchor 0.30.1 rejects that, drop
    /// the `seeds`/`bump` lines: `has_one = vault` plus the program-owned
    /// discriminator check already pins this to a real VaultDepositor of this
    /// vault, and there is no other way for such an account to exist.
    #[account(
        seeds = [VAULT_DEPOSITOR_SEED, vault.key().as_ref(), depositor.authority.as_ref()],
        bump = depositor.bump,
        has_one = vault @ VaultError::Unauthorized,
    )]
    pub depositor: Box<Account<'info, VaultDepositor>>,

    #[account(
        mut,
        token::authority = vault,
        constraint = wsol_account.mint == WSOL_MINT @ VaultError::NotWsol,
    )]
    pub wsol_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// Forced unwind for settlement (review finding H2).
///
/// WHY: `unwrap_sol` is trade-authority-gated, so a trader could wrap the
/// entire SOL buffer into wSOL and simply never unwrap it; matured withdrawal
/// requests then fail `InsufficientSolBuffer` forever. Freezing the vault and
/// the platform kill switch stop new TRADES but cannot compel settlement. This
/// instruction closes that hole: when the vault owes a matured withdrawal it
/// cannot pay, ANYONE may push the wSOL float back into the vault PDA.
///
/// Like `unwrap_sol` it is deliberately NOT status-gated — returning float to
/// the withdrawal buffer must work frozen, closed or killed — and it is
/// strictly vault-to-vault: `destination` is the vault PDA itself, so no
/// caller can name a third party or profit from calling it.
pub fn handle_settle_unwrap(ctx: Context<SettleUnwrap>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let vault_ai = ctx.accounts.vault.to_account_info();
    let vault = &ctx.accounts.vault;
    let depositor = &ctx.accounts.depositor;

    // ---- (1) the witness must be a genuinely MATURED request --------------
    require!(depositor.has_pending_request(), VaultError::NoWithdrawRequest);
    let req = depositor.last_withdraw_request;
    require!(
        now.saturating_sub(req.requested_at) >= vault.redeem_window_seconds,
        VaultError::RedeemWindowNotElapsed
    );

    // ---- (2) ...that the vault physically cannot pay ----------------------
    // `available` is every lamport that could legitimately be applied to a
    // withdrawal payout: the balance, less the vault's own rent-exempt floor,
    // less fees owed to the treasury. `pending_withdraw_reserve` is everything
    // the vault has already promised to pending requests, re-marked at `now`
    // (B3 — it used to be a frozen request-time figure that never moved), so
    // `available >= reserved` means every pending request, this one included,
    // is coverable and there is nothing to settle.
    //
    // WHY this cannot be used to grief the trader: a shortfall on its own is
    // normal — it is exactly what a deployed book looks like the moment
    // someone asks to exit. Check (1) gives the trader the vault's FULL redeem
    // window to unwind voluntarily first, and only a request that outlived
    // that window while still being unpayable opens this. Even then the only
    // effect is that the vault's own wSOL becomes the vault's own SOL again.
    let rent_min = Rent::get()?.minimum_balance(vault_ai.data_len());
    let available = vault_ai
        .lamports()
        .saturating_sub(rent_min)
        .saturating_sub(vault.platform_fees_owed_lamports);
    require!(
        available < vault.pending_withdraw_reserve(now),
        VaultError::SettlementNotOwed
    );
    let shortfall = vault.pending_withdraw_reserve(now).saturating_sub(available);

    // Captured before the close: afterwards the account holds nothing.
    let unwrapped = ctx.accounts.wsol_account.to_account_info().lamports();

    // Identical vault-to-vault close to handle_unwrap_sol (destination AND
    // authority are the vault PDA).
    // NOTE: SPL has no partial-unwrap primitive — closing the native account
    // is the only way to release wrapped lamports — so this returns the whole
    // float even when `shortfall` is smaller than it. That is harmless: the
    // excess lands in the vault's own buffer, where the trader may re-wrap it
    // (wrap_sol) once the matured request has been paid.
    let vault_name = vault.name;
    let vault_creator = vault.creator;
    let vault_bump = vault.bump;
    let signer_seeds: &[&[u8]] =
        &[VAULT_SEED, vault_creator.as_ref(), vault_name.as_ref(), &[vault_bump]];
    close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.wsol_account.to_account_info(),
            destination: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        },
        &[signer_seeds],
    ))?;

    emit!(SettlementUnwrapped {
        vault: vault.key(),
        unwrapped_lamports: unwrapped,
        shortfall_lamports: shortfall,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// close_empty_ata: rent reclamation for zero-balance vault token accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct CloseEmptyAta<'info> {
    /// Trader or operator.
    pub authority: Signer<'info>,

    #[account(mut, seeds = [VAULT_SEED, vault.creator.as_ref(), vault.name.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,

    /// Any vault-owned token account with a ZERO balance. Its rent lamports
    /// return to the vault PDA (they belong to the pool — the ATA rent was
    /// paid out of pocket by whoever created it, but reclaiming to the vault
    /// keeps the rule "vault custody only grows or pays withdrawals" simple
    /// and exfiltration-free).
    #[account(
        mut,
        token::authority = vault,
        constraint = token_account.amount == 0 @ VaultError::AtaNotEmpty,
    )]
    pub token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_close_empty_ata(ctx: Context<CloseEmptyAta>) -> Result<()> {
    let vault = &ctx.accounts.vault;
    require!(
        vault.is_trade_authority(&ctx.accounts.authority.key()),
        VaultError::Unauthorized
    );

    let vault_name = vault.name;
    let vault_creator = vault.creator;
    let vault_bump = vault.bump;
    let signer_seeds: &[&[u8]] =
        &[VAULT_SEED, vault_creator.as_ref(), vault_name.as_ref(), &[vault_bump]];
    close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.token_account.to_account_info(),
            destination: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        },
        &[signer_seeds],
    ))?;
    Ok(())
}
