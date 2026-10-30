# Trader Vaults Vault Program

On-chain core of Trader Vaults: traders open vaults, investors deposit SOL and
receive shares, and the trader's **only** power is routing swaps through
Jupiter v6 with the vault PDA signing. Written for **Anchor 0.30.1**; the
source has never been compiled on this machine (no Rust toolchain on the
authoring host) — build it in WSL/CI per below before trusting anything.

## Layout

```
programs/vault/            <- this Anchor workspace
├── Anchor.toml
├── Cargo.toml             <- cargo workspace (overflow-checks = on in release)
├── package.json           <- test harness deps (ts-mocha, @coral-xyz/anchor)
├── tsconfig.json
├── tests/vault.ts         <- mocha skeleton (share math + swap rejections)
└── programs/vault/
    ├── Cargo.toml
    └── src/
        ├── lib.rs         <- instruction table + custody-surface inventory
        ├── state.rs       <- Vault / VaultDepositor / PlatformConfig / Treasury
        ├── math.rs        <- share math + rounding policy (audit surface #1)
        ├── errors.rs
        └── instructions/
            ├── init_platform.rs   <- upgrade-authority-gated bootstrap
            ├── init_vault.rs      <- burned seed deposit
            ├── init_depositor.rs
            ├── deposit.rs
            ├── withdraw.rs        <- request/execute/instant/cancel, fees
            ├── post_nav.rs        <- NAV bounds + drip + breaker (surface #2)
            ├── execute_swap.rs    <- pinned Jupiter CPI (surface #3)
            ├── sol_ops.rs         <- wrap/unwrap/close_empty_ata (vault-to-vault)
            ├── admin.rs           <- operator/fees/freeze/close/allowlist
            └── platform.rs        <- kill switch, keeper rotation, treasury
```

## Building in WSL

```bash
# 1. Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# 2. Solana CLI (Agave)
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# 3. Anchor 0.30.1 via avm
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install 0.30.1 && avm use 0.30.1

# 4. Build + stamp the real program id
cd programs/vault          # this directory (the Anchor workspace root)
anchor build
anchor keys sync           # replaces the placeholder id in lib.rs + Anchor.toml
anchor build               # rebuild with the real id

# 5. Unit tests (pure Rust share-math tests) and the mocha suite
cargo test -p vault
yarn install && anchor test
```

## Trust model

Investor funds live exclusively with the Vault PDA (its own lamports plus
token accounts it is the authority of); the trader holds no key that can move
them — their entire power is `execute_swap`, which only CPIs the pinned
Jupiter v6 program between two vault-owned token accounts and verifies actual
balance deltas afterwards. Investors trust: (1) the **trader** for trading
skill and for keeping enough SOL unwound that withdrawals clear (the notional
cap, daily-loss breaker, and freeze powers bound how wrong this can go);
(2) the platform-appointed **NAV keeper** to mark the book honestly — clamped
per post by delta caps, slot monotonicity/recency, and the locked-profit drip
that makes marked gains unlock gradually; and (3) the **platform admin**, who
can halt trading (kill switch / freeze) and rotate keepers, but who has no
instruction available that withdraws vault assets or blocks investor
withdrawals — the withdrawal path checks NAV freshness only, and keeper
rotation restores freshness. Fees can only decrease post-init, and platform
fees can only ever land on the seed-pinned Treasury PDA.

## Audit checklist — the three surfaces

**1. Share-math rounding (`math.rs`, `withdraw.rs::settle_withdrawal`)**
- [ ] Every division rounds in the vault's favor: deposit share mint = floor,
      withdrawal value = floor, withdrawn cost basis = floor (fees never
      undercharged), fee amounts = floor (paid from proceeds, can never
      overdraw), locked-profit remaining = ceil.
- [ ] Virtual offset (1000 shares : 1 lamport) + burned creator seed shares
      together make first-depositor inflation unprofitable; verify with the
      `inflation_attack_is_unprofitable` and `round_trip_never_profits`
      unit tests.
- [ ] All intermediates are u128 `checked_*`; `MAX_NAV_LAMPORTS` (1e16)
      guarantees `shares * equity` headroom. `overflow-checks = true` in the
      release profile as a backstop.
- [ ] Worse-of rule: payout = min(value_at_request, current value); the
      surplus in either direction stays with remaining shareholders.

**2. NAV bounds (`post_nav.rs`)**
- [ ] Only the appointed keeper posts; keeper rotation is platform-only.
- [ ] Mark slot strictly increasing, not in the future, at most
      `MAX_NAV_MARK_AGE_SLOTS` old; per-post delta capped at
      `max_nav_delta_bps` (note: N consecutive posts can compound N caps —
      rate-limit the keeper off-chain or lower the cap if this matters).
- [ ] Gains drip via locked-profit (ceil) over `unlock_period_seconds`;
      losses hit share pricing immediately and are never smoothed.
- [ ] Deposits/withdrawals revert on stale NAV; instant withdrawals use the
      stricter 300s bound.
- [ ] Daily-loss breaker freezes TRADING only; confirm no withdrawal-path
      instruction reads `VaultStatus` or the kill switch (grep for
      `VaultStatus` in withdraw.rs — there must be no hit).

**3. execute_swap account constraints (`execute_swap.rs`)**
- [ ] CPI program pinned to `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`.
- [ ] source/dest are `token::authority = vault` accounts; one leg must be
      wSOL (makes the notional cap verifiable on-chain).
- [ ] remaining-accounts scan rejects ANY other token account whose authority
      is the vault PDA — the third-ATA drain guard.
- [ ] Instruction data is never trusted: both accounts reloaded post-CPI;
      `in_delta <= max_in`, `out_delta >= min_out` (> 0), wSOL delta <=
      per-trade notional cap; Token-2022 transfer fees are therefore priced in.
- [ ] Vault PDA lamports are un-debitable by the CPI (program-owned account).
- [ ] Kill switch / freeze / breaker gate this instruction but no withdrawal.

## Known liveness caveat (by design, document to users)

`execute_withdraw` needs the vault to hold enough free SOL; if the trader has
everything deployed in tokens, a matured withdrawal waits until positions are
unwound (the breaker/freeze/notional caps exist to force that conversation).
Withdrawal *entitlement* is never blockable; withdrawal *settlement* is
bounded by the SOL buffer.
