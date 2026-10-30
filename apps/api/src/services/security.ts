// ── real token security audit over public mainnet RPC ─────────────
// Two read-only calls per mint: getAccountInfo (jsonParsed) for the
// mint account's authorities + supply, and getTokenLargestAccounts for
// concentration. COINBASE: mintAuthority === null on-chain means the
// authority is REVOKED (true); a pubkey means it is ACTIVE (false).
// The largest accounts are TOKEN ACCOUNTS — pools and program vaults
// usually own the biggest — the UI must label them honestly. Any call
// that fails (429 etc.) leaves its fields null: we NEVER guess.
// Results cache 5 minutes per mint.

import { cacheGet, cacheSet } from "../cache.js";
import { env } from "../env.js";

const RPC_TIMEOUT_MS = 8_000;
const SECURITY_TTL_MS = 300_000; // 5 min for a complete audit
const DEGRADED_TTL_MS = 60_000; // rate-limited audits retry sooner
const RETRY_BACKOFF_MS = 1_500; // one backoff-retry per call before giving up
const AUDIT_DEADLINE_MS = 12_000; // bounded; overrun → null fields

export interface SecurityHolder {
  /** token ACCOUNT address (often a pool or program vault, not a person) */
  address: string;
  /** share of total supply, 0-100 */
  pct: number;
  uiAmount: number;
}

export interface TokenSecurity {
  /** true = revoked (mintAuthority null on-chain), false = ACTIVE, null = unknown */
  mintAuthorityRevoked: boolean | null;
  freezeAuthorityRevoked: boolean | null;
  decimals: number | null;
  supplyUi: number | null;
  /** combined share of the 10 largest token accounts, 0-100 */
  top10Pct: number | null;
  /** 10 largest token accounts, biggest first (empty when unknown) */
  largestHolders: SecurityHolder[];
  fetchedAt: number;
}

// ── raw JSON-RPC (walletScan conventions) ──────────────────────────

let rpcId = 0;

class RpcHttpError extends Error {
  readonly status: number;
  /** seconds the server asked us to wait (Retry-After), if sent */
  readonly retryAfterSec?: number;
  constructor(status: number, method: string, retryAfterSec?: number) {
    super(`RPC HTTP ${status} for ${method}`);
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(env.mainnetRpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!res.ok) {
    const retryAfter = Number(res.headers.get("retry-after"));
    throw new RpcHttpError(
      res.status,
      method,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }
  const body = (await res.json()) as { result?: T; error?: { code?: number; message?: string } };
  if (body.error) {
    // public RPC reports per-method rate limits as a JSON-RPC error with
    // code 429 (HTTP 200) — surface it as retryable like an HTTP 429
    if (body.error.code === 429) throw new RpcHttpError(429, method);
    throw new Error(`RPC error ${body.error.code}: ${body.error.message}`);
  }
  return body.result as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Backoff-retry per call — public RPC 429s are usually transient. */
async function rpcWithRetry<T>(method: string, params: unknown[], deadline: number): Promise<T> {
  let backoff = RETRY_BACKOFF_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      return await rpc<T>(method, params);
    } catch (err) {
      if (attempt >= 2) throw err;
      if (err instanceof RpcHttpError && err.status === 429 && err.retryAfterSec) {
        backoff = Math.max(backoff, err.retryAfterSec * 1000);
      }
      if (Date.now() + backoff >= deadline) throw err;
      await sleep(backoff);
      backoff *= 2;
    }
  }
}

// ── response shapes (only the fields we read) ──────────────────────

interface MintAccountInfo {
  value?: {
    data?: {
      program?: string;
      parsed?: {
        type?: string;
        info?: {
          mintAuthority?: string | null;
          freezeAuthority?: string | null;
          decimals?: number;
          supply?: string;
        };
      };
    };
  } | null;
}

interface LargestAccounts {
  value?: Array<{
    address?: string;
    uiAmount?: number | null;
    uiAmountString?: string;
  }>;
}

// ── the audit ──────────────────────────────────────────────────────

async function runAudit(mint: string): Promise<TokenSecurity> {
  const deadline = Date.now() + AUDIT_DEADLINE_MS;

  let mintAuthorityRevoked: boolean | null = null;
  let freezeAuthorityRevoked: boolean | null = null;
  let decimals: number | null = null;
  let supplyUi: number | null = null;

  try {
    const acc = await rpcWithRetry<MintAccountInfo>(
      "getAccountInfo",
      [mint, { encoding: "jsonParsed" }],
      deadline,
    );
    const parsed = acc?.value?.data?.parsed;
    // only trust fields from an account the node actually parsed as a mint
    if (parsed?.type === "mint" && parsed.info) {
      const info = parsed.info;
      // null (or absent) authority = revoked; a pubkey = ACTIVE
      mintAuthorityRevoked = (info.mintAuthority ?? null) === null;
      freezeAuthorityRevoked = (info.freezeAuthority ?? null) === null;
      if (typeof info.decimals === "number" && Number.isFinite(info.decimals)) {
        decimals = info.decimals;
      }
      if (decimals !== null && typeof info.supply === "string") {
        const raw = Number(info.supply);
        if (Number.isFinite(raw)) supplyUi = raw / 10 ** decimals;
      }
    }
  } catch (err) {
    console.warn(`[security] ${mint}: getAccountInfo failed:`, err);
  }

  let top10Pct: number | null = null;
  let largestHolders: SecurityHolder[] = [];

  // pct is uiAmount / supply — without a real supply we won't fabricate one
  if (supplyUi !== null && supplyUi > 0) {
    try {
      const largest = await rpcWithRetry<LargestAccounts>(
        "getTokenLargestAccounts",
        [mint],
        deadline,
      );
      const rows = (largest?.value ?? [])
        .map((r) => ({
          address: r.address ?? "",
          uiAmount: r.uiAmount ?? Number(r.uiAmountString),
        }))
        .filter((r) => r.address && Number.isFinite(r.uiAmount) && (r.uiAmount as number) >= 0);
      if (rows.length > 0) {
        largestHolders = rows.slice(0, 10).map((r) => ({
          address: r.address,
          uiAmount: r.uiAmount as number,
          pct: ((r.uiAmount as number) / (supplyUi as number)) * 100,
        }));
        top10Pct = largestHolders.reduce((s, h) => s + h.pct, 0);
      }
    } catch (err) {
      console.warn(`[security] ${mint}: getTokenLargestAccounts failed:`, err);
    }
  }

  return {
    mintAuthorityRevoked,
    freezeAuthorityRevoked,
    decimals,
    supplyUi,
    top10Pct,
    largestHolders,
    fetchedAt: Date.now(),
  };
}

/**
 * Audit a mint's on-chain security posture. Complete audits cache 5 min;
 * audits degraded by rate limits cache 1 min so they self-heal sooner.
 */
export async function getTokenSecurity(mint: string): Promise<TokenSecurity> {
  const key = `security:${mint}`;
  const hit = cacheGet<TokenSecurity>(key);
  if (hit !== undefined) return hit;
  const audit = await runAudit(mint);
  const degraded = audit.mintAuthorityRevoked === null || audit.top10Pct === null;
  return cacheSet(key, audit, degraded ? DEGRADED_TTL_MS : SECURITY_TTL_MS);
}
