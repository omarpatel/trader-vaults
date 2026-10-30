// ── Privy identity verification (server side) ──────────────────────
//
// THE POINT OF THIS FILE: the on-chain deposit routes must know WHO is
// calling and WHICH self-custodial wallet is theirs, without ever holding
// that wallet's key and without ever trusting the browser's word for it.
//
// Two independent facts are needed, and both are proved cryptographically:
//
//   1. WHO — the Privy ACCESS token (Authorization: Bearer …). A short-
//      lived ES256 JWT issued by Privy. We fetch Privy's PUBLIC JWKS for
//      this app and verify the signature, `iss` ("privy.io") and `aud`
//      (our app id). `sub` is the user's Privy DID. No app secret is
//      involved — JWKS is public, which is exactly why this can be
//      verified properly rather than "trusted".
//
//   2. WHICH WALLET — the access token does NOT carry linked accounts, so
//      the wallet address cannot come from it. Two verified sources, in
//      order of preference:
//        a. the Privy IDENTITY token (`privy-id-token` header), a second
//           JWT off the SAME JWKS whose `linked_accounts` claim lists the
//           user's wallets. Its `sub` must equal the access token's `sub`,
//           so a stolen identity token from another user is rejected.
//        b. the Privy server API (`GET /api/v1/users/<did>`), used only
//           when PRIVY_APP_SECRET is configured.
//      If neither yields a Solana wallet we FAIL CLOSED (401). We never
//      accept a client-declared address: that address becomes the
//      `authority` of the VaultDepositor PDA — the on-chain owner of the
//      shares — and it is what /confirm matches the transaction against.
//
// Nothing here can sign anything. The strongest thing this module can say
// is "this request is user X, whose wallet is Y"; the wallet's key never
// leaves the user's device.

// jose verifies JWTs with the WebCrypto API, which reaches for
// globalThis.crypto. That global does not exist on Node 18 — it landed in
// Node 19 — and package.json had no `engines` field, so nixpacks built with
// its default 18 and every Privy login failed with the genuinely unhelpful
// "crypto is not defined (invalid_token)".
//
// engines.node is now >=20, which is the real fix. This stays as well: it
// costs nothing and means an older runtime degrades to working rather than
// to a login wall.
import { webcrypto } from "node:crypto";
if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Request } from "express";
import type { User } from "@prisma/client";
import { prisma } from "../db.js";
import "../env.js"; // ensure .env files are merged into process.env

// ── config ─────────────────────────────────────────────────────────

const PRIVY_ISSUER = "privy.io";
const PRIVY_AUTH_BASE = "https://auth.privy.io/api/v1";

/**
 * The web app reads VITE_PRIVY_APP_ID from the repo-root .env; the API
 * reads the same file (env.ts), so accept either spelling rather than
 * demanding the value be duplicated under a second key.
 */
export function privyAppId(): string | null {
  const v = process.env.PRIVY_APP_ID || process.env.VITE_PRIVY_APP_ID || "";
  return v.trim() || null;
}

function privyAppSecret(): string | null {
  const v = process.env.PRIVY_APP_SECRET || "";
  return v.trim() || null;
}

/** True when this server can verify Privy tokens at all. */
export function privyConfigured(): boolean {
  return privyAppId() !== null;
}

// ── JWKS (cached per app id) ───────────────────────────────────────
// createRemoteJWKSet keeps its own key cache and re-fetches on an
// unknown `kid`, so this is a per-process singleton, not a per-request
// network call.

type JwkSet = ReturnType<typeof createRemoteJWKSet>;
let cachedJwks: JwkSet | null = null;
let cachedJwksAppId = "";

function jwks(appId: string): JwkSet {
  if (!cachedJwks || cachedJwksAppId !== appId) {
    cachedJwks = createRemoteJWKSet(new URL(`${PRIVY_AUTH_BASE}/apps/${appId}/jwks.json`));
    cachedJwksAppId = appId;
  }
  return cachedJwks;
}

// ── errors ─────────────────────────────────────────────────────────

/** Auth failures carry the status the route should return, plus a code. */
export class PrivyAuthError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "PrivyAuthError";
    this.status = status;
    this.code = code;
  }

  toJson(): Record<string, unknown> {
    return { error: this.message, code: this.code };
  }
}

// ── token verification ─────────────────────────────────────────────

async function verifyPrivyJwt(token: string, appId: string, what: string): Promise<JWTPayload> {
  try {
    const { payload } = await jwtVerify(token, jwks(appId), {
      issuer: PRIVY_ISSUER,
      audience: appId,
    });
    return payload;
  } catch (e) {
    throw new PrivyAuthError(
      401,
      "invalid_token",
      `${what} failed verification: ${(e as Error).message}`,
    );
  }
}

function bearerToken(req: Request): string | null {
  const raw = req.header("authorization") ?? req.header("Authorization");
  if (!raw) return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m?.[1]?.trim() || null;
}

function identityToken(req: Request): string | null {
  // Privy's own convention is the `privy-id-token` header; accept the
  // x- prefixed spelling too so a proxy that strips unknown headers can
  // be worked around without a client change.
  const raw = req.header("privy-id-token") ?? req.header("x-privy-id-token");
  return raw?.trim() || null;
}

// ── linked accounts → Solana wallet ────────────────────────────────

const BASE58_PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

interface LinkedAccountLike {
  type?: string;
  address?: string;
  chain_type?: string;
  chainType?: string;
  wallet_client_type?: string;
  walletClientType?: string;
}

/**
 * Pick the Solana wallet out of a Privy linked-accounts list. Privy's
 * identity token stringifies the array; the REST API returns it as JSON.
 * Both shapes (snake_case wire, camelCase SDK) are tolerated because the
 * two sources disagree on casing.
 */
function solanaWalletFrom(accounts: unknown): string | null {
  const list: LinkedAccountLike[] = Array.isArray(accounts)
    ? (accounts as LinkedAccountLike[])
    : typeof accounts === "string"
      ? (() => {
          try {
            const parsed: unknown = JSON.parse(accounts);
            return Array.isArray(parsed) ? (parsed as LinkedAccountLike[]) : [];
          } catch {
            return [];
          }
        })()
      : [];

  const wallets = list.filter((a) => {
    const type = (a.type ?? "").toLowerCase();
    if (type !== "wallet" && type !== "smart_wallet") return false;
    const chain = (a.chain_type ?? a.chainType ?? "").toLowerCase();
    return chain === "solana";
  });

  // Prefer the Privy EMBEDDED wallet — that is the one the user can sign
  // with inside our app without connecting an external wallet.
  const embedded = wallets.find(
    (w) => (w.wallet_client_type ?? w.walletClientType ?? "").toLowerCase() === "privy",
  );
  const chosen = embedded ?? wallets[0];
  const address = chosen?.address?.trim();
  return address && BASE58_PUBKEY.test(address) ? address : null;
}

/** Fallback wallet lookup via Privy's server API (needs the app secret). */
async function walletFromPrivyApi(did: string, appId: string): Promise<string | null> {
  const secret = privyAppSecret();
  if (!secret) return null;
  const auth = Buffer.from(`${appId}:${secret}`, "utf8").toString("base64");
  const res = await fetch(`${PRIVY_AUTH_BASE}/users/${encodeURIComponent(did)}`, {
    headers: {
      authorization: `Basic ${auth}`,
      "privy-app-id": appId,
      accept: "application/json",
    },
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const body = (await res.json().catch(() => null)) as {
    linked_accounts?: unknown;
    linkedAccounts?: unknown;
  } | null;
  if (!body) return null;
  return solanaWalletFrom(body.linked_accounts ?? body.linkedAccounts);
}

// ── the public surface ─────────────────────────────────────────────

export interface PrivyIdentity {
  /** Privy DID, e.g. did:privy:cm… — stable, and our User.privyId. */
  privyId: string;
  /** Verified base58 Solana pubkey of the user's own wallet. */
  wallet: string;
  /** Which proof produced `wallet` — surfaced so audits are not guesswork. */
  walletSource: "identity_token" | "privy_api";
  email: string | null;
  /** Unix seconds the access token expires. */
  expiresAt: number | null;
}

/**
 * Verify the caller and resolve their wallet. Throws PrivyAuthError
 * (401/503) on every failure path — there is no demo-user fallback here
 * on purpose: an unauthenticated caller must not be able to make the
 * server name someone as the authority of an on-chain account.
 */
export async function authenticatePrivyRequest(req: Request): Promise<PrivyIdentity> {
  const appId = privyAppId();
  if (!appId) {
    throw new PrivyAuthError(
      503,
      "privy_not_configured",
      "Privy is not configured on this server (set PRIVY_APP_ID or VITE_PRIVY_APP_ID) — " +
        "user-signed deposits are disabled rather than falling back to a demo identity",
    );
  }

  const token = bearerToken(req);
  if (!token) {
    throw new PrivyAuthError(
      401,
      "missing_token",
      "missing Privy access token (Authorization: Bearer <token>)",
    );
  }

  const access = await verifyPrivyJwt(token, appId, "Privy access token");
  const privyId = typeof access.sub === "string" ? access.sub : "";
  if (!privyId) {
    throw new PrivyAuthError(401, "invalid_token", "Privy access token has no subject");
  }

  // ── wallet: identity token first, Privy API second, else fail closed
  let wallet: string | null = null;
  let walletSource: PrivyIdentity["walletSource"] = "identity_token";
  let email: string | null = null;

  const idToken = identityToken(req);
  if (idToken) {
    const identity = await verifyPrivyJwt(idToken, appId, "Privy identity token");
    if (identity.sub !== privyId) {
      // A valid token for a DIFFERENT user is an attempted identity swap.
      throw new PrivyAuthError(
        401,
        "token_subject_mismatch",
        "Privy identity token belongs to a different user than the access token",
      );
    }
    const accounts =
      (identity as { linked_accounts?: unknown }).linked_accounts ??
      (identity as { linkedAccounts?: unknown }).linkedAccounts;
    wallet = solanaWalletFrom(accounts);
    email = emailFrom(accounts);
  }

  if (!wallet) {
    const viaApi = await walletFromPrivyApi(privyId, appId);
    if (viaApi) {
      wallet = viaApi;
      walletSource = "privy_api";
    }
  }

  if (!wallet) {
    throw new PrivyAuthError(
      401,
      "wallet_unverified",
      "could not verify a Solana wallet for this Privy user — send the identity token " +
        "in the `privy-id-token` header (or configure PRIVY_APP_SECRET). A wallet address " +
        "claimed by the client is never accepted: it decides who owns the on-chain shares",
    );
  }

  return {
    privyId,
    wallet,
    walletSource,
    email,
    expiresAt: typeof access.exp === "number" ? access.exp : null,
  };
}

function emailFrom(accounts: unknown): string | null {
  const list: Array<{ type?: string; address?: string }> = Array.isArray(accounts)
    ? (accounts as Array<{ type?: string; address?: string }>)
    : typeof accounts === "string"
      ? (() => {
          try {
            const parsed: unknown = JSON.parse(accounts);
            return Array.isArray(parsed) ? (parsed as Array<{ type?: string }>) : [];
          } catch {
            return [];
          }
        })()
      : [];
  const found = list.find((a) => (a.type ?? "").toLowerCase() === "email");
  const address = found?.address?.trim();
  return address || null;
}

// ── User row upsert ────────────────────────────────────────────────

function slugifyHandle(seed: string): string {
  const base = seed
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "")
    .slice(0, 20);
  return base.length >= 3 ? base : `user${seed.replace(/[^a-z0-9]/gi, "").slice(-6) || "0"}`;
}

/**
 * Find-or-create the User for a verified Privy identity and keep their
 * wallet address current. `handle` is unique, so a collision retries with
 * a numeric suffix rather than 500ing the deposit that triggered it.
 */
export async function upsertPrivyUser(identity: PrivyIdentity): Promise<User> {
  const existing = await prisma.user.findUnique({ where: { privyId: identity.privyId } });
  if (existing) {
    if (existing.walletAddress === identity.wallet) return existing;
    return prisma.user.update({
      where: { id: existing.id },
      data: { walletAddress: identity.wallet },
    });
  }

  const seed = identity.email?.split("@")[0] ?? identity.privyId.replace(/^did:privy:/, "");
  const base = slugifyHandle(seed);
  const displayName = identity.email ?? `${identity.wallet.slice(0, 4)}…${identity.wallet.slice(-4)}`;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const handle = attempt === 0 ? base : `${base}${attempt + 1}`;
    try {
      return await prisma.user.create({
        data: {
          privyId: identity.privyId,
          handle,
          displayName,
          walletAddress: identity.wallet,
        },
      });
    } catch {
      // unique violation on handle (or a racing create on privyId) —
      // re-check privyId first, then try the next handle
      const raced = await prisma.user.findUnique({ where: { privyId: identity.privyId } });
      if (raced) return raced;
    }
  }
  throw new PrivyAuthError(
    500,
    "handle_unavailable",
    "could not allocate a unique handle for this account",
  );
}

/** Verify + upsert in one call — what the on-chain routes actually want. */
export async function requirePrivyUser(
  req: Request,
): Promise<{ identity: PrivyIdentity; user: User }> {
  const identity = await authenticatePrivyRequest(req);
  const user = await upsertPrivyUser(identity);
  return { identity, user };
}
