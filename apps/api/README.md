# @trader-vaults/api

Express + Prisma API for Trader Vaults. P0 scope: real route/service/schema
structure with richly seeded demo data (so the web UI is fully alive)
and a real multi-tier price oracle. Trading/settlement are ledger
simulations — no chain writes.

## Run

```bash
# from repo root (deps installed via npm install at the root)
npm run db:setup      # prisma db push + seed, or from apps/api:
npm run db:push -w apps/api
npm run db:seed -w apps/api
npm run dev:api       # tsx watch, listens on http://localhost:8787
```

`DATABASE_URL` defaults to `file:./dev.db` (SQLite, lives at
`apps/api/prisma/dev.db`). Env is loaded from the repo-root `.env`,
then `apps/api/.env`, with real environment variables winning.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health` | `{ ok, db, uptime }` — 503 when the DB is unreachable |
| GET | `/api/vaults` | Vault list. `?sort=tvl\|pnl7d\|pnl30d\|pnlAll\|age\|sharePrice`, `?type=managed\|mirror` |
| GET | `/api/vaults/:id` | Vault detail: vault + positions + last 50 trades + pending withdrawals |
| POST | `/api/vaults` | Create vault `{ name, type, perfFeeBps?, thesis?, leaderWallet? }` (demo user becomes trader) |
| POST | `/api/vaults/:id/deposit` | `{ sol }` — demo ledger deposit (mints shares at current share price) |
| POST | `/api/vaults/:id/withdraw` | `{ shares }` — instant if the SOL buffer covers it, else windowed by `redeemWindowHours` |
| GET | `/api/vaults/:id/onchain` | **Real vaults only.** Decoded live `Vault` (+ `VaultDepositor` for `?authority=`) read straight off the deployed program |
| POST | `/api/vaults/:id/onchain/deposit` | **Real vaults only.** `{ sol }` — builds `init_depositor` (when needed) + `deposit` and sends them on-chain. Signed by the SERVER key today, so the shares belong to the platform's key: a devnet proof, not the user path |
| GET | `/api/tokens/:mint` | Price oracle → shared `TokenInfo` |
| GET | `/api/tokens?ids=a,b,c` | Batched oracle lookup (max 50 mints) |
| GET | `/api/portfolio` | Demo user holdings (`Holding[]`) + withdraw requests |
| GET | `/api/wallets/tracked` | Demo user's tracked wallets |
| POST | `/api/wallets/tracked` | `{ address, label? }` — tracks a wallet (placeholder stats until the TheTradoor pipeline port) |

All response shapes come from `@trader-vaults/shared` — that file is the
contract between web and api.

## How demo mode works

- **No auth.** Every user-scoped route acts as the seeded demo user
  (`handle: "you"`). The Privy integration later swaps `getDemoUser()`
  for a session lookup.
- **Deposits/withdrawals are ledger entries.** `deposit` mints shares at
  the current share price and bumps `tvlSol`/`totalShares`/`solBufferSol`;
  `withdraw` pays instantly when the SOL buffer covers the value,
  otherwise files a `pending` request executable after the redeem
  window. No transactions are sent anywhere.
- **Seed data** (`npm run db:seed`, idempotent — wipes and recreates,
  fixed RNG seed): 6 traders, 8 vaults (5 managed / 3 mirror, incl. one
  −62% blowup and one +240% runner), 90 days of hourly equity per
  vault, 4–8 open positions per vault on real mints (BONK/WIF/POPCAT/
  PUMP/JUP/RAY) plus two invented memecoins, ~60 trades per vault over
  30 days, demo-user deposits into 3 vaults with one pending
  withdrawal, and 5 tracked wallets (2 of them leading mirror vaults).
- **Vault stats are computed, not stored** — pnl/drawdown from the
  equity curve, win rate from average-cost trade pairing, median copy
  lag from mirror trades (see `src/services/vaults.ts`).

## On-chain client (real vaults)

Real vaults are objects on the deployed Anchor program
(`HWssGCcxUdiqeEiWk3CRxuSJy6eb4aZH7g2ubo7w6Sqc`); their DB row
is only an index entry plus `onchainVaultPda` / `onchainInitSig`.

- `src/services/program.ts` — no IDL exists, so this is the hand-rolled
  client: sighash discriminators, PDA derivations, borsh codecs for
  `Vault` / `VaultDepositor` / `PlatformConfig`, and instruction builders
  (`init_vault`, `init_depositor`, `deposit`, `post_nav`). Builders are
  pure: they return a `TransactionInstruction` and never sign.
- `src/services/signer.ts` — loads `SOLANA_KEYPAIR_PATH` (default
  `~/.config/solana/id.json`), builds/signs/simulates/sends v0
  transactions, and throws `OnChainError` **carrying the program log
  lines** on every failure path.
- `src/services/onchainVaults.ts` — `initVaultOnChain`,
  `depositOnChain`, `readOnChainVault`. Never writes ledger columns:
  chain share units (~1e12 per SOL) are not paper share units (~1.0).
- Env: `VAULT_PROGRAM_ID`, `SOLANA_CLUSTER`, `SOLANA_KEYPAIR_PATH`,
  `SOLANA_RPC_URL`.
- Proof: `npx tsx scripts/onchain-vault-e2e.mjs` (repo root) creates a
  vault, deposits, decodes both accounts back and posts a NAV mark on
  devnet, asserting the numbers against `math.rs`. `E2E_SIMULATE=1`
  dry-runs it for free.

Deposits are signed by the SERVER key for now, so the shares belong to
the platform's key — the user path needs the user's wallet signature
(Privy), not more client code.

## Price oracle

`src/services/prices.ts`, tiered, each tier behind a 4s timeout:

1. **Jupiter Price v3** — keyless at low rate; set `JUPITER_API_KEY`
   for real limits. Mints untraded for ~7 days are omitted from its
   response; absence is treated as "unreliable" and falls through.
2. **Birdeye** — only when `BIRDEYE_API_KEY` is set.
3. **DexScreener** — keyless; also the metadata source (name, symbol,
   image, mcap, liquidity, volume). Pair selection: highest
   `liquidity.usd` among pairs that report fdv/marketCap.

`priceSol` is derived via the SOL/USD mark (Jupiter, cached 15s).
Token marks cache 5s, metadata 300s. If every tier fails the oracle
returns `source: "none"` with zeroed numbers — it never fabricates.
Tier 4 (on-chain pool read via `SOLANA_RPC_URL`) is a later addition.

## Postgres swap

The schema is Postgres-portable by design (scalar types only, string
pseudo-enums, no SQLite-isms). To switch:

1. `apps/api/prisma/schema.prisma` → `provider = "postgresql"`
2. `DATABASE_URL="postgresql://user:pass@host:5432/trader_vaults"`
3. `npx prisma db push` (or start a migration history with
   `npx prisma migrate dev`)

## Redis swap

`src/cache.ts` is the only caching surface (in-memory TTL map). To move
to Redis: reimplement `cacheGet`/`cacheSet`/`getOrSet` against a client
keyed off `REDIS_URL` and keep the same exports — callers never touch
the store directly. Worth adding single-flight locking at that point.
