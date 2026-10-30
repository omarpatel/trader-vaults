//! Trader Vaults — trader vaults with PDA custody.
//!
//! Traders open vaults; investors deposit SOL and receive shares; the trader
//! can ONLY trade. Custody sits entirely with the Vault PDA: it holds the SOL
//! and is the authority on every token account, and the trader holds no
//! delegated key of any kind.
//!
//! ==========================================================================
//! CUSTODY SURFACE — the complete list of value flows OUT of vault custody.
//! Any diff that adds to this list is a custody change and must be treated
//! as such in review:
//!
//!   1. execute_withdraw / instant_withdraw  -> withdrawing depositor
//!      / emergency_withdraw                  + crystallized perf fee to the
//!                                              vault's trader (from proceeds)
//!   2. collect_platform_fees                -> the seed-pinned Treasury PDA
//!                                              (amount fixed by accounting,
//!                                              destination fixed by seeds)
//!
//! NOTE on (2): the platform takes 0% of profit, so `platform_fees_owed` has
//! no addend anywhere in this build and `collect_platform_fees` reverts
//! NoFeesOwed on every possible invocation for any vault created under it.
//! It is kept, inert, so that vaults carrying a pre-change accrual can still
//! be swept. Treat it as dead code with a migration purpose, not as a live
//! custody surface.
//!
//! Everything else is an inflow (init_vault seed, deposit) or vault-to-vault
//! (wrap_sol, unwrap_sol, settle_unwrap, close_empty_ata, execute_swap between
//! vault-owned token accounts). sweep_treasury moves platform revenue, not
//! vault assets. close_depositor returns the depositor record's own rent to
//! the depositor.
//!
//! LIVENESS INVARIANT: no instruction can block withdrawals — and neither can
//! any ACTOR: not the trader, not the keeper, not the platform. VaultStatus
//! and the platform kill switch gate trading and deposits only. The normally
//! priced withdrawal paths are gated solely by NAV freshness, which the
//! platform can restore by rotating the NAV keeper (set_nav_keeper); two
//! permissionless paths then guarantee the promise holds even when nobody
//! cooperates at all:
//!   - emergency_withdraw — opens on EITHER NAV_EMERGENCY_GRACE_SECONDS of
//!     keeper silence OR this depositor's own request having matured and sat
//!     unsettleable for redeem_window + WITHDRAW_REQUEST_GRACE_SECONDS. It
//!     redeems against the last posted mark less EMERGENCY_HAIRCUT_BPS, with
//!     no keeper, admin or trader involvement, and it is the ONE path that
//!     ignores other depositors' reservations — otherwise a third party's
//!     abandoned request held the escape hatch shut (B3, B10).
//!   - settle_unwrap — once a matured request is unpayable, ANYONE may push
//!     the vault's wSOL float back into the vault so that it can be paid.
//!
//! The three audit surfaces (see README.md):
//!   #1 share-math rounding  -> math.rs
//!   #2 NAV bounds           -> instructions/post_nav.rs
//!   #3 swap constraints     -> instructions/execute_swap.rs
//! ==========================================================================

use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod math;
pub mod state;

#[cfg(test)]
mod attack_tests;

use instructions::*;

// The deployed program id. It must keep matching
// target/deploy/vault-keypair.json — a mismatch makes every PDA derivation and
// CPI signature wrong at runtime, not at build time.
//
// Consistency across the repo is checked by scripts/checks/program-id.mjs.
declare_id!("HWssGCcxUdiqeEiWk3CRxuSJy6eb4aZH7g2ubo7w6Sqc");

#[program]
pub mod vault {
    use super::*;

    // ---- platform bootstrap / governance ---------------------------------

    /// One-time platform init; gated to the program upgrade authority.
    /// `nav_keeper` is the dedicated key every vault's NAV keeper is pinned
    /// to. It is deliberately an argument and not the signer: the whole point
    /// is that the key which posts NAV hourly is NOT the key that can rewrite
    /// this program (B1).
    pub fn init_platform(ctx: Context<InitPlatform>, nav_keeper: Pubkey) -> Result<()> {
        handle_init_platform(ctx, nav_keeper)
    }

    /// Stage an admin handover (two-step; see accept_admin).
    pub fn propose_admin(ctx: Context<AdminPlatformOp>, new_admin: Pubkey) -> Result<()> {
        handle_propose_admin(ctx, new_admin)
    }

    /// Commit a staged handover, signed by the incoming admin.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        handle_accept_admin(ctx)
    }

    /// Point the platform at a new NAV keeper key (admin only). Existing
    /// vaults follow via set_nav_keeper, one at a time.
    pub fn set_platform_nav_keeper(
        ctx: Context<AdminPlatformOp>,
        new_keeper: Pubkey,
    ) -> Result<()> {
        handle_set_platform_nav_keeper(ctx, new_keeper)
    }

    /// Global trade halt. Structurally unable to block withdrawals.
    pub fn set_kill_switch(ctx: Context<AdminPlatformOp>, on: bool) -> Result<()> {
        handle_set_kill_switch(ctx, on)
    }

    /// Rotate a vault's NAV keeper (platform admin only).
    pub fn set_nav_keeper(ctx: Context<SetNavKeeper>, new_keeper: Pubkey) -> Result<()> {
        handle_set_nav_keeper(ctx, new_keeper)
    }

    /// Permissionless push of accrued platform fees to the pinned treasury.
    pub fn collect_platform_fees(ctx: Context<CollectPlatformFees>) -> Result<()> {
        handle_collect_platform_fees(ctx)
    }

    /// Admin sweep of platform revenue out of the treasury.
    pub fn sweep_treasury(ctx: Context<SweepTreasury>, amount: u64) -> Result<()> {
        handle_sweep_treasury(ctx, amount)
    }

    // ---- vault lifecycle ---------------------------------------------------

    /// Create a vault; the creator becomes the trader and burns a seed
    /// deposit that permanently anchors the share price.
    pub fn init_vault(ctx: Context<InitVault>, params: InitVaultParams) -> Result<()> {
        handle_init_vault(ctx, params)
    }

    /// Trader delegates trade-only powers to a mirror-engine key.
    pub fn set_operator(ctx: Context<TraderOp>, new_operator: Pubkey) -> Result<()> {
        handle_set_operator(ctx, new_operator)
    }

    /// One-way perf-fee reduction.
    pub fn reduce_fees(ctx: Context<TraderOp>, new_perf_fee_bps: u16) -> Result<()> {
        handle_reduce_fees(ctx, new_perf_fee_bps)
    }

    /// Halt trading + new deposits on one vault (trader or platform).
    pub fn freeze_vault(ctx: Context<FreezeOp>) -> Result<()> {
        handle_freeze_vault(ctx)
    }

    /// Lift a freeze, subject to who froze (see admin.rs).
    pub fn unfreeze_vault(ctx: Context<FreezeOp>) -> Result<()> {
        handle_unfreeze_vault(ctx)
    }

    /// Irreversible wind-down: withdrawals only, forever.
    pub fn close_vault(ctx: Context<TraderOp>) -> Result<()> {
        handle_close_vault(ctx)
    }

    /// Trader-managed defense-in-depth allowlist for swap mints.
    pub fn set_mint_allowlist(
        ctx: Context<TraderOp>,
        enforce: bool,
        mints: Vec<Pubkey>,
    ) -> Result<()> {
        handle_set_mint_allowlist(ctx, enforce, mints)
    }

    // ---- NAV ---------------------------------------------------------------

    /// Keeper posts a NAV mark; deltas are capped, gains drip through the
    /// locked-profit unlock, losses hit immediately and feed the daily
    /// circuit breaker.
    pub fn post_nav(ctx: Context<PostNav>, nav_lamports: u64, mark_slot: u64) -> Result<()> {
        handle_post_nav(ctx, nav_lamports, mark_slot)
    }

    // ---- depositor flows ---------------------------------------------------

    pub fn init_depositor(ctx: Context<InitDepositor>) -> Result<()> {
        handle_init_depositor(ctx)
    }

    /// SOL in, shares out (virtual-offset pricing, floor).
    pub fn deposit(ctx: Context<Deposit>, amount_lamports: u64) -> Result<()> {
        handle_deposit(ctx, amount_lamports)
    }

    /// Start the redeem window; locks value_at_request for the worse-of rule.
    pub fn request_withdraw(ctx: Context<WithdrawRequestOp>, shares: u128) -> Result<()> {
        handle_request_withdraw(ctx, shares)
    }

    pub fn cancel_withdraw_request(ctx: Context<WithdrawRequestOp>) -> Result<()> {
        handle_cancel_withdraw_request(ctx)
    }

    /// Permissionless: clear a withdrawal request that has expired, releasing
    /// the free-SOL reservation it holds. Shares are untouched.
    pub fn clear_expired_request(ctx: Context<ClearExpiredRequest>) -> Result<()> {
        instructions::withdraw::handle_clear_expired_request(ctx)
    }

    /// Pay min(value_at_request, current value) after the window; crystallize
    /// profit share from proceeds.
    pub fn execute_withdraw(ctx: Context<ExecuteWithdraw>) -> Result<()> {
        handle_execute_withdraw(ctx)
    }

    /// Skip the window when free SOL covers it; tighter NAV staleness bound.
    pub fn instant_withdraw(ctx: Context<ExecuteWithdraw>, shares: u128) -> Result<()> {
        handle_instant_withdraw(ctx, shares)
    }

    /// Permissionless escape hatch for an abandoned NAV keeper: after
    /// NAV_EMERGENCY_GRACE_SECONDS with no post, the depositor redeems their
    /// own shares against the LAST posted mark less EMERGENCY_HAIRCUT_BPS.
    /// Reads no status and no kill switch — entitlement is unconditional.
    pub fn emergency_withdraw(ctx: Context<ExecuteWithdraw>, shares: u128) -> Result<()> {
        handle_emergency_withdraw(ctx, shares)
    }

    /// Reclaim the rent of an emptied depositor record.
    pub fn close_depositor(ctx: Context<CloseDepositor>) -> Result<()> {
        handle_close_depositor(ctx)
    }

    // ---- trading -----------------------------------------------------------

    /// The trader's only power: a Jupiter-v6-pinned, delta-verified swap
    /// between two vault-owned token accounts, signed by the vault PDA.
    pub fn execute_swap<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, ExecuteSwap<'info>>,
        data: Vec<u8>,
        max_in: u64,
        min_out: u64,
    ) -> Result<()> {
        handle_execute_swap(ctx, data, max_in, min_out)
    }

    /// Vault SOL -> vault wSOL float (trade prep; buffer-gated).
    pub fn wrap_sol(ctx: Context<WrapSol>, amount_lamports: u64) -> Result<()> {
        handle_wrap_sol(ctx, amount_lamports)
    }

    /// Close the vault wSOL account back into vault SOL (always allowed).
    pub fn unwrap_sol(ctx: Context<UnwrapSol>) -> Result<()> {
        handle_unwrap_sol(ctx)
    }

    /// Permissionless forced unwind: anyone may return the wSOL float to the
    /// vault once a MATURED withdrawal request cannot be paid out of the
    /// vault's spendable lamports. Vault-to-vault only.
    pub fn settle_unwrap(ctx: Context<SettleUnwrap>) -> Result<()> {
        handle_settle_unwrap(ctx)
    }

    /// Rent reclamation for zero-balance vault token accounts.
    pub fn close_empty_ata(ctx: Context<CloseEmptyAta>) -> Result<()> {
        handle_close_empty_ata(ctx)
    }
}
