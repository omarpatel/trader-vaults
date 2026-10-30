use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    // -- generic ------------------------------------------------------------
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Invalid parameter")]
    InvalidParameter,
    #[msg("Invalid program data account")]
    InvalidProgramData,

    // -- vault lifecycle ----------------------------------------------------
    #[msg("Vault is not active")]
    VaultNotActive,
    #[msg("Vault is not frozen")]
    VaultNotFrozen,
    #[msg("Vault was frozen by the platform; only the platform can unfreeze")]
    PlatformFrozen,
    #[msg("Risk-breaker freeze: trader may unfreeze only after the UTC day rolls over")]
    BreakerCooldown,
    #[msg("Vault is closed")]
    VaultClosed,

    // -- deposits / shares --------------------------------------------------
    #[msg("Deposit below minimum")]
    DepositTooSmall,
    #[msg("Seed deposit below minimum")]
    SeedTooSmall,
    #[msg("Computed shares are zero")]
    ZeroShares,
    #[msg("Vault equity is zero; share pricing impossible")]
    ZeroEquity,
    #[msg("Vault NAV would exceed the global cap")]
    NavCapExceeded,
    #[msg("Insufficient shares")]
    InsufficientShares,

    // -- withdrawals --------------------------------------------------------
    #[msg("A withdrawal request is already pending")]
    WithdrawRequestPending,
    #[msg("No withdrawal request pending")]
    NoWithdrawRequest,
    #[msg("Redeem window has not elapsed")]
    RedeemWindowNotElapsed,
    #[msg("Vault SOL buffer cannot cover this withdrawal right now")]
    InsufficientSolBuffer,
    #[msg("Posted NAV too stale for an instant withdrawal")]
    NavTooStaleForInstant,
    #[msg("Posted NAV is not stale enough to use the emergency withdrawal path")]
    NavNotStaleEnough,
    #[msg("No matured withdrawal request is unpayable; forced unwind is not available")]
    SettlementNotOwed,

    // -- NAV keeper ---------------------------------------------------------
    #[msg("Signer is not the vault's NAV keeper")]
    InvalidNavKeeper,
    #[msg("Posted NAV is stale; deposits and withdrawals are gated until a fresh post")]
    NavStale,
    #[msg("NAV mark slot must be monotonically increasing and not in the future")]
    NavSlotNotMonotonic,
    #[msg("NAV mark was computed too many slots ago")]
    NavMarkTooOld,
    #[msg("NAV delta exceeds the per-post cap")]
    NavDeltaTooLarge,

    // -- trading ------------------------------------------------------------
    #[msg("Trading is halted by the platform kill switch")]
    TradingHalted,
    #[msg("Daily loss circuit breaker is tripped")]
    DailyLossBreached,
    #[msg("Swap program must be Jupiter v6")]
    InvalidJupiterProgram,
    #[msg("Source and destination token accounts must differ")]
    SameTokenAccount,
    #[msg("One side of the swap must be the vault's wSOL account")]
    MissingWsolLeg,
    #[msg("Swap mint is not on the vault's allowlist")]
    MintNotAllowed,
    #[msg("min_out must be greater than zero")]
    ZeroMinOut,
    #[msg("Swap output below min_out")]
    SlippageExceeded,
    #[msg("Swap consumed more than max_in from the source account")]
    MaxInExceeded,
    #[msg("Swap notional exceeds the per-trade cap")]
    NotionalTooLarge,
    #[msg("A vault-owned token account other than source/destination was passed to the swap")]
    ForeignVaultTokenAccount,

    // -- token ops ----------------------------------------------------------
    #[msg("Token account is not empty")]
    AtaNotEmpty,
    #[msg("Token account mint must be wSOL")]
    NotWsol,
    #[msg("Invalid trader fee account")]
    InvalidTraderAccount,

    // -- fees ---------------------------------------------------------------
    #[msg("Fee can only be reduced")]
    FeeNotReduced,
    #[msg("No platform fees to collect")]
    NoFeesOwed,

    // -- depositor lifecycle ------------------------------------------------
    #[msg("Depositor account still holds shares")]
    DepositorNotEmpty,

    // -- NAV rate limiting (B1) ---------------------------------------------
    #[msg("Daily NAV movement cap exceeded")]
    DailyNavMoveExceeded,
    #[msg("Posted NAV is below the vault's own unencumbered lamport balance")]
    NavBelowLamports,
    #[msg("Deposits are paused after a large NAV move")]
    DepositCooldown,

    // -- swap rate limiting / cost basis (B2) -------------------------------
    #[msg("Vault already holds the maximum number of distinct positions")]
    TooManyPositions,
    #[msg("Vault has no recorded cost basis for this mint")]
    UnknownPosition,
    #[msg("Daily swap spend cap exceeded")]
    DailySwapSpendExceeded,
    #[msg("Sale recovers too little against the recorded cost basis")]
    SellBelowBasisFloor,

    // -- share supply (B9) ---------------------------------------------------
    #[msg("Total share supply cap exceeded")]
    ShareCapExceeded,

    // -- deposit hold (B5) ---------------------------------------------------
    #[msg("Instant withdrawal is not available this soon after a deposit")]
    DepositHoldNotElapsed,

    // -- platform governance (B1) --------------------------------------------
    #[msg("No admin transfer is pending")]
    NoPendingAdmin,
}
