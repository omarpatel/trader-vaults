#!/usr/bin/env node
/**
 * USER-SIGNED DEPOSIT E2E — proves the custody story, not just the wire.
 *
 *   npx tsx scripts/user-signed-deposit-e2e.mjs
 *
 * The claim under test is narrow and load-bearing: **the server builds the
 * transaction and the USER's wallet signs it.** A server-signed deposit
 * (scripts/onchain-vault-e2e.mjs) proves the program works; it proves
 * nothing about custody, because the platform key owns the resulting
 * shares. This script proves the other half.
 *
 * It mounts the REAL routers (apps/api/src/routes/onchain.ts, and
 * routes/vaults.ts for the demo-ledger wall) in-process and drives them
 * over HTTP, so nothing here is a re-implementation of the shipped code.
 *
 * WHAT STANDS IN FOR WHAT
 *   · Privy's key server → a local ES256 keypair. `globalThis.fetch` is
 *     patched so the app's REAL verifier (jose + createRemoteJWKSet, in
 *     services/privyAuth.ts) fetches OUR JWKS instead of Privy's. Every
 *     signature check, `iss`/`aud` check and linked-accounts parse in the
 *     shipped code runs unmodified — only the key origin is swapped.
 *   · Privy's confirmation modal → a throwaway devnet keypair that signs
 *     the EXACT bytes `prepare` returned. That is precisely what Privy's
 *     wallet does after the user clicks confirm. Everything except the
 *     click is real.
 *
 * STEPS
 *   [0] environment, program, vault row, keeper freshness
 *   [1] stand up the fake-but-verified Privy JWKS + boot the routers
 *   [2] auth MUST fail closed: no token · garbage · wrong audience ·
 *       valid access token with no wallet proof
 *   [3] mainnet cluster MUST be refused
 *   [4] an unfunded wallet MUST get an actionable 400, not a failing tx
 *   [5] fund a throwaway wallet, call prepare, and DECODE the result:
 *       fee payer, authority, signer flags, and the ABSENCE of the server
 *       key anywhere in the transaction
 *   [6] sign those exact bytes with the throwaway key and broadcast
 *   [7] confirm the real signature; assert the VaultDepositor PDA went
 *       from nonexistent to holding the shares math.rs predicted
 *   [8] confirm is idempotent, and refuses transactions that are not this
 *       user's deposit into this vault
 *   [9] the demo-ledger wall still stands for real vaults
 *
 * ENV
 *   E2E_VAULT_ID     DB id of a real, on-chain vault (default: auto-pick)
 *   E2E_DEPOSIT_SOL  default 0.02
 *   E2E_FUND_SOL     default 0.05 (server → throwaway wallet)
 */

import express from "express";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
} from "@solana/web3.js";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

import { prisma } from "../apps/api/src/db.js";
import {
  VAULT_PROGRAM_ID,
  buildPostNavIx,
  effectiveEquity,
  explorerTx,
  fetchVaultAccount,
  fetchVaultDepositorAccount,
  ixDiscriminator,
  sharesForDeposit,
  solToLamports,
  vaultDepositorPda,
  vaultPda,
} from "../apps/api/src/services/program.ts";
import {
  getConfirmedSlot,
  getConnection,
  getLamports,
  getServerKeypair,
  sendAndConfirm,
} from "../apps/api/src/services/signer.ts";

// ── tiny reporter ──────────────────────────────────────────────────
const failures = [];
const checks = [];
const txs = [];

const ok = (m) => {
  checks.push(m);
  console.log(`  ✓ ${m}`);
};
const fail = (m) => {
  failures.push(m);
  console.log(`  ✗ ${m}`);
};
const info = (m) => console.log(`    ${m}`);
const step = (n, m) => console.log(`\n[${n}] ${m}`);
const assert = (cond, good, bad) => (cond ? ok(good) : fail(bad ?? good));

const SOL = (lamports) => `${(Number(lamports) / 1e9).toFixed(9)} ◎`;

// ── config ─────────────────────────────────────────────────────────
const DEPOSIT_SOL = Number(process.env.E2E_DEPOSIT_SOL ?? "0.02");
const FUND_SOL = Number(process.env.E2E_FUND_SOL ?? "0.05");
const RUN_ID = Date.now().toString(36);

// ═══════════════════════════════════════════════════════════════════
step(0, "environment");

const connection = getConnection();
info(`rpc          ${connection.rpcEndpoint}`);
info(`cluster      ${process.env.SOLANA_CLUSTER ?? "devnet"}`);
info(`program      ${VAULT_PROGRAM_ID.toBase58()}`);

const appId = process.env.PRIVY_APP_ID || process.env.VITE_PRIVY_APP_ID || "";
assert(appId.length > 0, `privy app id configured (${appId})`, "no PRIVY_APP_ID / VITE_PRIVY_APP_ID");

const server = getServerKeypair();
const serverBalance = await getLamports(server.publicKey);
info(`server key   ${server.publicKey.toBase58()}  ${SOL(serverBalance)}`);
assert(
  Number(serverBalance) / 1e9 > FUND_SOL + 0.01,
  `server key can fund the throwaway wallet (${SOL(serverBalance)})`,
  `server key is too poor to fund ${FUND_SOL} SOL`,
);

// pick the vault
const vaultRow = process.env.E2E_VAULT_ID
  ? await prisma.vault.findUnique({ where: { id: process.env.E2E_VAULT_ID } })
  : await prisma.vault.findFirst({
      where: { mode: "real", status: "active", onchainVaultPda: { not: null } },
      orderBy: { createdAt: "desc" },
    });
if (!vaultRow?.onchainVaultPda) {
  fail("no real vault with an on-chain account in the database — nothing to deposit into");
  process.exit(1);
}
const VAULT_ID = vaultRow.id;
const [derivedPda] = vaultPda(VAULT_ID);
info(`vault        ${vaultRow.name}  (${VAULT_ID})`);
assert(
  derivedPda.toBase58() === vaultRow.onchainVaultPda,
  `stored PDA re-derives from the row id (${derivedPda.toBase58()})`,
  `stored PDA ${vaultRow.onchainVaultPda} != derived ${derivedPda.toBase58()}`,
);

// ── keeper freshness: the program refuses deposits on a stale mark ──
{
  const v = await fetchVaultAccount(connection, derivedPda);
  if (!v) {
    fail(`vault account ${derivedPda.toBase58()} is not on-chain`);
    process.exit(1);
  }
  const now = BigInt(Math.floor(Date.now() / 1000));
  const age = now - v.data.navPostedAt;
  info(`nav mark     ${age}s old (staleness limit ${v.data.navStalenessSeconds}s)`);
  // Refresh with a zero-delta mark when the window is nearly up, so the
  // deposit is not racing the keeper. This is the keeper's own key doing
  // the keeper's own job — no new authority is introduced.
  if (age > v.data.navStalenessSeconds - 600n) {
    if (!v.data.navKeeper.equals(server.publicKey)) {
      fail(`nav mark is ${age}s old and the server key is not the keeper — run the keeper first`);
      process.exit(1);
    }
    const markSlot = await getConfirmedSlot();
    const sent = await sendAndConfirm(
      [
        buildPostNavIx({
          vault: derivedPda,
          keeper: server.publicKey,
          navLamports: v.data.navLamports,
          markSlot,
        }),
      ],
      [],
      { label: "post_nav(refresh)" },
    );
    txs.push(["post_nav (keeper refresh)", sent.signature]);
    ok(`refreshed the NAV mark so the deposit is not racing staleness (${sent.signature})`);
  } else {
    ok("NAV mark is fresh enough for a deposit");
  }
}

// ═══════════════════════════════════════════════════════════════════
step(1, "stand up a verifiable Privy identity + boot the real routers");

// A real ES256 keypair. The app verifies against the PUBLIC half exactly
// as it would verify against Privy's — same jose call, same iss/aud
// checks, same JWKS plumbing.
const { publicKey: jwtPub, privateKey: jwtPriv } = await generateKeyPair("ES256", {
  extractable: true,
});
const publicJwk = { ...(await exportJWK(jwtPub)), kid: "e2e-key", alg: "ES256", use: "sig" };

const realFetch = globalThis.fetch;
let jwksHits = 0;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  if (url.includes("/jwks.json")) {
    jwksHits += 1;
    return new Response(JSON.stringify({ keys: [publicJwk] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return realFetch(input, init);
};

/** Mint the two tokens Privy hands the browser. */
async function mintTokens({ did, wallet, audience = appId, issuer = "privy.io" }) {
  const now = Math.floor(Date.now() / 1000);
  const base = (claims) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256", kid: "e2e-key" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(did)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(jwtPriv);
  const accessToken = await base({ sid: `sess-${RUN_ID}` });
  const identityToken = await base({
    linked_accounts: JSON.stringify([
      { type: "email", address: `e2e-${RUN_ID}@example.test` },
      ...(wallet
        ? [
            {
              type: "wallet",
              address: wallet,
              chain_type: "solana",
              wallet_client_type: "privy",
            },
          ]
        : []),
    ]),
  });
  return { accessToken, identityToken };
}

// The routers, imported AFTER the fetch patch so nothing has cached a
// real JWKS response. (Import order does not actually matter — jose
// fetches lazily — but it keeps the intent obvious.)
const { onchainRouter } = await import("../apps/api/src/routes/onchain.ts");
const { vaultsRouter } = await import("../apps/api/src/routes/vaults.ts");

const app = express();
app.use(express.json());
app.use("/api/onchain", onchainRouter);
app.use("/api/vaults", vaultsRouter);
const httpServer = app.listen(0);
await new Promise((r) => httpServer.once("listening", r));
const BASE = `http://127.0.0.1:${httpServer.address().port}`;
ok(`routers mounted at ${BASE}`);

async function call(path, { method = "GET", body, tokens } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (tokens?.accessToken) headers.authorization = `Bearer ${tokens.accessToken}`;
  if (tokens?.identityToken) headers["privy-id-token"] = tokens.identityToken;
  const res = await realFetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

{
  const { status, json } = await call("/api/onchain/config");
  assert(status === 200 && json.enabled === true, `GET /config → enabled on ${json.cluster}`);
  info(`program ${json.programId}  ·  rpc ${json.rpcUrl}  ·  depositor rent ${json.depositorRentLamports}`);
}

// ═══════════════════════════════════════════════════════════════════
step(2, "auth fails CLOSED (no demo-user fallback on these routes)");

const throwaway = Keypair.generate();
const USER_DID = `did:privy:e2e${RUN_ID}`;
const goodTokens = await mintTokens({ did: USER_DID, wallet: throwaway.publicKey.toBase58() });

{
  const r = await call("/api/onchain/deposit/prepare", {
    method: "POST",
    body: { vaultId: VAULT_ID, sol: DEPOSIT_SOL },
  });
  assert(
    r.status === 401 && r.json.code === "missing_token",
    `no Authorization header → 401 ${r.json.code}`,
    `expected 401 missing_token, got ${r.status} ${JSON.stringify(r.json)}`,
  );
}
{
  const r = await call("/api/onchain/me", {
    tokens: { accessToken: "not.a.jwt", identityToken: null },
  });
  assert(
    r.status === 401 && r.json.code === "invalid_token",
    `garbage bearer token → 401 ${r.json.code}`,
    `expected 401 invalid_token, got ${r.status} ${JSON.stringify(r.json)}`,
  );
}
{
  // Correctly signed by our key, but minted for a DIFFERENT app id: the
  // audience check must reject it. This is the check that stops a token
  // from another Privy app being replayed here.
  const wrong = await mintTokens({
    did: USER_DID,
    wallet: throwaway.publicKey.toBase58(),
    audience: "some-other-app",
  });
  const r = await call("/api/onchain/me", { tokens: wrong });
  assert(
    r.status === 401,
    `token minted for another app id → 401 (${r.json.code})`,
    `expected 401, got ${r.status} ${JSON.stringify(r.json)}`,
  );
}
{
  // Valid identity, but nothing proves which wallet is theirs. The server
  // must NOT accept a client-declared address — it decides who owns the
  // on-chain shares.
  const r = await call("/api/onchain/me", {
    tokens: { accessToken: goodTokens.accessToken, identityToken: null },
  });
  assert(
    r.status === 401 && r.json.code === "wallet_unverified",
    `access token with no wallet proof → 401 ${r.json.code}`,
    `expected 401 wallet_unverified, got ${r.status} ${JSON.stringify(r.json)}`,
  );
}
{
  // A valid identity token belonging to someone else must not graft their
  // wallet onto this session.
  const other = await mintTokens({
    did: "did:privy:someone-else",
    wallet: Keypair.generate().publicKey.toBase58(),
  });
  const r = await call("/api/onchain/me", {
    tokens: { accessToken: goodTokens.accessToken, identityToken: other.identityToken },
  });
  assert(
    r.status === 401 && r.json.code === "token_subject_mismatch",
    `identity token from another user → 401 ${r.json.code}`,
    `expected 401 token_subject_mismatch, got ${r.status} ${JSON.stringify(r.json)}`,
  );
}
{
  const r = await call("/api/onchain/me", { tokens: goodTokens });
  assert(
    r.status === 200 && r.json.wallet === throwaway.publicKey.toBase58(),
    `verified identity resolves the wallet from the identity token (${r.json.walletSource})`,
    `expected 200 with the wallet, got ${r.status} ${JSON.stringify(r.json)}`,
  );
  assert(jwksHits > 0, `the shipped verifier really fetched a JWKS (${jwksHits} fetches)`);
}

// ═══════════════════════════════════════════════════════════════════
step(3, "mainnet is refused outright (no audit yet)");
{
  const saved = process.env.SOLANA_CLUSTER;
  process.env.SOLANA_CLUSTER = "mainnet-beta";
  const r = await call("/api/onchain/deposit/prepare", {
    method: "POST",
    tokens: goodTokens,
    body: { vaultId: VAULT_ID, sol: DEPOSIT_SOL },
  });
  process.env.SOLANA_CLUSTER = saved;
  assert(
    r.status === 403 && r.json.code === "mainnet_refused",
    `SOLANA_CLUSTER=mainnet-beta → 403 ${r.json.code}`,
    `expected 403 mainnet_refused, got ${r.status} ${JSON.stringify(r.json)}`,
  );
  info(`"${r.json.error}"`);
  const back = await call("/api/onchain/config");
  assert(back.json.cluster === "devnet", "cluster restored to devnet for the rest of the run");
}

// ═══════════════════════════════════════════════════════════════════
step(4, "an UNFUNDED wallet gets an actionable 400, not a failing signature");
{
  const balance = await getLamports(throwaway.publicKey);
  assert(balance === 0n, `throwaway wallet ${throwaway.publicKey.toBase58()} holds 0 SOL`);
  const r = await call("/api/onchain/deposit/prepare", {
    method: "POST",
    tokens: goodTokens,
    body: { vaultId: VAULT_ID, sol: DEPOSIT_SOL },
  });
  assert(
    r.status === 400 && r.json.code === "insufficient_balance",
    `prepare on an empty wallet → 400 ${r.json.code}`,
    `expected 400 insufficient_balance, got ${r.status} ${JSON.stringify(r.json)}`,
  );
  info(`"${r.json.error}"`);
  assert(
    r.json.needed?.depositorRentLamports === "2067120",
    `the 400 names the depositor rent the USER must pay (${r.json.needed?.depositorRentLamports} lamports)`,
    `expected the rent in the error body, got ${JSON.stringify(r.json.needed)}`,
  );
}

// ═══════════════════════════════════════════════════════════════════
step(5, "fund the wallet, prepare, and DECODE the unsigned transaction");

{
  const sent = await sendAndConfirm(
    [
      SystemProgram.transfer({
        fromPubkey: server.publicKey,
        toPubkey: throwaway.publicKey,
        lamports: Number(solToLamports(FUND_SOL)),
      }),
    ],
    [],
    { label: `fund throwaway ${FUND_SOL} SOL` },
  );
  txs.push(["fund throwaway wallet (server → user)", sent.signature]);
  ok(`funded the throwaway wallet with ${FUND_SOL} SOL (${sent.signature})`);
}

const before = await fetchVaultAccount(connection, derivedPda);
const [depositorPda] = vaultDepositorPda(derivedPda, throwaway.publicKey);
const depositorBefore = await fetchVaultDepositorAccount(connection, depositorPda);
assert(
  depositorBefore === null,
  `the user's VaultDepositor PDA ${depositorPda.toBase58()} does NOT exist yet`,
  "the throwaway wallet already has a depositor record — regenerate",
);

const prep = await call("/api/onchain/deposit/prepare", {
  method: "POST",
  tokens: goodTokens,
  body: { vaultId: VAULT_ID, sol: DEPOSIT_SOL },
});
if (prep.status !== 200) {
  fail(`prepare failed: ${prep.status} ${JSON.stringify(prep.json)}`);
  process.exit(1);
}
const prepared = prep.json;
ok(`prepare → 200, ${prepared.transaction.length} base64 chars`);
info(`depositorPda   ${prepared.depositorPda}`);
info(`sharesExpected ${prepared.sharesExpected}`);
info(`blockhash      ${prepared.blockhash} (valid through ${prepared.lastValidBlockHeight})`);

assert(
  prepared.depositorPda === depositorPda.toBase58(),
  "prepare returned the PDA derived from (vault, USER wallet)",
);
assert(prepared.needsDepositorInit === true, "prepare knows the depositor record must be created");
assert(prepared.signed === false, "prepare says the transaction is UNSIGNED");

// ── decode the bytes the browser would hand to Privy ───────────────
const decoded = VersionedTransaction.deserialize(Buffer.from(prepared.transaction, "base64"));
const msg = decoded.message;
const keys = msg.getAccountKeys();

assert(
  decoded.signatures.every((s) => s.every((b) => b === 0)),
  `all ${decoded.signatures.length} signature slot(s) are zero — nothing has signed this yet`,
);

const feePayer = keys.get(0);
assert(
  feePayer.equals(throwaway.publicKey),
  `feePayer  = ${feePayer.toBase58()}  = THE USER`,
  `feePayer is ${feePayer.toBase58()}, expected the user ${throwaway.publicKey.toBase58()}`,
);
assert(
  !feePayer.equals(server.publicKey),
  `feePayer is NOT the server key (${server.publicKey.toBase58()})`,
);

const allKeys = [];
for (let i = 0; i < keys.length; i += 1) allKeys.push(keys.get(i).toBase58());
assert(
  !allKeys.includes(server.publicKey.toBase58()),
  "the SERVER key appears nowhere in the transaction's account list",
  `server key found in the account list: ${allKeys.join(", ")}`,
);

console.log("\n    ── decoded instructions ─────────────────────────────────");
const IX_NAMES = [
  ["init_depositor", ixDiscriminator("init_depositor")],
  ["deposit", ixDiscriminator("deposit")],
];
let sawInitDepositor = false;
let sawDeposit = false;
msg.compiledInstructions.forEach((ix, i) => {
  const programId = keys.get(ix.programIdIndex);
  const data = Buffer.from(ix.data);
  const name =
    IX_NAMES.find(([, disc]) => data.subarray(0, 8).equals(disc))?.[0] ?? "unknown";
  if (name === "init_depositor") sawInitDepositor = true;
  if (name === "deposit") sawDeposit = true;
  console.log(`    #${i} ${name}  program=${programId.toBase58()}`);
  ix.accountKeyIndexes.forEach((k, j) => {
    const key = keys.get(k);
    const flags = [
      msg.isAccountSigner(k) ? "signer" : "      ",
      msg.isAccountWritable(k) ? "writable" : "        ",
    ].join(" ");
    const who = key.equals(throwaway.publicKey)
      ? "  ← THE USER"
      : key.equals(server.publicKey)
        ? "  ← SERVER KEY (SHOULD NOT BE HERE)"
        : key.equals(derivedPda)
          ? "  ← vault PDA"
          : key.equals(depositorPda)
            ? "  ← the user's depositor PDA"
            : "";
    console.log(`         [${j}] ${key.toBase58()}  ${flags}${who}`);
  });
  if (name === "deposit") {
    info(`         amount_lamports = ${data.readBigUInt64LE(8)}`);
  }
  // account 0 of both instructions is `authority`
  const authorityIdx = ix.accountKeyIndexes[0];
  const authority = keys.get(authorityIdx);
  assert(
    authority.equals(throwaway.publicKey) && msg.isAccountSigner(authorityIdx),
    `#${i} ${name}: authority = the USER, and it is the required signer`,
    `#${i} ${name}: authority is ${authority.toBase58()}`,
  );
  assert(
    programId.equals(VAULT_PROGRAM_ID),
    `#${i} ${name}: targets the Trader Vaults program`,
  );
});
console.log("    ─────────────────────────────────────────────────────────\n");
assert(sawInitDepositor && sawDeposit, "the transaction carries init_depositor + deposit");

const expectedShares = sharesForDeposit(
  solToLamports(DEPOSIT_SOL),
  before.data.totalShares,
  effectiveEquity(before.data, BigInt(Math.floor(Date.now() / 1000))),
);
assert(
  prepared.sharesExpected === expectedShares.toString(),
  `sharesExpected (${prepared.sharesExpected}) matches math.rs recomputed here`,
  `sharesExpected ${prepared.sharesExpected} != locally computed ${expectedShares}`,
);

// ═══════════════════════════════════════════════════════════════════
step(6, "the USER signs those exact bytes and broadcasts (what Privy does)");

// Note what is NOT happening here: the server never sees this key, and
// the transaction object being signed is byte-identical to the one
// `prepare` returned — it was reconstructed from the base64 payload.
decoded.sign([throwaway]);
assert(
  decoded.signatures.some((s) => s.some((b) => b !== 0)),
  "the user's signature is now attached (and only theirs)",
);

const depositSig = await connection.sendRawTransaction(decoded.serialize(), {
  skipPreflight: false,
  preflightCommitment: "confirmed",
  maxRetries: 3,
});
txs.push(["USER-SIGNED deposit", depositSig]);
const conf = await connection.confirmTransaction(
  {
    signature: depositSig,
    blockhash: prepared.blockhash,
    lastValidBlockHeight: prepared.lastValidBlockHeight,
  },
  "confirmed",
);
assert(!conf.value.err, `the user-signed deposit landed: ${depositSig}`, `it FAILED: ${JSON.stringify(conf.value.err)}`);
info(explorerTx(depositSig));

// ═══════════════════════════════════════════════════════════════════
step(7, "confirm verifies the signature ON CHAIN before recording it");

const confirmed = await call("/api/onchain/deposit/confirm", {
  method: "POST",
  tokens: goodTokens,
  body: { vaultId: VAULT_ID, signature: depositSig },
});
assert(
  confirmed.status === 201 && confirmed.json.recorded === "created",
  `confirm → ${confirmed.status} recorded=${confirmed.json.recorded}`,
  `expected 201 created, got ${confirmed.status} ${JSON.stringify(confirmed.json)}`,
);
const rec = confirmed.json.deposit ?? {};
info(`authority     ${rec.authority}`);
info(`sharesMinted  ${rec.sharesMinted}  (source: ${confirmed.json.sharesFrom})`);
info(`sharesAfter   ${rec.sharesAfter}`);
info(`slot          ${rec.slot}`);

assert(
  rec.authority === throwaway.publicKey.toBase58(),
  "the recorded authority is the USER's wallet",
);
assert(
  confirmed.json.sharesFrom === "program_event",
  "the share count came from the program's own Deposited event, not the client",
);

const depositorAfter = await fetchVaultDepositorAccount(connection, depositorPda);
assert(
  depositorAfter !== null,
  `the VaultDepositor PDA now EXISTS on chain (${depositorPda.toBase58()})`,
  "the depositor PDA still does not exist",
);
if (depositorAfter) {
  info(`on-chain authority ${depositorAfter.data.authority.toBase58()}`);
  info(`on-chain shares    ${depositorAfter.data.shares}`);
  info(`on-chain deposits  ${SOL(depositorAfter.data.netDepositsLamports)}`);
  assert(
    depositorAfter.data.authority.equals(throwaway.publicKey),
    "the on-chain record's authority is the USER's key — the shares are theirs, not ours",
  );
  assert(
    depositorAfter.data.shares > 0n,
    `the on-chain record holds ${depositorAfter.data.shares} shares (was: nonexistent)`,
  );
  assert(
    depositorAfter.data.shares.toString() === rec.sharesAfter,
    "the API's recorded shares match the account re-read from the chain",
  );
  assert(
    depositorAfter.data.shares.toString() === prepared.sharesExpected,
    `the chain minted exactly what prepare quoted (${prepared.sharesExpected})`,
    `quoted ${prepared.sharesExpected}, chain minted ${depositorAfter.data.shares}`,
  );
  assert(
    depositorAfter.data.netDepositsLamports === solToLamports(DEPOSIT_SOL),
    `net deposits = ${SOL(depositorAfter.data.netDepositsLamports)}`,
  );
}

const after = await fetchVaultAccount(connection, derivedPda);
assert(
  after.data.navLamports - before.data.navLamports === solToLamports(DEPOSIT_SOL),
  `vault NAV moved by exactly the deposit (${SOL(after.data.navLamports - before.data.navLamports)})`,
  `NAV moved by ${after.data.navLamports - before.data.navLamports}`,
);

const dbRow = await prisma.onChainDeposit.findUnique({ where: { signature: depositSig } });
assert(dbRow !== null, "the deposit is indexed in the database against the user");
if (dbRow) {
  const dbUser = await prisma.user.findUnique({ where: { id: dbRow.userId } });
  assert(
    dbUser?.privyId === USER_DID,
    `the row belongs to the verified Privy user (${dbUser?.privyId})`,
  );
  assert(
    dbUser?.walletAddress === throwaway.publicKey.toBase58(),
    "the user's verified wallet address was persisted",
  );
}

// ═══════════════════════════════════════════════════════════════════
step(8, "confirm is idempotent, and refuses anything that is not this deposit");
{
  const again = await call("/api/onchain/deposit/confirm", {
    method: "POST",
    tokens: goodTokens,
    body: { vaultId: VAULT_ID, signature: depositSig },
  });
  assert(
    again.status === 200 && again.json.recorded === "already",
    `replaying confirm → 200 recorded=${again.json.recorded} (no double-count)`,
    `expected 200 already, got ${again.status} ${JSON.stringify(again.json)}`,
  );
  const rows = await prisma.onChainDeposit.count({ where: { signature: depositSig } });
  assert(rows === 1, `exactly one row exists for that signature (${rows})`);
}
{
  // A different verified user cannot claim someone else's transaction.
  const stranger = Keypair.generate();
  const strangerTokens = await mintTokens({
    did: `did:privy:stranger${RUN_ID}`,
    wallet: stranger.publicKey.toBase58(),
  });
  const r = await call("/api/onchain/deposit/confirm", {
    method: "POST",
    tokens: strangerTokens,
    body: { vaultId: VAULT_ID, signature: depositSig },
  });
  assert(
    r.status === 409 && r.json.code === "signature_claimed",
    `another user confirming the same signature → 409 ${r.json.code}`,
    `expected 409 signature_claimed, got ${r.status} ${JSON.stringify(r.json)}`,
  );
}
{
  // A transaction the user really did sign, but which is not a deposit.
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const noop = new (await import("@solana/web3.js")).Transaction({
    feePayer: throwaway.publicKey,
    blockhash,
    lastValidBlockHeight,
  }).add(
    SystemProgram.transfer({
      fromPubkey: throwaway.publicKey,
      toPubkey: throwaway.publicKey,
      lamports: 1,
    }),
  );
  noop.sign(throwaway);
  const noopSig = await connection.sendRawTransaction(noop.serialize());
  await connection.confirmTransaction({ signature: noopSig, blockhash, lastValidBlockHeight }, "confirmed");
  txs.push(["decoy self-transfer (user-signed, not a deposit)", noopSig]);
  const r = await call("/api/onchain/deposit/confirm", {
    method: "POST",
    tokens: goodTokens,
    body: { vaultId: VAULT_ID, signature: noopSig },
  });
  assert(
    r.status === 409 && r.json.code === "not_a_deposit",
    `confirming a non-deposit the user signed → 409 ${r.json.code}`,
    `expected 409 not_a_deposit, got ${r.status} ${JSON.stringify(r.json)}`,
  );
}

{
  // The caller's own history, scoped to them.
  const mine = await call(`/api/onchain/deposits?vaultId=${VAULT_ID}`, { tokens: goodTokens });
  assert(
    mine.status === 200 && mine.json.deposits?.some((d) => d.signature === depositSig),
    `GET /deposits lists the caller's own deposit (${mine.json.deposits?.length} row(s))`,
    `expected the deposit in the list, got ${mine.status} ${JSON.stringify(mine.json)}`,
  );
  const stranger = await mintTokens({
    did: `did:privy:onlooker${RUN_ID}`,
    wallet: Keypair.generate().publicKey.toBase58(),
  });
  const theirs = await call("/api/onchain/deposits", { tokens: stranger });
  assert(
    theirs.status === 200 && theirs.json.deposits?.length === 0,
    "GET /deposits shows another user nothing (scoped to the caller)",
    `expected an empty list, got ${JSON.stringify(theirs.json)}`,
  );
}

// ═══════════════════════════════════════════════════════════════════
step(9, "the demo-ledger wall still stands for real vaults");
for (const [path, body] of [
  [`/api/vaults/${VAULT_ID}/deposit`, { sol: 1 }],
  [`/api/vaults/${VAULT_ID}/withdraw`, { shares: 1 }],
  [`/api/vaults/${VAULT_ID}/trade`, { side: "buy", mint: "So11111111111111111111111111111111111111112", solAmount: 1 }],
]) {
  const r = await call(path, { method: "POST", body });
  assert(
    r.status === 409,
    `POST ${path.replace(VAULT_ID, ":id")} → 409 (real vaults never touch the paper ledger)`,
    `expected 409, got ${r.status} ${JSON.stringify(r.json)}`,
  );
}

// ═══════════════════════════════════════════════════════════════════
console.log("\n── transactions ───────────────────────────────────────────");
for (const [label, sig] of txs) {
  console.log(`  ${label}`);
  console.log(`    ${sig}`);
  console.log(`    ${explorerTx(sig)}`);
}

console.log("\n── result ─────────────────────────────────────────────────");
console.log(`  user wallet     ${throwaway.publicKey.toBase58()}`);
console.log(`  depositor PDA   ${depositorPda.toBase58()}`);
console.log(`  deposited       ${DEPOSIT_SOL} SOL`);
console.log(`  shares          ${depositorAfter?.data.shares ?? "?"}`);
console.log(`  ${checks.length} checks passed, ${failures.length} failed`);
for (const f of failures) console.log(`   ✗ ${f}`);

globalThis.fetch = realFetch;
httpServer.close();
await prisma.$disconnect();
process.exit(failures.length === 0 ? 0 : 1);
