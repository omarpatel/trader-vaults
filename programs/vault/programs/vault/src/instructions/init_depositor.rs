//! Per-(vault, user) depositor account lifecycle.

use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::state::*;

#[derive(Accounts)]
pub struct InitDepositor<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [VAULT_SEED, vault.creator.as_ref(), vault.name.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        init,
        payer = authority,
        space = 8 + VaultDepositor::INIT_SPACE,
        seeds = [VAULT_DEPOSITOR_SEED, vault.key().as_ref(), authority.key().as_ref()],
        bump
    )]
    pub depositor: Box<Account<'info, VaultDepositor>>,

    pub system_program: Program<'info, System>,
}

pub fn handle_init_depositor(ctx: Context<InitDepositor>) -> Result<()> {
    let d = &mut ctx.accounts.depositor;
    d.bump = ctx.bumps.depositor;
    d.vault = ctx.accounts.vault.key();
    d.authority = ctx.accounts.authority.key();
    d.shares = 0;
    d.net_deposits_lamports = 0;
    d.cumulative_profit_share_lamports = 0;
    d.last_withdraw_request = WithdrawRequest::default();
    // Zero, not `now`: opening the record is not a deposit, and the B5 hold
    // is measured from the deposit that funded the shares being withdrawn.
    d.last_deposit_ts = 0;
    d.padding = [0u8; 24];
    Ok(())
}

/// Rent hygiene: a depositor with zero shares and no pending request may
/// close their record and reclaim its rent. This moves only the DEPOSITOR
/// account's own rent (paid by the same authority at init) — never vault
/// funds — so it does not extend the custody surface.
#[derive(Accounts)]
pub struct CloseDepositor<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [VAULT_SEED, vault.creator.as_ref(), vault.name.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        mut,
        close = authority,
        seeds = [VAULT_DEPOSITOR_SEED, vault.key().as_ref(), authority.key().as_ref()],
        bump = depositor.bump,
        constraint = depositor.shares == 0 @ VaultError::DepositorNotEmpty,
        constraint = !depositor.has_pending_request() @ VaultError::WithdrawRequestPending,
    )]
    pub depositor: Box<Account<'info, VaultDepositor>>,
}

pub fn handle_close_depositor(_ctx: Context<CloseDepositor>) -> Result<()> {
    Ok(())
}
