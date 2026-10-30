//! Share and fee math.
//!
//! ROUNDING POLICY (audit surface #1 — every division in this program either
//! lives here or is annotated at its call site):
//!
//!   The pool (vault) must never lose to rounding. Concretely:
//!   - minting shares for a deposit rounds DOWN  (depositor gets fewer shares)
//!   - valuing shares for a withdrawal rounds DOWN (depositor gets fewer lamports)
//!   - locked-profit remaining rounds UP        (equity stays lower for longer;
//!     conservative on the withdrawal path — see note on the deposit path below)
//!   - the withdrawn cost basis rounds DOWN     (more of the payout counts as
//!     profit, so fees are never undercharged; this favors the fee recipients,
//!     never the exiting depositor, and leaves the pool untouched)
//!   - fee amounts round DOWN                   (fees are paid OUT of the
//!     depositor's proceeds; flooring can only underpay the trader/platform by
//!     dust and can never overdraw the payout)
//!   - breaker/threshold math rounds DOWN       (trips the breaker earlier)
//!
//! Deposit-path caveat for the locked-profit ceil: a lower equity mints
//! marginally MORE shares. The discrepancy is bounded by 1 lamport of equity
//! per pricing and is absorbed by the 1000:1 virtual-share offset; using two
//! different locked-profit roundings for the two paths would double the code
//! surface for a sub-lamport effect, so we deliberately do not.
//!
//! All intermediate products are u128 with checked ops. `state::MAX_NAV_LAMPORTS`
//! bounds equity at 1e16 and therefore total_shares at ~1e19, so every
//! `shares * equity` product stays below ~1e35 << u128::MAX.

use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::state::{BPS_DENOMINATOR, VIRTUAL_LAMPORTS, VIRTUAL_SHARES};

/// Shares minted for a deposit of `amount_lamports` into a pool with
/// `total_shares` real shares and `equity_lamports` effective equity.
///
/// OZ ERC-4626 decimal-offset formula:
///   shares = floor( amount * (S + VIRTUAL_SHARES) / (E + VIRTUAL_LAMPORTS) )
///
/// On an empty vault (S = 0, E = 0) this degenerates to amount * 1000 — the
/// decimal offset that makes inflation attacks unprofitable.
/// ROUNDING: floor (vault's favor).
pub fn shares_for_deposit(
    amount_lamports: u64,
    total_shares: u128,
    equity_lamports: u64,
) -> Result<u128> {
    let numerator = (amount_lamports as u128)
        .checked_mul(
            total_shares
                .checked_add(VIRTUAL_SHARES)
                .ok_or(VaultError::MathOverflow)?,
        )
        .ok_or(VaultError::MathOverflow)?;
    let denominator = (equity_lamports as u128)
        .checked_add(VIRTUAL_LAMPORTS)
        .ok_or(VaultError::MathOverflow)?;
    // denominator >= 1 always (VIRTUAL_LAMPORTS = 1), so division is safe.
    Ok(numerator / denominator)
}

/// Lamport value of `shares` against the pool.
///
///   value = floor( shares * (E + VIRTUAL_LAMPORTS) / (S + VIRTUAL_SHARES) )
///
/// ROUNDING: floor (vault's favor — the withdrawing depositor eats the dust).
/// Since shares <= total_shares < S + VIRTUAL_SHARES, the result is < E + 1,
/// i.e. it always fits u64 and can never exceed equity.
pub fn value_for_shares(shares: u128, total_shares: u128, equity_lamports: u64) -> Result<u64> {
    let numerator = shares
        .checked_mul(
            (equity_lamports as u128)
                .checked_add(VIRTUAL_LAMPORTS)
                .ok_or(VaultError::MathOverflow)?,
        )
        .ok_or(VaultError::MathOverflow)?;
    let denominator = total_shares
        .checked_add(VIRTUAL_SHARES)
        .ok_or(VaultError::MathOverflow)?;
    let value = numerator / denominator; // denominator >= VIRTUAL_SHARES > 0
    u64::try_from(value).map_err(|_| error!(VaultError::MathOverflow))
}

/// floor(x * bps / 10_000). Used for fees and the breaker threshold.
/// ROUNDING: floor — see module policy for why floor is correct at every call
/// site of this helper.
pub fn mul_bps_floor(x: u64, bps: u16) -> u64 {
    // (u64 * u16) / 1e4 cannot overflow u128; the result is <= x, fits u64.
    ((x as u128) * (bps as u128) / BPS_DENOMINATOR) as u64
}

/// floor(total * numerator / denominator) with numerator <= denominator.
/// Used to take the pro-rata slice of a depositor's cost basis.
/// ROUNDING: floor — a smaller basis means more of the payout is treated as
/// profit, so the fee take is never understated (never favors the exiting
/// depositor). Result <= total, so it fits u64.
pub fn proportional_floor(total: u64, numerator: u128, denominator: u128) -> Result<u64> {
    require!(denominator > 0, VaultError::MathOverflow);
    require!(numerator <= denominator, VaultError::MathOverflow);
    let out = (total as u128)
        .checked_mul(numerator)
        .ok_or(VaultError::MathOverflow)?
        / denominator;
    Ok(out as u64)
}

/// Meteora-style linear drip: how much of `locked_profit` is still locked at
/// `now`, given it was (re)locked at `last_ts` and unlocks over
/// `unlock_period` seconds.
///
/// ROUNDING: ceil — keeps more locked (see module policy).
pub fn locked_profit_remaining(
    locked_profit: u64,
    last_ts: i64,
    unlock_period: i64,
    now: i64,
) -> u64 {
    if unlock_period <= 0 || locked_profit == 0 {
        return 0;
    }
    // Clock going backwards (shouldn't happen; validators enforce monotonic
    // sysvar time) is treated as zero elapsed — the conservative direction.
    let elapsed = now.saturating_sub(last_ts).max(0);
    if elapsed >= unlock_period {
        return 0;
    }
    let remaining = (unlock_period - elapsed) as u128; // 0 < remaining <= period
    let period = unlock_period as u128;
    // ceil(locked * remaining / period); locked * remaining <= u64::MAX * i64::MAX
    // fits u128. Result <= locked_profit, fits u64.
    let num = (locked_profit as u128) * remaining;
    (num.div_ceil(period)) as u64
    // NOTE(api): u128::div_ceil is stable since Rust 1.73; the Solana/Anchor
    // 0.30 toolchain ships a newer rustc. If building on an ancient toolchain,
    // replace with (num + period - 1) / period.
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_vault_mints_offset_shares() {
        // First (seed) deposit on an empty vault: amount * 1000 shares.
        assert_eq!(shares_for_deposit(10_000_000, 0, 0).unwrap(), 10_000_000_000);
    }

    #[test]
    fn inflation_attack_is_unprofitable() {
        // Attacker seeds 1 lamport then "donates" 1 SOL of NAV; a victim
        // depositing 1 SOL must still receive a non-trivial share of the pool.
        let attacker_shares = shares_for_deposit(1, 0, 0).unwrap(); // 1000
        let total = attacker_shares;
        let equity = 1_000_000_001; // 1 lamport + 1 SOL donation
        let victim_shares = shares_for_deposit(1_000_000_000, total, equity).unwrap();
        assert!(victim_shares > 0);
        // Victim's redeemable value loses at most ~0.1% to the offset.
        let victim_value =
            value_for_shares(victim_shares, total + victim_shares, 2_000_000_001).unwrap();
        assert!(victim_value > 998_000_000);
    }

    #[test]
    fn round_trip_never_profits() {
        // deposit then immediate withdraw can never mint free lamports.
        for amount in [1_000u64, 12_345, 999_999_937] {
            let total: u128 = 5_000_000_000_000;
            let equity: u64 = 7_777_777_777;
            let s = shares_for_deposit(amount, total, equity).unwrap();
            let v = value_for_shares(s, total + s, equity + amount).unwrap();
            assert!(v <= amount);
        }
    }

    #[test]
    fn locked_profit_drips_linearly_and_rounds_up() {
        assert_eq!(locked_profit_remaining(1000, 0, 100, 0), 1000);
        assert_eq!(locked_profit_remaining(1000, 0, 100, 50), 500);
        assert_eq!(locked_profit_remaining(1000, 0, 100, 100), 0);
        // ceil: 1 lamport locked, 1 second into a 100s period -> still 1.
        assert_eq!(locked_profit_remaining(1, 0, 100, 1), 1);
        // period 0 = no drip.
        assert_eq!(locked_profit_remaining(1000, 0, 0, 0), 0);
    }
}
