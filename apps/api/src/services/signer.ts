// ── Trader Vaults server signer ───────────────────────────────────────────
// Loads the server keypair (devnet: it is admin + trader + NAV keeper)
// and owns the wire: build → sign → simulate → send → confirm → read the
// logs back.
//
// THE POINT OF THIS FILE IS THE LOGS. A failed Solana transaction reports
// itself as `custom program error: 0x1771`, which tells you nothing; the
// program's own `msg!`/Anchor `AnchorError ... Error Code: NavStale`
// lines tell you everything. So every failure path here — simulation,
// send, confirmation — is captured into an OnChainError that carries the
// program log lines with it. Debugging blind is the thing to avoid.
//
// SCOPE: the server key signs PLATFORM actions (creating a vault it
// operates, posting NAV as keeper) and, for now, the devnet proof-of-life
// deposit. A real USER deposit must be signed by the USER's wallet — see
// routes/vaults.ts for exactly what is left to wire that up.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Commitment,
  Connection,
  Keypair,
  PublicKey,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { env } from "../env.js";

// ── connection ─────────────────────────────────────────────────────

let cachedConnection: Connection | null = null;
let cachedConnectionUrl = "";

/** Shared devnet/mainnet connection at `confirmed`. */
export function getConnection(): Connection {
  const url = env.solanaRpcUrl;
  if (!cachedConnection || cachedConnectionUrl !== url) {
    cachedConnection = new Connection(url, "confirmed");
    cachedConnectionUrl = url;
  }
  return cachedConnection;
}

// ── keypair ────────────────────────────────────────────────────────

export function defaultKeypairPath(): string {
  return env.solanaKeypairPath || join(homedir(), ".config", "solana", "id.json");
}

/**
 * Parse a keypair from a JSON byte array, wherever it came from.
 */
function keypairFromBytes(raw: string, source: string): Keypair {
  let bytes: number[];
  try {
    bytes = JSON.parse(raw) as number[];
  } catch {
    throw new Error(`keypair from ${source} is not a JSON byte array`);
  }
  if (!Array.isArray(bytes) || (bytes.length !== 64 && bytes.length !== 32)) {
    throw new Error(`keypair from ${source} must be a 64-byte (or 32-byte seed) JSON array`);
  }
  return bytes.length === 64
    ? Keypair.fromSecretKey(Uint8Array.from(bytes))
    : Keypair.fromSeed(Uint8Array.from(bytes));
}

/**
 * The key as an environment variable rather than a file.
 *
 * This is why no vault has ever existed on-chain. The loader only read from
 * disk, Railway containers have no persistent filesystem to put a key on, so
 * SOLANA_KEYPAIR_PATH was never set in production — and init_vault takes the
 * "missing server keypair" branch that leaves the row off-chain and says so
 * in a log nobody reads. Every "real" vault is a database row with
 * onchainVaultPda = null.
 *
 * Checked before the file path so a deployed key always wins.
 */
export function keypairFromEnv(): Keypair | null {
  const raw = env.solanaKeypairJson;
  if (!raw) return null;
  return keypairFromBytes(raw.trim(), "SOLANA_KEYPAIR_JSON");
}

export function keypairFromFile(path: string): Keypair {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(
      `cannot read Solana keypair at ${path}: ${(e as Error).message} — ` +
        "set SOLANA_KEYPAIR_PATH or create one with `solana-keygen new`",
    );
  }
  return keypairFromBytes(raw, path);
}

let cachedSigner: Keypair | null = null;

/** The server keypair. Throws (with the path) when it cannot be loaded. */
export function getServerKeypair(): Keypair {
  if (!cachedSigner) {
    // env first: a deployed key must win over whatever happens to be on disk
    cachedSigner = keypairFromEnv() ?? keypairFromFile(defaultKeypairPath());
  }
  return cachedSigner;
}

/** Non-throwing probe — routes use it to degrade instead of 500ing. */
export function tryGetServerKeypair(): { keypair: Keypair } | { error: string } {
  try {
    return { keypair: getServerKeypair() };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export function getServerPublicKey(): PublicKey {
  return getServerKeypair().publicKey;
}

let cachedKeeper: Keypair | null = null;
let warnedAboutKeeperFallback = false;

/**
 * The NAV keeper keypair.
 *
 * Distinct from the server key by design — see env.navKeeperKeypairJson. The
 * keeper signs post_nav every hour and holds no other authority: it cannot
 * upgrade the program, cannot unfreeze a circuit breaker and cannot sweep the
 * treasury.
 *
 * Falling back to the server key keeps local and read-only deployments
 * working, but it reinstates exactly the concentration the split exists to
 * remove, so it says so — once, loudly.
 */
export function getNavKeeperKeypair(): Keypair {
  if (!cachedKeeper) {
    const raw = env.navKeeperKeypairJson;
    if (raw) {
      cachedKeeper = keypairFromBytes(raw.trim(), "NAV_KEEPER_KEYPAIR_JSON");
    } else {
      if (!warnedAboutKeeperFallback) {
        warnedAboutKeeperFallback = true;
        console.warn(
          "[signer] NAV_KEEPER_KEYPAIR_JSON is unset — falling back to the server key. " +
            "That makes the NAV keeper, the platform admin and the program upgrade " +
            "authority one always-online key, which is the concentration the keeper " +
            "split exists to remove. Set it before this holds real money.",
        );
      }
      cachedKeeper = getServerKeypair();
    }
  }
  return cachedKeeper;
}

/** Non-throwing probe, matching tryGetServerKeypair. */
export function tryGetNavKeeperKeypair(): { keypair: Keypair } | { error: string } {
  try {
    return { keypair: getNavKeeperKeypair() };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

// ── errors that carry logs ─────────────────────────────────────────

export class OnChainError extends Error {
  readonly logs: string[];
  readonly signature?: string;
  readonly phase: "simulate" | "send" | "confirm";
  readonly cause?: unknown;

  constructor(params: {
    message: string;
    logs?: string[] | null;
    signature?: string;
    phase: "simulate" | "send" | "confirm";
    cause?: unknown;
  }) {
    // Fold the last few log lines into the message: whatever swallows the
    // error (an HTTP 500 body, a bare console.error) still shows the cause.
    const logs = params.logs ?? [];
    const tail = logs.filter((l) => /Error|error|failed|Program log:/.test(l)).slice(-6);
    super(tail.length > 0 ? `${params.message}\n  ${tail.join("\n  ")}` : params.message);
    this.name = "OnChainError";
    this.logs = logs;
    this.signature = params.signature;
    this.phase = params.phase;
    this.cause = params.cause;
  }

  /** Anchor prints `Error Code: <Name>. Error Number: <n>.` — pull the name. */
  get anchorErrorCode(): string | null {
    for (const l of this.logs) {
      const m = /Error Code: (\w+)\./.exec(l);
      if (m) return m[1] ?? null;
    }
    return null;
  }

  toJson(): Record<string, unknown> {
    return {
      error: this.message.split("\n")[0],
      phase: this.phase,
      anchorError: this.anchorErrorCode,
      signature: this.signature ?? null,
      logs: this.logs,
    };
  }
}

/** Pull program logs off whatever shape web3.js threw at us. */
export function extractLogs(e: unknown): string[] | null {
  if (!e || typeof e !== "object") return null;
  const any = e as Record<string, unknown>;
  if (Array.isArray(any.logs)) return any.logs as string[];
  const value = any.value as { logs?: string[] } | undefined;
  if (value && Array.isArray(value.logs)) return value.logs;
  if (Array.isArray(any.transactionLogs)) return any.transactionLogs as string[];
  return null;
}

// ── build / sign / send ────────────────────────────────────────────

export interface SendOptions {
  /** Simulate before spending a fee (default true). Costs one RPC call. */
  simulate?: boolean;
  /** Commitment to confirm at (default "confirmed"). */
  commitment?: Commitment;
  /** Fee payer / primary signer (default: the server keypair). */
  payer?: Keypair;
  /** Human label used in error messages and logs. */
  label?: string;
}

export interface SendResult {
  signature: string;
  /** On-chain logs from getTransaction (falls back to simulation logs). */
  logs: string[];
  slot: number | null;
  feeLamports: number | null;
  unitsConsumed: number | null;
}

function dedupeSigners(signers: Keypair[]): Keypair[] {
  const seen = new Set<string>();
  const out: Keypair[] = [];
  for (const s of signers) {
    const k = s.publicKey.toBase58();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/**
 * Build a v0 transaction from `ixs`, sign it with the server keypair (plus
 * any extra signers), simulate it, send it and confirm it.
 *
 * Throws OnChainError — carrying the program log lines — on every failure
 * path. Returns the signature and the CONFIRMED on-chain logs on success.
 */
export async function sendAndConfirm(
  ixs: TransactionInstruction[],
  extraSigners: Keypair[] = [],
  options: SendOptions = {},
): Promise<SendResult> {
  if (ixs.length === 0) throw new Error("sendAndConfirm: no instructions");
  const connection = getConnection();
  const commitment = options.commitment ?? "confirmed";
  const payer = options.payer ?? getServerKeypair();
  const label = options.label ?? "transaction";
  const signers = dedupeSigners([payer, ...extraSigners]);

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(commitment);
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign(signers);

  // ── simulate ─────────────────────────────────────────────────────
  let simLogs: string[] = [];
  let unitsConsumed: number | null = null;
  if (options.simulate !== false) {
    const sim = await connection.simulateTransaction(tx, {
      commitment,
      sigVerify: false,
      replaceRecentBlockhash: false,
    });
    simLogs = sim.value.logs ?? [];
    unitsConsumed = sim.value.unitsConsumed ?? null;
    if (sim.value.err) {
      throw new OnChainError({
        message: `${label} failed in simulation: ${JSON.stringify(sim.value.err)}`,
        logs: simLogs,
        phase: "simulate",
        cause: sim.value.err,
      });
    }
  }

  // ── send ─────────────────────────────────────────────────────────
  let signature: string;
  try {
    signature = await connection.sendTransaction(tx, {
      skipPreflight: false,
      preflightCommitment: commitment,
      maxRetries: 3,
    });
  } catch (e) {
    // SendTransactionError hides its logs behind an async getter on newer
    // web3.js; try both shapes before giving up on them.
    let logs = extractLogs(e);
    const getLogs = (e as { getLogs?: (c: Connection) => Promise<string[] | null> }).getLogs;
    if (!logs && typeof getLogs === "function") {
      try {
        logs = await getLogs.call(e, connection);
      } catch {
        /* keep the original error */
      }
    }
    throw new OnChainError({
      message: `${label} rejected on send: ${(e as Error).message}`,
      logs: logs ?? simLogs,
      phase: "send",
      cause: e,
    });
  }

  // ── confirm ──────────────────────────────────────────────────────
  const confirmation = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    commitment,
  );
  const onChain = await connection
    .getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })
    .catch(() => null);
  const logs = onChain?.meta?.logMessages ?? simLogs;

  if (confirmation.value.err) {
    throw new OnChainError({
      message: `${label} landed but FAILED: ${JSON.stringify(confirmation.value.err)}`,
      logs,
      signature,
      phase: "confirm",
      cause: confirmation.value.err,
    });
  }

  return {
    signature,
    logs,
    slot: onChain?.slot ?? null,
    feeLamports: onChain?.meta?.fee ?? null,
    unitsConsumed: onChain?.meta?.computeUnitsConsumed ?? unitsConsumed,
  };
}

/**
 * Dry run only — no fee, no state change. Used to validate an instruction
 * path (and read its logs) before committing scarce devnet SOL to it.
 */
export async function simulateOnly(
  ixs: TransactionInstruction[],
  extraSigners: Keypair[] = [],
  options: Omit<SendOptions, "simulate"> = {},
): Promise<{ ok: boolean; err: unknown; logs: string[]; unitsConsumed: number | null }> {
  const connection = getConnection();
  const commitment = options.commitment ?? "confirmed";
  const payer = options.payer ?? getServerKeypair();
  const { blockhash } = await connection.getLatestBlockhash(commitment);
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign(dedupeSigners([payer, ...extraSigners]));
  const sim = await connection.simulateTransaction(tx, {
    commitment,
    sigVerify: false,
    replaceRecentBlockhash: false,
  });
  return {
    ok: !sim.value.err,
    err: sim.value.err,
    logs: sim.value.logs ?? [],
    unitsConsumed: sim.value.unitsConsumed ?? null,
  };
}

/**
 * Current slot at CONFIRMED commitment — the correct input for post_nav's
 * `mark_slot`, which must be <= the slot the transaction executes at.
 */
export async function getConfirmedSlot(): Promise<bigint> {
  return BigInt(await getConnection().getSlot("confirmed"));
}

/** Lamport balance of any account (0 when it does not exist). */
export async function getLamports(address: PublicKey): Promise<bigint> {
  return BigInt(await getConnection().getBalance(address, "confirmed"));
}
