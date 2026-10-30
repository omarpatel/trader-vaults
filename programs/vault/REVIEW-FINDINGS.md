# Adversarial source review — 2026-08-18 (pre-compile)

Source-level review before any build/deploy. **Custody invariants verified as holding**
(no path moves vault funds to the trader; share-math rounding favors the pool everywhere;
worse-of is on the correct side; fee ≤ proceeds; re-init guards present; execute_swap's
third-ATA drain guard and post-CPI delta checks are sound). The material findings were
liveness-side. **Update 2026-08-22:** the two blockers (H1, H2) are fixed in source —
see **Fixed** below; the M/L items remain open.

## Fixed

Both pre-deploy blockers are implemented in source (not yet compiled — no MSVC host
linker on the authoring machine; first `anchor build` still has to confirm the two
`NOTE(api)` items called out below).

- **H1 — Stale-NAV freeze has no permissionless escape.** *Fixed:* new instruction
  `emergency_withdraw(shares)` (`instructions/withdraw.rs`, registered in `lib.rs`,
  reusing the existing `ExecuteWithdraw` accounts struct — depositor signs, trader
  account pinned by `address = vault.trader` to receive the crystallized perf fee).
  - Opens when `now - vault.nav_posted_at >= NAV_EMERGENCY_GRACE_SECONDS`
    (`state.rs`, 7 days) — otherwise `NavNotStaleEnough`. It is the exact mirror of
    `assert_nav_fresh`, so it is never reachable while the normally priced paths are.
  - Prices the shares on the **last posted mark** via the same `effective_equity` +
    `math::value_for_shares` (floor) used everywhere else, then applies the haircut to
    the **gross, before fees**: `gross = mul_bps_floor(gross_before_haircut,
    EMERGENCY_PAYOUT_BPS)` with `EMERGENCY_HAIRCUT_BPS = 500` (5%) and
    `EMERGENCY_PAYOUT_BPS = 10_000 - EMERGENCY_HAIRCUT_BPS`. Flooring the *retained*
    fraction (rather than the haircut) keeps the rounding dust with the pool, per
    `math.rs`'s policy. The withheld 5% never leaves the vault while the shares are
    fully burned, so remaining depositors gain per share and the hatch can never be
    farmed as an arbitrage on a stale-high mark.
  - Fee crystallization, share burn, NAV/`platform_fees_owed`/`manager_shares`
    bookkeeping and the depositor ratchet all go through the **unmodified**
    `settle_withdrawal`; payout and trader fee go out through the unmodified
    `pay_from_vault` after the standard `free_sol` buffer check.
  - Callable by the depositor alone: no keeper, no admin, no trader signature, and it
    reads **neither `vault.status` nor `platform_config.kill_switch`** (its context
    carries no `PlatformConfig` at all, so that cannot regress silently). Guarded by
    `!has_pending_request()` for spend-once safety — `cancel_withdraw_request` is never
    NAV-gated, so a depositor with a stranded request can always cancel and then exit.
  - Emits the new `EmergencyWithdrawExecuted` event (separate from `WithdrawExecuted`
    so indexers can never price an emergency exit as a normal one).
  - Residual, accepted: if the book lost more than 5% since the abandoned mark, an early
    exiter still leaves with too much. There is no fresher valuation to do better with;
    the 7-day grace exists to make that window as rare as possible.
- **H2 — No forced unwind for settlement.** *Fixed:* new permissionless instruction
  `settle_unwrap` (`instructions/sol_ops.rs`, registered in `lib.rs`). The existing
  trade-authority `unwrap_sol` / `close_empty_ata` paths are untouched.
  - No signer field at all (same shape as `collect_platform_fees`): destination is fixed
    by seeds and the amount by the token account's own balance, so "who called" carries
    no authority.
  - Runs **only when settlement is genuinely owed**, both conditions required:
    (1) a witness `VaultDepositor` of this vault (`has_one = vault`, read-only) whose
    request is pending and matured — `now - requested_at >= vault.redeem_window_seconds`
    — else `NoWithdrawRequest` / `RedeemWindowNotElapsed`; and (2) the vault physically
    cannot pay it: `lamports - rent_min - platform_fees_owed < pending_withdraw_value`,
    else `SettlementNotOwed`. A shortfall alone is normal for a deployed book; the
    maturity check gives the trader the vault's full redeem window to unwind first,
    which is what makes this non-griefable.
  - Closes the vault's wSOL ATA with `destination = authority = vault PDA`, i.e. strictly
    vault-to-vault — no caller can name a third party or profit from calling it. SPL has
    no partial-unwrap primitive, so the whole float returns even when the shortfall is
    smaller; the excess lands in the vault's own buffer and the trader may re-wrap it.
    Deliberately not status-gated, exactly like `unwrap_sol`.
  - Emits the new `SettlementUnwrapped` event.

## Fix when convenient (P1)

- **M1** — Token-spend side of `execute_swap` is uncapped (`min_out` can be 1): a hostile
  trader can dump an entire position into an attacker pool in one trade. Within the
  documented trust model, but add a token-side cap or a min-out floor vs a reference
  price, and disclose the residual risk.
- **L1** — `wrap_sol` skips the daily-loss-breaker guard (`execute_swap` has it): add it.
- **L2** — Stale-high marks are arbitrageable until the keeper posts a loss: set
  `nav_staleness_seconds` much tighter than the 1-day max in production; document.
- **L3** — Gain posts relock *all* outstanding locked profit (drip clock restarts):
  decay only the incremental gain.

## Notes / accepted

- **I1** — A hostile keeper yo-yoing NAV within delta caps can push `total_shares`
  toward u128 overflow → safe `MathOverflow` deposit-DoS, not fund loss. Off-chain
  keeper rate-limiting required.
- **I2** — Direct lamport donations aren't in NAV (this is what makes share price
  donation-proof); surplus sits unattributed until a keeper mark absorbs it.
- **I3** — `init_platform` requires an upgradeable deploy with caller as upgrade
  authority; an immutable deploy can never initialize. Deployment-time note.
- Author-tagged `NOTE(api)` items (pubkey! path, div_ceil, programdata_address, spl
  features, and the self-referential `seeds` expression on `SettleUnwrap::depositor`)
  remain to verify at first `anchor build`; reviewer found no additional
  likely-miscompile in unmarked code.
