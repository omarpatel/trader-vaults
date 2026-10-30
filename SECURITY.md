# Security

## The honest position

The Trader Vaults vault program has **not been professionally audited**. It has been
adversarially reviewed in-house and two liveness blockers were fixed, but that
is not the same thing and should not be treated as if it were.

It runs on **devnet**. Live trading and withdrawals are not enabled. An audit
is the gate on mainnet — before, not after.

If you are deciding whether to trust this with real money: don't, yet. That is
not modesty, it's the actual state of the code.

## Reporting a vulnerability

Please **do not** open a public issue for anything that could move funds.

Report privately through GitHub's advisory flow:
<https://github.com/omarpatel/trader-vaults/security/advisories/new>

Useful reports include the affected instruction or endpoint, what an attacker
gains, and a concrete path to reproduce. If you have a proof-of-concept
against devnet, include the transaction signature.

We will acknowledge, tell you what we think the severity is and why, and say
plainly if we disagree with your assessment.

## Scope

In scope:

- `programs/vault` — the on-chain program. Share accounting, the withdrawal
  path, PDA authority, and anything that lets value leave a vault to an
  account that is not a depositor.
- `apps/api` — anything that lets a caller move, mint or redeem value they do
  not own, or that leaks another user's data.
- The real/paper boundary. Simulated fills reaching a real track record, or a
  real vault routing through the simulator, is a security bug here even though
  no funds move.

Out of scope:

- Trading losses. The program stops a trader from *withdrawing*; it cannot
  stop them from being wrong.
- Rate limits or availability of third-party price and chart APIs.
- The seeded demo dataset.

## What the program is supposed to guarantee

One thing, above all: **there is no code path that moves funds from a vault to
a non-vault account.** The trader gets a scoped swap instruction. Depositors
get a withdrawal path. Nobody — including the platform — gets a transfer.

A working break of that invariant is the highest-severity report we can
receive. Please send it privately.
