//! Account state for the Trader Vaults vault program.
//!
//! CUSTODY MODEL (the single most important invariant in this file):
//! The `Vault` PDA is the owner of everything — it holds the SOL deposits as
//! lamports on its own account, and it is the authority on every token
//! account the vault trades through. The trader never holds a delegated key.
//! The ONLY instructions that move value from vault custody to a non-vault
//! account are the investor withdrawal instructions (which also pay the
//! crystallized performance fee) and `collect_platform_fees` (which can pay
//! only to the pinned Treasury PDA). Everything else is either an inflow or a
//! vault-to-vault move (SOL <-> vault wSOL ATA).

use anchor_lang::prelude::*;

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------
pub const VAULT_SEED: &[u8] = b"vault";
/// Vault PDA seeds are [VAULT_SEED, creator, name].
///
/// B12: the seed used to be the 32-byte name alone, on a permissionless
/// instruction. Anyone watching for a trader's launch could submit the same
/// name at a higher priority fee, take the PDA, and become `vault.trader` of
/// the name everyone was about to deposit into. Namespacing by creator makes
/// a name collision cost the squatter their own vault instead of the
/// victim's.
pub const VAULT_DEPOSITOR_SEED: &[u8] = b"vault_depositor";
/// v2: PlatformConfig gained `nav_keeper`, `pending_admin` and padding (B1).
/// An existing PDA is allocated at its creation size and this program has no
/// realloc instruction, so the new layout needs a new address. The v1 account
/// is inert - nothing in this build derives it.
pub const PLATFORM_CONFIG_SEED: &[u8] = b"platform_config_v2";
/// v2, for the same reason as PLATFORM_CONFIG_SEED: `init_platform` creates
/// both accounts with `init`, so a surviving v1 treasury makes the whole
/// bootstrap fail "already in use". The v1 treasury is inert — the platform
/// takes 0% of profit, so nothing has ever accrued to it.
pub const TREASURY_SEED: &[u8] = b"treasury_v2";

// ---------------------------------------------------------------------------
// Pinned external programs / mints
// ---------------------------------------------------------------------------
// Resolved at first build: neither `anchor_lang::solana_program::pubkey!`
// nor `Pubkey::from_str_const` (solana >= 2.0) is reachable on this stack
// (anchor 0.30.1 / solana-program 1.18.26), so these are const byte arrays
// decoded from the base58 shown beside each. Version-independent, and the
// tests assert they round-trip back to these exact addresses.
/// Jupiter Aggregator v6. execute_swap refuses to CPI anywhere else.
pub const JUPITER_V6_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
        4, 121, 213, 91, 242, 49, 192, 110,
        238, 116, 197, 110, 206, 104, 21, 7,
        253, 177, 178, 222, 163, 244, 142, 81,
        2, 177, 205, 162, 86, 188, 19, 143,
]); // JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4
/// Native (wrapped) SOL mint.
pub const WSOL_MINT: Pubkey = Pubkey::new_from_array([
        6, 155, 136, 87, 254, 171, 129, 132,
        251, 104, 127, 99, 70, 24, 192, 53,
        218, 196, 57, 220, 26, 235, 59, 85,
        152, 160, 240, 0, 0, 0, 0, 1,
]); // So11111111111111111111111111111111111111112

// ---------------------------------------------------------------------------
// Economic constants
// ---------------------------------------------------------------------------
/// Platform's share of crystallized profit, in bps.
///
/// ZERO, and it is zero in `settle_withdrawal` too. This used to be 1_000
/// while the payout code took nothing, so every vault record and every UI
/// built on it quoted depositors a 10% cut that was never charged - a
/// disclosure pointing the wrong way, frozen into per-vault immutable state.
/// The two numbers are now the same number.
pub const PLATFORM_PROFIT_BPS: u16 = 0;
pub const BPS_DENOMINATOR: u128 = 10_000;

/// Decimal-offset ("virtual shares") anti-inflation protection, the
/// OpenZeppelin ERC-4626 pattern: pricing always behaves as if
/// `VIRTUAL_SHARES` shares backed by `VIRTUAL_LAMPORTS` lamports already
/// exist. WHY: makes the classic first-depositor share-price inflation attack
/// (donate assets to inflate price, round victims' mints down to 0) lose money
/// at a 1000:1 ratio for the attacker instead of profiting.
pub const VIRTUAL_SHARES: u128 = 1_000;
pub const VIRTUAL_LAMPORTS: u128 = 1;

/// Creator's mandatory seed deposit at init_vault. These shares are recorded
/// in `Vault::seed_shares` and owned by NOBODY (economically burned).
/// WHY: a permanently-locked non-zero share supply means share price can never
/// be reset by fully emptying the vault, closing the second inflation-attack
/// door the virtual offset alone leaves ajar.
pub const MIN_SEED_LAMPORTS: u64 = 10_000_000; // 0.01 SOL

/// Dust guard on deposits.
pub const MIN_DEPOSIT_LAMPORTS: u64 = 1_000;

/// perf fee must be inside [1000, 3000] bps at init, and afterwards may only
/// ever DECREASE (reduce_fees). Floor after init is 0.
pub const MIN_PERF_FEE_BPS_AT_INIT: u16 = 1_000;
pub const MAX_PERF_FEE_BPS: u16 = 3_000;

/// Most of a vault's equity that ONE swap may move, in bps, measured on
/// whichever leg the program can price: wSOL spent on a buy, realized loss
/// against recorded cost basis on a sell.
///
/// Stands in for a price oracle. min_out is chosen by the same party that
/// chooses the route, so it bounds nothing on its own; this bounds the RATE
/// at which a bad route can drain a vault. 500 bps = 5% per trade.
pub const MAX_SWAP_EQUITY_BPS: u16 = 500;

/// Cumulative wSOL a vault may SPEND on buys in one UTC day, in bps of the
/// day's opening equity. 20_000 = 2x turnover per day.
///
/// WHY it exists: the per-trade cap above is computed against `nav_lamports`,
/// which `execute_swap` never writes, so it is a CONSTANT 5% for every trade
/// in a sequence. Twenty transactions in the same slot spent the whole book
/// and nothing counted them. This is the counter.
pub const MAX_DAILY_SWAP_SPEND_BPS: u32 = 20_000;

/// Floor on what a sell must recover, in bps of the pro-rata cost basis of
/// the tokens being sold. A clip that recovers less is refused outright.
///
/// WHY: the drain nobody capped was the SELL leg - dump the whole book into
/// an attacker-owned pool for one lamport. There is no oracle here, but the
/// vault DOES know what it paid: every buy records `wsol_basis_lamports`
/// against the mint. Recovery measured against recorded basis is a price
/// check the trader cannot author, because the basis was written by their own
/// earlier trade.
pub const MIN_SELL_RECOVERY_BPS: u16 = 5_000;

pub const SECONDS_PER_DAY: i64 = 86_400;
pub const MAX_REDEEM_WINDOW_SECONDS: i64 = 30 * SECONDS_PER_DAY;

/// Floor on the redeem window.
///
/// B4: zero was legal, and a zero window collapses request+execute into two
/// instructions of ONE transaction. That is an instant withdrawal priced off
/// `nav_staleness_seconds` (up to a day) instead of the 300-second bound
/// `instant_withdraw` is held to - a strictly better instant withdraw with a
/// 288x looser staleness gate. The worse-of rule also degenerates to
/// min(x, x) when both legs price in the same slot.
pub const MIN_REDEEM_WINDOW_SECONDS: i64 = 60 * 60; // 1 hour
pub const MAX_UNLOCK_PERIOD_SECONDS: i64 = 7 * SECONDS_PER_DAY;

/// Floor on the locked-profit drip.
///
/// The range used to start at 0, which switches the drip off: a posted gain
/// became withdrawable in the same block, so a trader could post a gain and
/// instant_withdraw straight through it. The drip is the only thing standing
/// between a NAV post and a same-block exit, so it may not be disabled.
pub const MIN_UNLOCK_PERIOD_SECONDS: i64 = 60 * 60; // 1 hour

/// After this, an unexecuted withdrawal request may be cleared by ANYONE.
///
/// A request reserves its value out of the vault's free SOL so a matured
/// withdrawal can never be stranded. Cancelling required the requester's own
/// signature, so a depositor who requested and walked away left that
/// reservation in place forever — freezing instant withdrawals for every
/// other depositor, permanently, with no one able to undo it.
///
/// Expiry makes the reservation self-healing. Clearing an expired request
/// only releases the reservation; the depositor keeps every share and can
/// request again at any time.
/// B3b: this was a flat 14 days, measured against a redeem window that may
/// be up to 30. On any vault with a window over 14 days there was a stretch
/// in which ANYONE could delete a request that was not yet executable - clear
/// at day 14, depositor re-requests, cleared again at day 14, forever. The
/// grace is now added to the vault's own window, so an expiring request has
/// always been executable first.
pub const WITHDRAW_REQUEST_GRACE_SECONDS: i64 = 14 * SECONDS_PER_DAY;

/// Bounds on the configurable NAV staleness window used to gate
/// deposits/withdrawals.
pub const MIN_NAV_STALENESS_SECONDS: i64 = 60;
/// B4: was a full day. A day-old mark is not a price, and every normally
/// priced path accepts it. Six hours is still generous for a keeper that is
/// supposed to post hourly.
pub const MAX_NAV_STALENESS_SECONDS: i64 = 6 * 3_600;

/// Instant withdrawals additionally require the NAV to be at most this old,
/// regardless of the vault's configured staleness window. WHY: instant
/// withdrawals skip the redeem window, so a stale mark is directly arbitrable
/// against remaining depositors.
pub const INSTANT_WITHDRAW_MAX_NAV_STALENESS_SECONDS: i64 = 300;

/// How long the posted NAV must have been stale before the permissionless
/// emergency withdrawal path (`emergency_withdraw`) opens.
/// WHY it exists: every normal withdrawal path gates on `assert_nav_fresh`, so
/// a keeper that stops posting — or a platform that declines to rotate it —
/// would otherwise freeze withdrawal ENTITLEMENT indefinitely. Entitlement
/// must never depend on a live keeper, a responsive admin or a cooperative
/// trader; that is the platform's core promise.
/// WHY 7 days: the configurable window tops out at MAX_NAV_STALENESS_SECONDS
/// (1 day), so a full week of silence is unambiguously an abandoned keeper
/// rather than a late post, and it leaves the platform ample time to rotate
/// the keeper (platform.rs::set_nav_keeper) before anyone has to exit on an
/// old mark. It is also >= MAX_UNLOCK_PERIOD_SECONDS, so by the time this path
/// opens the locked-profit drip has always fully unlocked.
pub const NAV_EMERGENCY_GRACE_SECONDS: i64 = 7 * SECONDS_PER_DAY;

/// Haircut applied to the GROSS value of shares redeemed against a stale mark
/// through `emergency_withdraw`, before any fee crystallization.
/// WHY: a week-old mark is not a fair price, and it is the ONE price this path
/// can use. The haircut makes exiting on it strictly worse than waiting for a
/// fresh post (so nobody can farm the escape hatch or arbitrage a stale-high
/// mark), and the withheld lamports stay in NAV backing the shares that
/// remain — the emergency exit is paid for by the depositor who takes it.
pub const EMERGENCY_HAIRCUT_BPS: u16 = 500; // 5%

/// Complement of EMERGENCY_HAIRCUT_BPS: the fraction of the stale-mark gross
/// an emergency withdrawer is actually paid. Derived rather than written twice
/// so the two can never drift apart, and used directly by the payout math so
/// the rounding dust falls to the pool (see math.rs's rounding policy).
pub const EMERGENCY_PAYOUT_BPS: u16 = 10_000 - EMERGENCY_HAIRCUT_BPS;

/// Bounds on the per-post NAV delta cap (bps of previous NAV).
pub const MIN_NAV_DELTA_BPS: u16 = 100; // 1%
pub const MAX_NAV_DELTA_BPS: u16 = 5_000; // 50%

/// Hard ceiling on TOTAL keeper-posted NAV movement in one UTC day, up or
/// down, as bps of the day's opening equity.
///
/// B1: the per-post cap is multiplicative, and the only thing forcing time to
/// pass between posts was `now > nav_posted_at` - one post per unix SECOND,
/// not one per unit of value. 124 posts at -20% each put NAV at 1 lamport in
/// 124 seconds; 38 more restored it. This is the bound that actually has a
/// time dimension: whatever the per-post cap is, the day's total move is
/// clamped here, so walking a mark down to dust takes weeks of public marks
/// instead of two minutes.
///
/// Separate from `daily_loss_limit_bps`, which is a per-vault RISK setting
/// the admin can reset by unfreezing. This one is a program constant with no
/// override anywhere.
pub const MAX_DAILY_NAV_MOVE_BPS: u16 = 5_000; // 50% of day-open equity

/// A single post moving more than this fraction of the previous mark is
/// "large" and starts a deposit cooldown.
pub const LARGE_NAV_MOVE_BPS: u16 = 1_000; // 10%

/// How long deposits are suspended after a large NAV move.
///
/// B1 step 2 is the whole attack: crushing the mark is worthless unless you
/// can BUY at the crushed price. Ten percent in one post is either real news
/// worth pausing on or someone walking the mark; both are reasons not to mint
/// shares against it for an hour. Withdrawals are deliberately untouched -
/// nothing in this program may ever gate an exit.
pub const DEPOSIT_COOLDOWN_SECONDS: i64 = 3_600;

/// B5: minimum hold between a deposit and an INSTANT withdrawal by the same
/// depositor. The drip stops a same-block sandwich around a NAV post; this
/// stops the same play stretched across the drip period by someone who
/// deposits, waits for the unlock, and exits with a slice of profit they were
/// present for but did not fund. Request/execute is unaffected - its redeem
/// window is already at least this long.
pub const MIN_DEPOSIT_HOLD_SECONDS: i64 = 3_600;

/// A NAV mark must have been computed at a slot at most this far behind the
/// slot at which post_nav executes (~5 minutes at 400ms slots). WHY: prevents
/// the keeper replaying an old favorable mark as if it were fresh.
pub const MAX_NAV_MARK_AGE_SLOTS: u64 = 750;

/// Global cap on posted NAV (10M SOL). WHY: guarantees u128 headroom for
/// `shares * equity` products everywhere in share math:
/// max total_shares ~= MAX_NAV * VIRTUAL_SHARES = 1e19, times MAX_NAV = 1e35,
/// comfortably below u128::MAX (~3.4e38).
pub const MAX_NAV_LAMPORTS: u64 = 10_000_000_000_000_000;

/// Hard cap on `total_shares` (B9).
///
/// math.rs asserted this bound and NOTHING enforced it. The claim was that
/// MAX_NAV_LAMPORTS bounds equity and therefore bounds shares; it does not.
/// The mint rate is (S + 1000) / (E + 1), which grows without bound as E
/// falls toward 1 while S stays large - so a crushed mark plus one deposit
/// takes S to ~5e20, and two more cycles overflow the u128 product inside
/// `value_for_shares`. Every withdrawal path calls it first, so the vault
/// would revert MathOverflow on every exit, permanently, curable only by a
/// program upgrade.
pub const MAX_TOTAL_SHARES: u128 = 10_000_000_000_000_000_000; // 1e19

/// Bounds on the per-vault daily loss breaker. Zero used to be legal, which
/// switched the breaker off entirely with no instruction anywhere to switch
/// it back on (B13).
pub const MIN_DAILY_LOSS_LIMIT_BPS: u16 = 100; // 1%
pub const MAX_DAILY_LOSS_LIMIT_BPS: u16 = 5_000; // 50%

/// Ceiling on a vault's per-trade wSOL notional cap. u64::MAX was accepted
/// with no validation at all, and it was the platform's own default (B13).
pub const MAX_TRADE_NOTIONAL_CEILING: u64 = 1_000_000_000_000_000; // 1M SOL

pub const MAX_ALLOWED_MINTS: usize = 8;

/// Distinct non-SOL mints a vault may hold a recorded cost basis in at once.
pub const MAX_POSITIONS: usize = 8;

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum VaultType {
    /// Trader manages positions by hand.
    Managed,
    /// Positions are mirrored by an off-chain engine via the `operator` key.
    Mirror,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum VaultStatus {
    Active,
    /// Trading (and new deposits) disabled. Withdrawals ALWAYS keep working —
    /// no instruction in this program checks Frozen/Closed on the withdrawal
    /// path (only NAV freshness, which the platform can restore by rotating
    /// the keeper, and which `emergency_withdraw` bypasses entirely after
    /// NAV_EMERGENCY_GRACE_SECONDS so entitlement never depends on anyone).
    Frozen,
    /// Terminal: trading and deposits permanently disabled, withdrawals only.
    Closed,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum FrozenBy {
    None,
    Trader,
    /// Frozen by platform admin — only the platform may unfreeze.
    Platform,
    /// Frozen by the daily-loss circuit breaker. The trader may unfreeze only
    /// after the UTC day rolls over; the platform may unfreeze any time (and
    /// doing so resets the day's loss accumulator).
    RiskBreaker,
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/// Global platform config. PDA: ["platform_config"].
#[account]
#[derive(InitSpace)]
pub struct PlatformConfig {
    pub bump: u8,
    pub treasury_bump: u8,
    /// Platform admin. Seeded from the program upgrade authority at
    /// init_platform so the PDA cannot be squatted on deploy, and ROTATABLE
    /// from there via propose_admin/accept_admin.
    ///
    /// B1: `admin` used to be write-once and permanently equal to the upgrade
    /// authority, and every vault's nav_keeper was pinned to it. That made
    /// one key the price oracle for every vault, the circuit-breaker referee,
    /// AND the key that can rewrite the program - and because NAV must be
    /// posted every few minutes for withdrawals to work, it had to stay
    /// online. The upgrade authority was a hot key by construction and could
    /// never be moved to a multisig without bricking the product.
    pub admin: Pubkey,
    /// Admin rotation, staged. `accept_admin` must be signed by this key
    /// before it takes effect, so a typo cannot brick platform governance.
    /// Pubkey::default() = no proposal outstanding.
    pub pending_admin: Pubkey,
    /// The key every vault's NAV keeper is pinned to. DISTINCT from `admin`:
    /// this is the one that has to be online, so it is the one that should be
    /// cheap to rotate and hold nothing else. It cannot upgrade the program,
    /// cannot unfreeze a breaker, cannot sweep the treasury.
    pub nav_keeper: Pubkey,
    /// Platform-wide kill switch. Freezes NEW trades (and trade-prep wraps)
    /// across every vault. DELIBERATELY consulted by no withdrawal-path
    /// instruction: the platform must never be able to trap investor funds.
    pub kill_switch: bool,
    /// Reserved so the next field does not need another seed bump.
    pub padding: [u8; 128],
}

/// Lamport sink for platform fees. PDA: ["treasury"]. Owned by this program;
/// carries no state beyond the discriminator. `collect_platform_fees` can pay
/// only to this address because the account is constrained by seeds.
#[account]
#[derive(InitSpace)]
pub struct Treasury {}

/// A recorded non-SOL holding and what the vault PAID for it.
///
/// This is the only price information in the program that the trade authority
/// cannot author: `wsol_basis_lamports` is written by the trader's own
/// earlier buy, at whatever the market gave them then. `execute_swap` uses it
/// to bound how far below cost a single sell may clip, which is what stands
/// in for the oracle this program does not have.
///
/// `mint == Pubkey::default()` marks an empty slot.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct Position {
    pub mint: Pubkey,
    /// Tokens bought through execute_swap and not yet sold through it.
    pub token_amount: u64,
    /// wSOL lamports spent acquiring exactly those tokens.
    pub wsol_basis_lamports: u64,
}

/// One withdrawal request. `shares == 0` means "no pending request".
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct WithdrawRequest {
    pub shares: u128,
    /// Share value at request time. Final payout is
    /// min(value_at_request, value_at_execution) — the "worse-of" rule, so a
    /// depositor can never lock in a stale high price by requesting early.
    pub value_at_request_lamports: u64,
    pub requested_at: i64,
}

/// A trader's vault. PDA: ["vault", creator, name]. This account also
/// physically holds the vault's SOL as lamports on itself.
#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub bump: u8,
    /// Fixed 32-byte name; unique PER CREATOR (see VAULT_SEED).
    pub name: [u8; 32],
    /// The key that created this vault. Part of the PDA seeds, so it is
    /// immutable by construction and safe to re-derive from. Stored
    /// separately from `trader` so that adding a trader-transfer instruction
    /// later cannot silently change where the vault lives.
    pub creator: Pubkey,
    /// The trader. Has NO custody: the only powers this key carries are
    /// execute_swap / wrap / unwrap / close_empty_ata / admin-of-own-vault.
    pub trader: Pubkey,
    /// Optional delegated trading key (mirror engine). Pubkey::default = unset.
    /// Holds exactly the trader's trade-only powers, nothing more.
    pub operator: Pubkey,
    /// Pinned at init to `PlatformConfig::nav_keeper`, which is DISTINCT
    /// from the platform admin and from the upgrade authority (B1).
    /// Key allowed to post NAV marks. Appointed at init; rotatable ONLY by the
    /// platform admin (NOT the trader — a trader-controlled keeper could mark
    /// its own book and mint itself profit).
    pub nav_keeper: Pubkey,
    pub vault_type: VaultType,
    pub status: VaultStatus,
    pub frozen_by: FrozenBy,

    // -- fees ---------------------------------------------------------------
    /// Performance fee in bps of crystallized profit. Only decreasable.
    pub perf_fee_bps: u16,
    /// Snapshot of PLATFORM_PROFIT_BPS (zero; stored for indexers, which is
    /// why it has to BE zero - see PLATFORM_PROFIT_BPS).
    pub platform_profit_bps: u16,

    // -- withdrawal timing / NAV freshness ----------------------------------
    pub redeem_window_seconds: i64,
    /// Deposits/withdrawals revert when now - nav_posted_at exceeds this.
    pub nav_staleness_seconds: i64,

    // -- share supply -------------------------------------------------------
    /// Total real shares outstanding (virtual shares are NOT included here;
    /// they exist only inside the pricing formulas).
    pub total_shares: u128,
    /// Creator's seed shares. Included in total_shares, owned by nobody,
    /// never redeemable — see MIN_SEED_LAMPORTS.
    pub seed_shares: u128,
    /// Shares held by the trader's own depositor account (manager co-invest).
    pub manager_shares: u128,

    // -- posted NAV ---------------------------------------------------------
    /// Maintained NAV in lamports: last keeper mark, adjusted by the program
    /// for every deposit (+) and withdrawal (-) since, so it is always the
    /// current best estimate of total vault value. Platform fees owed are
    /// already EXCLUDED (nav is reduced by the gross withdrawal value while
    /// the platform-fee lamports physically remain on the vault).
    pub nav_lamports: u64,
    /// Slot the keeper computed the last mark at (monotonic).
    pub nav_slot: u64,
    /// Unix time post_nav last ran (freshness gate for deposits/withdrawals).
    pub nav_posted_at: i64,

    // -- locked-profit drip (Meteora pattern) -------------------------------
    /// Profit still locked as of `locked_profit_ts`. NAV increases posted by
    /// the keeper land here and unlock linearly over unlock_period_seconds.
    /// WHY: without the drip, a depositor could sandwich a known-good NAV
    /// post (deposit right before, withdraw right after) and skim the jump.
    pub locked_profit: u64,
    pub locked_profit_ts: i64,
    pub unlock_period_seconds: i64,

    // -- NAV posting guards -------------------------------------------------
    /// Max |delta| per post as bps of previous NAV.
    pub max_nav_delta_bps: u16,

    // -- risk params --------------------------------------------------------
    /// Per-trade cap on the wSOL leg of a swap. u64::MAX = uncapped.
    pub max_trade_notional_lamports: u64,
    /// Advisory bound enforced by the off-chain engine when quoting (there is
    /// no on-chain oracle here to verify realized impact; the on-chain
    /// defenses are min_out + balance-delta checks + the NAV loss breaker).
    pub max_price_impact_bps: u16,
    /// Daily NAV-loss circuit breaker threshold, bps of day-start equity.
    /// 0 = disabled.
    pub daily_loss_limit_bps: u16,
    /// Keeper-posted NAV losses accumulated during `day_bucket`.
    pub daily_loss_accumulator: u64,
    /// Keeper-posted NAV gains accumulated during `day_bucket`. Mirrors the
    /// loss accumulator so MAX_DAILY_NAV_MOVE_BPS bounds a mark being walked
    /// UP as well as down (B1: the attack needs both legs).
    pub daily_gain_accumulator: u64,
    /// unix_timestamp / 86400 of the accumulator's day.
    pub day_bucket: i64,
    /// Effective equity at the first post_nav of the day; the breaker
    /// threshold base.
    pub day_start_equity: u64,
    /// Deposits are refused until this timestamp. Set by post_nav after a
    /// move larger than LARGE_NAV_MOVE_BPS. Withdrawals ignore it (B1).
    pub deposit_cooldown_until: i64,

    // -- swap rate limiting (B2) --------------------------------------------
    /// wSOL spent on buys during `swap_day_bucket`.
    pub daily_swap_spend_lamports: u64,
    /// unix_timestamp / 86400 of the swap accumulator's day. Kept separate
    /// from `day_bucket` because that one only rolls when the KEEPER posts,
    /// and a trader who wants a fresh budget must not be able to get one by
    /// waiting for a keeper that may never come.
    pub swap_day_bucket: i64,

    // -- SOL buffer accounting ----------------------------------------------
    /// Sum of value_at_request over all pending withdrawal requests. These
    /// lamports are RESERVED: wrap_sol and instant_withdraw cannot spend them.
    pub pending_withdraw_value_lamports: u64,
    /// Sum of shares over all pending withdrawal requests (bookkeeping).
    pub pending_withdraw_shares: u128,
    /// Platform fees crystallized but not yet swept to the treasury. These
    /// lamports sit on the vault but are excluded from NAV and from the
    /// spendable buffer.
    pub platform_fees_owed_lamports: u64,

    // -- mint allowlist -----------------------------------------------------
    /// When true, the non-SOL side of every swap must be in allowed_mints.
    /// Defense-in-depth against fat-fingered/rug-ish long-tail mints; managed
    /// by the trader, so it is NOT a trust boundary against the trader.
    pub enforce_mint_allowlist: bool,
    /// Pubkey::default() entries are empty slots.
    pub allowed_mints: [Pubkey; 8],

    // -- recorded cost basis (B2) -------------------------------------------
    /// What the vault paid for what it holds. See `Position`.
    pub positions: [Position; MAX_POSITIONS],

    /// Reserved for future upgrades without realloc.
    pub padding: [u8; 64],
}

impl Vault {
    /// Locked profit remaining right now (linear drip).
    /// ROUNDING: ceil — keeps MORE profit locked, i.e. prices shares LOWER.
    /// This is conservative for the pool on the withdrawal path (payouts are
    /// computed on the lower equity). On the deposit path the same lower
    /// equity mints dust-level extra shares; that is bounded by 1 lamport of
    /// equity and absorbed by the virtual-share offset. See math.rs.
    pub fn locked_profit_now(&self, now: i64) -> u64 {
        crate::math::locked_profit_remaining(
            self.locked_profit,
            self.locked_profit_ts,
            self.unlock_period_seconds,
            now,
        )
    }

    /// Equity used for ALL share pricing = posted NAV minus still-locked
    /// profit. Platform fees owed are already excluded from nav_lamports.
    pub fn effective_equity(&self, now: i64) -> u64 {
        self.nav_lamports.saturating_sub(self.locked_profit_now(now))
    }

    pub fn assert_nav_fresh(&self, now: i64) -> Result<()> {
        require!(
            now.saturating_sub(self.nav_posted_at) <= self.nav_staleness_seconds,
            crate::errors::VaultError::NavStale
        );
        Ok(())
    }

    /// Upper bound on what the vault still owes to PENDING withdrawal
    /// requests, re-marked at `now`.
    ///
    /// B3: this used to be the raw `pending_withdraw_value_lamports` sum - a
    /// frozen lamport figure captured at request time and never marked down.
    /// One depositor who requested at a peak and then walked away (or lost
    /// their key) reserved that peak forever, and once the book fell far
    /// enough every OTHER depositor's exit failed InsufficientSolBuffer with
    /// the cash sitting right there. `lib.rs` promised no actor could block a
    /// withdrawal; any depositor could, with one transaction and no malice.
    ///
    /// Payout is min(value_at_request, value_now) per request, and
    /// sum(min(r_i, c_i)) <= min(sum r_i, sum c_i), so the min of the two
    /// aggregates is still a valid upper bound - and it falls with NAV.
    pub fn pending_withdraw_reserve(&self, now: i64) -> u64 {
        if self.pending_withdraw_shares == 0 {
            return 0;
        }
        let equity = self.effective_equity(now);
        match crate::math::value_for_shares(
            self.pending_withdraw_shares,
            self.total_shares,
            equity,
        ) {
            // Never above the frozen sum (that is the worse-of ceiling), and
            // never above what the shares are worth now.
            Ok(current) => current.min(self.pending_withdraw_value_lamports),
            // Unreachable in practice; the conservative branch is the old
            // behaviour, which over-reserves rather than under-reserves.
            Err(_) => self.pending_withdraw_value_lamports,
        }
    }

    /// Lamports on the vault that are actually spendable (for wrapping into
    /// the trading float or paying an instant withdrawal), i.e. NOT:
    ///   - the vault account's own rent-exempt minimum,
    ///   - lamports reserved for pending withdrawal requests,
    ///   - platform fees owed to the treasury.
    /// WHY: every outflow path must run through this so one flow can never
    /// spend lamports another flow is entitled to.
    pub fn free_sol(&self, vault_account_lamports: u64, rent_exempt_min: u64, now: i64) -> u64 {
        self.free_sol_unreserved(vault_account_lamports, rent_exempt_min)
            .saturating_sub(self.pending_withdraw_reserve(now))
    }

    /// `free_sol` WITHOUT the pending-request reservation.
    ///
    /// B10: the emergency hatch exists so that entitlement never depends on
    /// anyone else acting - and then it ran the same reservation check as
    /// every other path, so a third party's stale request held the escape
    /// hatch shut too. This is the only caller that skips the reservation,
    /// and it is allowed to because a depositor taking the haircut is by
    /// definition already unable to exit any other way. The rent floor and
    /// the treasury's fees are still respected.
    pub fn free_sol_unreserved(&self, vault_account_lamports: u64, rent_exempt_min: u64) -> u64 {
        vault_account_lamports
            .saturating_sub(rent_exempt_min)
            .saturating_sub(self.platform_fees_owed_lamports)
    }

    pub fn is_trade_authority(&self, key: &Pubkey) -> bool {
        *key == self.trader || (self.operator != Pubkey::default() && *key == self.operator)
    }

    /// Total keeper-posted NAV movement allowed in one UTC day, either
    /// direction, measured against the day's opening equity (B1).
    pub fn daily_nav_move_cap(&self) -> u64 {
        crate::math::mul_bps_floor(self.day_start_equity, MAX_DAILY_NAV_MOVE_BPS)
    }

    pub fn daily_loss_threshold(&self) -> u64 {
        // ROUNDING: floor — a lower threshold trips the breaker EARLIER,
        // which favors the pool.
        crate::math::mul_bps_floor(self.day_start_equity, self.daily_loss_limit_bps)
    }

    /// True when the daily breaker is configured and today's accumulated
    /// keeper-posted losses exceed the threshold.
    pub fn daily_loss_breached(&self, now: i64) -> bool {
        self.daily_loss_limit_bps > 0
            && self.day_bucket == now.div_euclid(SECONDS_PER_DAY)
            && self.daily_loss_accumulator > self.daily_loss_threshold()
    }

    // -- recorded cost basis (B2) -------------------------------------------

    fn position_index(&self, mint: &Pubkey) -> Option<usize> {
        self.positions.iter().position(|p| p.mint == *mint)
    }

    /// Record tokens bought with wSOL. Opens a slot if the mint is new.
    pub fn position_add(&mut self, mint: Pubkey, tokens: u64, wsol_spent: u64) -> Result<()> {
        let idx = match self.position_index(&mint) {
            Some(i) => i,
            None => self
                .positions
                .iter()
                .position(|p| p.mint == Pubkey::default())
                .ok_or(crate::errors::VaultError::TooManyPositions)?,
        };
        let slot = &mut self.positions[idx];
        slot.mint = mint;
        slot.token_amount = slot
            .token_amount
            .checked_add(tokens)
            .ok_or(crate::errors::VaultError::MathOverflow)?;
        slot.wsol_basis_lamports = slot
            .wsol_basis_lamports
            .checked_add(wsol_spent)
            .ok_or(crate::errors::VaultError::MathOverflow)?;
        Ok(())
    }

    /// Pro-rata cost basis of `tokens` of `mint`, and the bookkeeping to
    /// remove them. Returns the basis being given up.
    ///
    /// ROUNDING: ceil on the basis released, so a sequence of partial sells
    /// can never leave a residual basis larger than the truth - understating
    /// the basis would understate the realized loss, which is the number the
    /// caller uses as a safety bound.
    pub fn position_remove(&mut self, mint: &Pubkey, tokens: u64) -> Result<u64> {
        let idx = self
            .position_index(mint)
            .ok_or(crate::errors::VaultError::UnknownPosition)?;
        let slot = &mut self.positions[idx];
        require!(
            tokens <= slot.token_amount,
            crate::errors::VaultError::UnknownPosition
        );
        let basis_out = if tokens == slot.token_amount {
            slot.wsol_basis_lamports
        } else {
            let num = (slot.wsol_basis_lamports as u128)
                .checked_mul(tokens as u128)
                .ok_or(crate::errors::VaultError::MathOverflow)?;
            num.div_ceil(slot.token_amount as u128) as u64
        };
        slot.token_amount -= tokens;
        slot.wsol_basis_lamports = slot.wsol_basis_lamports.saturating_sub(basis_out);
        if slot.token_amount == 0 {
            *slot = Position::default();
        }
        Ok(basis_out)
    }
}

/// Per (vault, user) deposit account. PDA: ["vault_depositor", vault, user].
#[account]
#[derive(InitSpace)]
pub struct VaultDepositor {
    pub bump: u8,
    pub vault: Pubkey,
    pub authority: Pubkey,
    pub shares: u128,
    /// Principal: lamports deposited minus principal returned. Reduced
    /// proportionally (by share fraction) on every withdrawal, so the
    /// remaining position always keeps its pro-rata cost basis.
    pub net_deposits_lamports: u64,
    /// Lifetime profit crystallized (fee'd) for this depositor. Monotone
    /// ratchet — the per-depositor high-water record in the Drift pattern.
    /// See withdraw.rs for how the exit-realization scheme uses it.
    pub cumulative_profit_share_lamports: u64,
    pub last_withdraw_request: WithdrawRequest,
    /// Unix time of this depositor's most recent deposit. Gates
    /// `instant_withdraw` for MIN_DEPOSIT_HOLD_SECONDS (B5).
    pub last_deposit_ts: i64,
    pub padding: [u8; 24],
}

impl VaultDepositor {
    pub fn has_pending_request(&self) -> bool {
        self.last_withdraw_request.shares != 0
    }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct VaultInitialized {
    pub vault: Pubkey,
    pub trader: Pubkey,
    pub seed_lamports: u64,
    pub seed_shares: u128,
}

#[event]
pub struct Deposited {
    pub vault: Pubkey,
    pub depositor: Pubkey,
    pub amount_lamports: u64,
    pub shares_minted: u128,
    pub total_shares: u128,
    pub nav_lamports: u64,
}

#[event]
pub struct WithdrawRequested {
    pub vault: Pubkey,
    pub depositor: Pubkey,
    pub shares: u128,
    pub value_at_request_lamports: u64,
}

#[event]
pub struct WithdrawExecuted {
    pub vault: Pubkey,
    pub depositor: Pubkey,
    pub instant: bool,
    pub shares_burned: u128,
    pub gross_lamports: u64,
    pub payout_lamports: u64,
    pub trader_fee_lamports: u64,
    pub platform_fee_lamports: u64,
}

/// Emitted by the permissionless stale-NAV escape hatch. Kept separate from
/// `WithdrawExecuted` so indexers can never mistake an emergency exit (priced
/// on an abandoned mark, haircut applied) for a normally priced withdrawal.
#[event]
pub struct EmergencyWithdrawExecuted {
    pub vault: Pubkey,
    pub depositor: Pubkey,
    pub shares_burned: u128,
    /// The stale mark the redemption was priced against, and its age.
    pub stale_nav_lamports: u64,
    pub nav_age_seconds: i64,
    /// Value of the shares at the stale mark, before EMERGENCY_HAIRCUT_BPS.
    pub gross_before_haircut_lamports: u64,
    /// After the haircut; this is what fees were crystallized on.
    pub gross_lamports: u64,
    pub payout_lamports: u64,
    pub trader_fee_lamports: u64,
    pub platform_fee_lamports: u64,
}

/// Emitted by the permissionless forced unwind (`settle_unwrap`).
#[event]
pub struct SettlementUnwrapped {
    pub vault: Pubkey,
    /// Lamports the closed wSOL account returned to the vault (wrapped
    /// balance + that account's rent).
    pub unwrapped_lamports: u64,
    /// How far the vault was short of its pending withdrawal reservations at
    /// the moment settlement was forced.
    pub shortfall_lamports: u64,
}

#[event]
pub struct NavPosted {
    pub vault: Pubkey,
    pub nav_lamports: u64,
    pub nav_slot: u64,
    pub locked_profit: u64,
    pub daily_loss_accumulator: u64,
    pub deposit_cooldown_until: i64,
    pub frozen_by_breaker: bool,
}

#[event]
pub struct SwapExecuted {
    pub vault: Pubkey,
    pub authority: Pubkey,
    pub source_mint: Pubkey,
    pub dest_mint: Pubkey,
    pub in_delta: u64,
    pub out_delta: u64,
}

#[event]
pub struct VaultStatusChanged {
    pub vault: Pubkey,
    pub status: VaultStatus,
    pub frozen_by: FrozenBy,
}

#[cfg(test)]
mod size_tests {
    use super::*;
    use anchor_lang::Space;

    /// Account sizes are a deployment fact: the API's `getProgramAccounts`
    /// filters match on dataSize, and a silent change orphans every indexer.
    /// Printed rather than asserted against a magic number so a deliberate
    /// layout change shows up in the test output instead of failing on a
    /// constant somebody then edits to match.
    #[test]
    fn print_account_sizes() {
        println!("Vault          = {}", 8 + Vault::INIT_SPACE);
        println!("VaultDepositor = {}", 8 + VaultDepositor::INIT_SPACE);
        println!("PlatformConfig = {}", 8 + PlatformConfig::INIT_SPACE);
        assert!(8 + Vault::INIT_SPACE < 10_240);
    }
}
