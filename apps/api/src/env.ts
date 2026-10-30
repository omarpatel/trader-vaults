// ── env loading (no dotenv dependency) ─────────────────────────────
// Precedence, lowest → highest:  repo-root .env  →  apps/api/.env  →
// real process.env. We parse the files ourselves (tiny KEY=VALUE
// grammar, quotes stripped, # comments ignored) so the API has zero
// config dependencies.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)); // apps/api/src
const API_DIR = resolve(HERE, "..");
const REPO_ROOT = resolve(API_DIR, "..", "..");

function parseEnvFile(path: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    // strip surrounding quotes, then trailing inline comments on unquoted values
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (key) out[key] = value;
  }
  return out;
}

// Railway (and every other PaaS) injects PORT into the real environment
// and requires the process to bind exactly that port. Captured *before*
// the .env merge below so a stray PORT in a checked-out .env can never
// shadow the platform's — binding the wrong port fails the deploy.
const PLATFORM_PORT = process.env.PORT;

const fileEnv: Record<string, string> = {
  ...parseEnvFile(resolve(REPO_ROOT, ".env")), // root first (lowest)
  ...parseEnvFile(resolve(API_DIR, ".env")), // app overrides root
};

// Real environment always wins over files.
for (const [k, v] of Object.entries(fileEnv)) {
  if (process.env[k] === undefined) process.env[k] = v;
}

// Prisma reads DATABASE_URL from process.env — guarantee the dev default.
if (!process.env.DATABASE_URL) process.env.DATABASE_URL = "file:./dev.db";

function str(key: string, fallback = ""): string {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : v;
}

function int(key: string, fallback: number): number {
  const v = Number.parseInt(str(key), 10);
  return Number.isFinite(v) ? v : fallback;
}

// ── typed accessors ────────────────────────────────────────────────

export const env = {
  get databaseUrl(): string {
    return str("DATABASE_URL", "file:./dev.db");
  },
  /**
   * Listen port. The platform-injected PORT (Railway) always wins; a
   * PORT in a local .env is the next fallback; 8787 is the local default
   * the Vite dev proxy expects.
   */
  get port(): number {
    const platform = Number.parseInt(PLATFORM_PORT ?? "", 10);
    if (Number.isFinite(platform) && platform > 0) return platform;
    return int("PORT", 8787);
  },
  /**
   * Bind address. 0.0.0.0 — a container that binds 127.0.0.1 is
   * unreachable from Railway's router and fails its healthcheck.
   */
  get host(): string {
    return str("HOST", "0.0.0.0");
  },
  /**
   * Production single-service mode: this process also serves the built
   * web app (apps/web/dist). On when NODE_ENV=production, or forced
   * either way with SERVE_STATIC=1 / SERVE_STATIC=0. Dev leaves it off,
   * so the Vite dev server keeps ownership of the front end.
   */
  get serveStatic(): boolean {
    const flag = str("SERVE_STATIC");
    if (flag) return !/^(0|false|no|off)$/i.test(flag);
    return str("NODE_ENV") === "production";
  },
  /** Jupiter Price v3 — keyless works at low rate; key raises limits. */
  get jupiterApiKey(): string | undefined {
    return str("JUPITER_API_KEY") || undefined;
  },
  /** Birdeye — tier 2 of the price oracle; skipped entirely without a key. */
  get birdeyeApiKey(): string | undefined {
    return str("BIRDEYE_API_KEY") || undefined;
  },
  get solanaRpcUrl(): string {
    return str("SOLANA_RPC_URL", "https://api.devnet.solana.com");
  },
  /**
   * Deployed Trader Vaults vault program. The default is the live devnet
   * deployment — hardcoding it (rather than requiring the env var) keeps a
   * fresh clone able to READ on-chain vault state with zero setup, and the
   * program id is public information, not a secret.
   */
  get vaultProgramId(): string {
    return str("VAULT_PROGRAM_ID", "HWssGCcxUdiqeEiWk3CRxuSJy6eb4aZH7g2ubo7w6Sqc");
  },
  /** Cluster the vault program is read/written on — drives explorer links. */
  get solanaCluster(): string {
    return str("SOLANA_CLUSTER", "devnet");
  },
  /**
   * Server keypair used for PLATFORM signing (on devnet it is also the
   * admin, the trader and the NAV keeper). Empty = the Solana CLI default,
   * ~/.config/solana/id.json, resolved in signer.ts so this getter stays
   * a pure string read.
   */
  /**
   * The server keypair inline, as a JSON byte array. Railway has no
   * persistent filesystem to hold a key file, so this is how production
   * gets one at all.
   */
  get solanaKeypairJson(): string {
    return str("SOLANA_KEYPAIR_JSON", "");
  },
  get solanaKeypairPath(): string {
    return str("SOLANA_KEYPAIR_PATH", str("SOLANA_KEYPAIR", ""));
  },
  /**
   * The NAV keeper key, as a JSON byte array.
   *
   * SEPARATE FROM THE SERVER KEY ON PURPOSE. The keeper has to sign a
   * transaction every hour or withdrawals start reverting NavStale, so it is
   * necessarily hot. The server key is the platform admin and the program
   * upgrade authority. Collapsing them — which the previous build did, by
   * pinning every vault's nav_keeper to platform_config.admin — made the
   * upgrade authority a permanently-online key that could also set any
   * vault's share price to any value, with no way to move it to a multisig
   * without breaking NAV posting.
   *
   * Unset falls back to the server key with a warning, because a read-only
   * or local deployment should still start.
   */
  get navKeeperKeypairJson(): string {
    return str("NAV_KEEPER_KEYPAIR_JSON", "");
  },
  /**
   * Platform-controlled escrow wallet that holds the VESTED third of each
   * trader's performance fee for VEST_LOCK_DAYS. A dedicated keypair —
   * never the server/deployer key. Only the PUBKEY is ever read here; the
   * secret lives in .keys/fee-escrow.json (gitignored) and the API has no
   * reason to load it, because on devnet the paper ledger's escrow leg is
   * bookkeeping, not a lamport transfer. Undefined = unconfigured, which
   * /api/vested reports honestly instead of inventing a destination.
   */
  /**
   * Wallet that deploys pump.fun tokens, so creator rewards accrue to it.
   * Deliberately NOT feeEscrowWallet: that holds traders' vested fees, this
   * holds money earmarked for funding vaults. One key per purpose keeps the
   * accounting honest and halves what a leaked key can reach.
   */
  get creatorRewardsWallet(): string | undefined {
    return str("CREATOR_REWARDS_WALLET") || undefined;
  },
  get feeEscrowWallet(): string | undefined {
    return str("FEE_ESCROW_WALLET") || undefined;
  },
  /**
   * Helius key. Used for the mainnet RPC pool and, more importantly, for
   * getPriorityFeeEstimate — mainnet transactions sent with no priority fee
   * do not land during congestion.
   */
  get heliusApiKey(): string | undefined {
    return str("HELIUS_API_KEY") || undefined;
  },
  /** Public mainnet RPC for read-only wallet scans (keyless works, rate-limited). */
  get mainnetRpcUrl(): string {
    return str("MAINNET_RPC_URL", "https://api.mainnet-beta.solana.com");
  },
  /**
   * Mainnet RPC pool, tried in order. A keyed endpoint (Helius et al) set
   * via MAINNET_RPC_URL always leads. Behind it sit free public endpoints
   * so wallet scans and token-holder reads degrade to "slower" instead of
   * "rate-limited to death" when no key is configured — the public
   * mainnet-beta endpoint alone hard-429s after ~10 calls in a burst.
   * Set MAINNET_RPC_URLS (comma-separated) to override the whole pool.
   */
  get mainnetRpcPool(): string[] {
    const explicit = str("MAINNET_RPC_URLS", "")
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean);
    if (explicit.length > 0) return explicit;
    const primary = str("MAINNET_RPC_URL", "https://api.mainnet-beta.solana.com");
    const fallbacks = [
      "https://api.mainnet-beta.solana.com",
      "https://solana-rpc.publicnode.com",
      "https://rpc.ankr.com/solana",
    ];
    return [primary, ...fallbacks.filter((u) => u !== primary)];
  },
  get nodeEnv(): string {
    return str("NODE_ENV", "development");
  },
} as const;
