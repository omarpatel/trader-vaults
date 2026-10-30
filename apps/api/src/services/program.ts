// ── Trader Vaults on-chain client ─────────────────────────────────────────
// The Anchor program has NO IDL (it was deployed straight from the
// SBF build), so this module is the hand-rolled client: discriminators,
// PDA derivations, borsh codecs and instruction builders, all mirrored
// from programs/vault/programs/vault/src/{lib.rs,state.rs,instructions/*}.
//
// RULES this file lives by — every one of them cost a failed devnet tx
// somewhere to learn, so do not "tidy" them away:
//
//   1. Instruction discriminator = sha256("global:<snake_case_name>")[0..8].
//      Account   discriminator = sha256("account:<StructName>")[0..8].
//   2. Account METAS must appear in the exact order the `#[derive(Accounts)]`
//      struct declares its fields — Anchor resolves positionally, so a
//      swapped pair fails as a seeds/owner error that names the wrong
//      account. `Program<'info, System>` is a REAL slot (the caller passes
//      the system program), as is any `Program<'info, Vault>`.
//   3. Args are borsh-encoded in struct/parameter order, little-endian,
//      enums as a single u8 variant index, `[u8; 32]` as raw bytes with no
//      length prefix (a Vec<u8> would carry a u32 prefix — the name field
//      is a fixed array and must NOT).
//   4. Nothing here signs or sends. Builders return TransactionInstruction;
//      signer.ts owns keys and the wire.
//
// Fetch helpers verify BOTH the account owner and the 8-byte discriminator
// before decoding: decoding an arbitrary account as a Vault would silently
// produce plausible-looking numbers, which is exactly how fake TVL gets
// into a UI.

import { createHash } from "node:crypto";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountInfo,
  type AccountMeta,
  type Connection,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { env } from "../env.js";

// ── program id / seeds (state.rs) ──────────────────────────────────

export const VAULT_PROGRAM_ID = new PublicKey(env.vaultProgramId);

// External program IDs
export const JUPITER_ROUTER_V6 = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

export const VAULT_SEED = Buffer.from("vault");
export const VAULT_DEPOSITOR_SEED = Buffer.from("vault_depositor");
/**
 * v2: PlatformConfig gained nav_keeper, pending_admin and padding, and an
 * allocated PDA cannot grow. Must match state.rs::PLATFORM_CONFIG_SEED.
 */
export const PLATFORM_CONFIG_SEED = Buffer.from("platform_config_v2");
/** v2 — see state.rs::TREASURY_SEED. */
export const TREASURY_SEED = Buffer.from("treasury_v2");

// ── economic constants (state.rs) — mirrored so the API can validate
// before spending a transaction fee on a guaranteed revert ───────────
export const MIN_SEED_LAMPORTS = 10_000_000n; // 0.01 SOL
export const MIN_DEPOSIT_LAMPORTS = 1_000n;
export const MIN_PERF_FEE_BPS_AT_INIT = 1_000;
export const MAX_PERF_FEE_BPS = 3_000;
export const MIN_NAV_STALENESS_SECONDS = 60;
export const MAX_NAV_STALENESS_SECONDS = 86_400;
/** state.rs::MAX_SWAP_EQUITY_BPS — most of equity one swap may move. */
export const MAX_SWAP_EQUITY_BPS = 500;
/** state.rs::MAX_DAILY_SWAP_SPEND_BPS — cumulative wSOL spend per UTC day. */
export const MAX_DAILY_SWAP_SPEND_BPS = 20_000;
/** state.rs::MIN_SELL_RECOVERY_BPS — floor on a sell against recorded basis. */
export const MIN_SELL_RECOVERY_BPS = 5_000;
export const MAX_REDEEM_WINDOW_SECONDS = 30 * 86_400;
/** state.rs::MIN_REDEEM_WINDOW_SECONDS - a zero window is an instant withdraw. */
export const MIN_REDEEM_WINDOW_SECONDS = 60 * 60;
/** state.rs::MIN_UNLOCK_PERIOD_SECONDS - the drip may not be switched off. */
export const MIN_UNLOCK_PERIOD_SECONDS = 60 * 60;
/** state.rs::MIN_DAILY_LOSS_LIMIT_BPS / MAX_DAILY_LOSS_LIMIT_BPS. */
export const MIN_DAILY_LOSS_LIMIT_BPS = 100;
export const MAX_DAILY_LOSS_LIMIT_BPS = 5_000;
/** state.rs::MAX_TRADE_NOTIONAL_CEILING (1M SOL). */
export const MAX_TRADE_NOTIONAL_CEILING = 1_000_000_000_000_000n;
/** state.rs::MIN_DEPOSIT_HOLD_SECONDS - instant exits carry a hold. */
export const MIN_DEPOSIT_HOLD_SECONDS = 3_600;
/** state.rs::DEPOSIT_COOLDOWN_SECONDS - deposits pause after a large mark. */
export const DEPOSIT_COOLDOWN_SECONDS = 3_600;

export const MAX_UNLOCK_PERIOD_SECONDS = 7 * 86_400;
export const MIN_NAV_DELTA_BPS = 100;
export const MAX_NAV_DELTA_BPS = 5_000;
export const MAX_NAV_MARK_AGE_SLOTS = 750n;
export const MAX_NAV_LAMPORTS = 10_000_000_000_000_000n;
export const VIRTUAL_SHARES = 1_000n;
export const VIRTUAL_LAMPORTS = 1n;
export const LAMPORTS_PER_SOL = 1_000_000_000n;

// ── discriminators ─────────────────────────────────────────────────

const sha256 = (s: string): Buffer => createHash("sha256").update(s).digest();

/** Anchor instruction discriminator: sha256("global:<snake_case>")[0..8]. */
export function ixDiscriminator(snakeName: string): Buffer {
  return sha256(`global:${snakeName}`).subarray(0, 8);
}

/** Anchor account discriminator: sha256("account:<Struct>")[0..8]. */
export function accountDiscriminator(structName: string): Buffer {
  return sha256(`account:${structName}`).subarray(0, 8);
}

// ── borsh (the 1% of it this program uses) ─────────────────────────

class BorshWriter {
  private chunks: Buffer[] = [];
  u8(v: number): this {
    const b = Buffer.alloc(1);
    b.writeUInt8(v);
    this.chunks.push(b);
    return this;
  }
  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }
  u16(v: number): this {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v);
    this.chunks.push(b);
    return this;
  }
  u64(v: bigint): this {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v);
    this.chunks.push(b);
    return this;
  }
  u32(v: number): this {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    this.chunks.push(b);
    return this;
  }
  i64(v: bigint): this {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(v);
    this.chunks.push(b);
    return this;
  }
  u128(v: bigint): this {
    const b = Buffer.alloc(16);
    b.writeBigUInt64LE(v & 0xffff_ffff_ffff_ffffn, 0);
    b.writeBigUInt64LE(v >> 64n, 8);
    this.chunks.push(b);
    return this;
  }
  pubkey(v: PublicKey): this {
    this.chunks.push(Buffer.from(v.toBytes()));
    return this;
  }
  /** Fixed-length byte array — NO length prefix (that is Vec<u8>). */
  fixedBytes(v: Buffer, len: number): this {
    if (v.length !== len) throw new Error(`expected ${len} bytes, got ${v.length}`);
    this.chunks.push(Buffer.from(v));
    return this;
  }
  /** Variable-length bytes — encodes as Vec<u8> (length prefix + bytes). */
  bytes(v: Buffer): this {
    this.u32(v.length);
    this.chunks.push(Buffer.from(v));
    return this;
  }
  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

class BorshReader {
  private o = 0;
  constructor(private readonly buf: Buffer) {}
  skip(n: number): this {
    this.o += n;
    return this;
  }
  u8(): number {
    const v = this.buf.readUInt8(this.o);
    this.o += 1;
    return v;
  }
  bool(): boolean {
    const raw = this.u8();
    if (raw > 1) throw new Error(`invalid bool byte 0x${raw.toString(16)}`);
    return raw === 1;
  }
  u16(): number {
    const v = this.buf.readUInt16LE(this.o);
    this.o += 2;
    return v;
  }
  u64(): bigint {
    const v = this.buf.readBigUInt64LE(this.o);
    this.o += 8;
    return v;
  }
  i64(): bigint {
    const v = this.buf.readBigInt64LE(this.o);
    this.o += 8;
    return v;
  }
  u128(): bigint {
    const lo = this.buf.readBigUInt64LE(this.o);
    const hi = this.buf.readBigUInt64LE(this.o + 8);
    this.o += 16;
    return (hi << 64n) | lo;
  }
  pubkey(): PublicKey {
    const v = new PublicKey(this.buf.subarray(this.o, this.o + 32));
    this.o += 32;
    return v;
  }
  bytes(n: number): Buffer {
    const v = Buffer.from(this.buf.subarray(this.o, this.o + n));
    this.o += n;
    return v;
  }
  get offset(): number {
    return this.o;
  }
}

// ── enums (borsh: u8 variant index, declaration order) ─────────────

export const VAULT_TYPE = { Managed: 0, Mirror: 1 } as const;
export type VaultTypeName = keyof typeof VAULT_TYPE;

const VAULT_STATUS_NAMES = ["Active", "Frozen", "Closed"] as const;
const FROZEN_BY_NAMES = ["None", "Trader", "Platform", "RiskBreaker"] as const;
const VAULT_TYPE_NAMES = ["Managed", "Mirror"] as const;

function enumName<T extends readonly string[]>(names: T, idx: number, what: string): T[number] {
  const n = names[idx];
  if (n === undefined) throw new Error(`invalid ${what} discriminant ${idx}`);
  return n;
}

// ── vault name ⇄ 32-byte seed ──────────────────────────────────────

/**
 * The vault PDA seed is a FIXED 32-byte name, so it is globally unique and
 * the account can be re-derived from nothing but the name. Callers pass a
 * short ASCII handle (we use the DB row id, a cuid); it is utf8-encoded and
 * zero-padded. Encoding is deterministic in both directions, so a stored
 * vault's PDA never has to be trusted from the database alone — it can
 * always be re-derived and compared.
 */
export function encodeVaultName(name: string): Buffer {
  const raw = Buffer.from(name, "utf8");
  if (raw.length === 0) throw new Error("vault name must not be empty");
  if (raw.length > 32) throw new Error(`vault name is ${raw.length} bytes, max 32`);
  const out = Buffer.alloc(32);
  raw.copy(out);
  return out;
}

/** Inverse of encodeVaultName: strip trailing NULs. */
export function decodeVaultName(raw: Buffer): string {
  let end = raw.length;
  while (end > 0 && raw[end - 1] === 0) end -= 1;
  return raw.subarray(0, end).toString("utf8");
}

// ── PDAs (every seed in state.rs) ──────────────────────────────────

export function platformConfigPda(programId: PublicKey = VAULT_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([PLATFORM_CONFIG_SEED], programId);
}

export function treasuryPda(programId: PublicKey = VAULT_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([TREASURY_SEED], programId);
}

/**
 * Vault PDA: ["vault", creator, name].
 *
 * The creator is part of the seeds so a vault name is unique PER CREATOR.
 * It used to be the name alone on a permissionless instruction, which meant
 * anyone watching for a launch could take the PDA with a higher priority fee
 * and become the trader of the name everyone was about to deposit into.
 */
export function vaultPda(
  creator: PublicKey,
  name: string | Buffer,
  programId: PublicKey = VAULT_PROGRAM_ID,
): [PublicKey, number] {
  const nameBytes = Buffer.isBuffer(name) ? name : encodeVaultName(name);
  return PublicKey.findProgramAddressSync(
    [VAULT_SEED, creator.toBuffer(), nameBytes],
    programId,
  );
}

export function vaultDepositorPda(
  vault: PublicKey,
  authority: PublicKey,
  programId: PublicKey = VAULT_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [VAULT_DEPOSITOR_SEED, vault.toBuffer(), authority.toBuffer()],
    programId,
  );
}

/** ProgramData PDA of the upgradeable loader (init_platform's admin gate). */
export const BPF_LOADER_UPGRADEABLE = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);
export function programDataPda(programId: PublicKey = VAULT_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([programId.toBuffer()], BPF_LOADER_UPGRADEABLE);
}

// ── decoded account shapes ─────────────────────────────────────────

export interface PlatformConfigAccount {
  bump: number;
  treasuryBump: number;
  admin: PublicKey;
  /** staged admin handover; PublicKey.default when none is outstanding */
  pendingAdmin: PublicKey;
  /** the dedicated NAV keeper key, deliberately NOT the admin */
  navKeeper: PublicKey;
  killSwitch: boolean;
}

/** A recorded holding and what the vault paid for it (execute_swap basis). */
export interface VaultPosition {
  mint: PublicKey;
  tokenAmount: bigint;
  wsolBasisLamports: bigint;
}

export interface WithdrawRequestState {
  shares: bigint;
  valueAtRequestLamports: bigint;
  requestedAt: bigint;
}

export interface VaultAccount {
  bump: number;
  name: string;
  nameBytes: Buffer;
  /** part of the PDA seeds, so immutable; see vaultPda */
  creator: PublicKey;
  trader: PublicKey;
  operator: PublicKey;
  navKeeper: PublicKey;
  vaultType: (typeof VAULT_TYPE_NAMES)[number];
  status: (typeof VAULT_STATUS_NAMES)[number];
  frozenBy: (typeof FROZEN_BY_NAMES)[number];
  perfFeeBps: number;
  platformProfitBps: number;
  redeemWindowSeconds: bigint;
  navStalenessSeconds: bigint;
  totalShares: bigint;
  seedShares: bigint;
  managerShares: bigint;
  navLamports: bigint;
  navSlot: bigint;
  navPostedAt: bigint;
  lockedProfit: bigint;
  lockedProfitTs: bigint;
  unlockPeriodSeconds: bigint;
  maxNavDeltaBps: number;
  maxTradeNotionalLamports: bigint;
  maxPriceImpactBps: number;
  dailyLossLimitBps: number;
  dailyLossAccumulator: bigint;
  dailyGainAccumulator: bigint;
  dayBucket: bigint;
  dayStartEquity: bigint;
  /** deposits refused until this unix time, after a large NAV move */
  depositCooldownUntil: bigint;
  dailySwapSpendLamports: bigint;
  swapDayBucket: bigint;
  pendingWithdrawValueLamports: bigint;
  pendingWithdrawShares: bigint;
  platformFeesOwedLamports: bigint;
  enforceMintAllowlist: boolean;
  allowedMints: PublicKey[];
  positions: VaultPosition[];
}

export interface VaultDepositorAccount {
  bump: number;
  vault: PublicKey;
  authority: PublicKey;
  shares: bigint;
  netDepositsLamports: bigint;
  cumulativeProfitShareLamports: bigint;
  lastWithdrawRequest: WithdrawRequestState;
  /** gates instant_withdraw for MIN_DEPOSIT_HOLD_SECONDS */
  lastDepositTs: bigint;
}

// ── decoders ───────────────────────────────────────────────────────

function assertDiscriminator(data: Buffer, structName: string): void {
  const want = accountDiscriminator(structName);
  const got = data.subarray(0, 8);
  if (!got.equals(want)) {
    throw new Error(
      `account discriminator mismatch for ${structName}: got ${got.toString("hex")}, ` +
        `want ${want.toString("hex")} — this account is not a ${structName}`,
    );
  }
}

export function decodePlatformConfig(data: Buffer): PlatformConfigAccount {
  assertDiscriminator(data, "PlatformConfig");
  const r = new BorshReader(data);
  r.skip(8);
  return {
    bump: r.u8(),
    treasuryBump: r.u8(),
    admin: r.pubkey(),
    pendingAdmin: r.pubkey(),
    navKeeper: r.pubkey(),
    killSwitch: r.bool(),
  };
}

/**
 * An account written by an older build of the program.
 *
 * The Vault layout grew (647 -> 1095 bytes) and vault PDAs are seeded on
 * [creator, name] now instead of the name alone, so accounts created by the
 * previous build are unreachable and undecodable. Reading one used to throw a
 * bare `RangeError: offset out of range`, which says nothing about what is
 * actually wrong; callers that should SKIP a stale account could not tell it
 * apart from a real decode bug.
 */
export class StaleVaultLayoutError extends Error {
  readonly actualBytes: number;
  readonly expectedBytes: number;
  constructor(actual: number, expected: number) {
    super(
      `vault account is ${actual} bytes, this build expects ${expected} — ` +
        "it was written by an older program layout and cannot be decoded",
    );
    this.name = "StaleVaultLayoutError";
    this.actualBytes = actual;
    this.expectedBytes = expected;
  }
}

/**
 * 8-byte discriminator + Vault::INIT_SPACE.
 *
 * Printed by the program's own `print_account_sizes` test. Keep them together:
 * `getProgramAccounts` filters match on dataSize, so a layout change that
 * misses this orphans every indexer built on it.
 */
export const VAULT_ACCOUNT_BYTES = 1095;

export function decodeVault(data: Buffer): VaultAccount {
  assertDiscriminator(data, "Vault");
  if (data.length !== VAULT_ACCOUNT_BYTES) {
    throw new StaleVaultLayoutError(data.length, VAULT_ACCOUNT_BYTES);
  }
  const r = new BorshReader(data);
  r.skip(8);
  const bump = r.u8();
  const nameBytes = r.bytes(32);
  const creator = r.pubkey();
  const trader = r.pubkey();
  const operator = r.pubkey();
  const navKeeper = r.pubkey();
  const vaultType = enumName(VAULT_TYPE_NAMES, r.u8(), "VaultType");
  const status = enumName(VAULT_STATUS_NAMES, r.u8(), "VaultStatus");
  const frozenBy = enumName(FROZEN_BY_NAMES, r.u8(), "FrozenBy");
  const perfFeeBps = r.u16();
  const platformProfitBps = r.u16();
  const redeemWindowSeconds = r.i64();
  const navStalenessSeconds = r.i64();
  const totalShares = r.u128();
  const seedShares = r.u128();
  const managerShares = r.u128();
  const navLamports = r.u64();
  const navSlot = r.u64();
  const navPostedAt = r.i64();
  const lockedProfit = r.u64();
  const lockedProfitTs = r.i64();
  const unlockPeriodSeconds = r.i64();
  const maxNavDeltaBps = r.u16();
  const maxTradeNotionalLamports = r.u64();
  const maxPriceImpactBps = r.u16();
  const dailyLossLimitBps = r.u16();
  const dailyLossAccumulator = r.u64();
  const dailyGainAccumulator = r.u64();
  const dayBucket = r.i64();
  const dayStartEquity = r.u64();
  const depositCooldownUntil = r.i64();
  const dailySwapSpendLamports = r.u64();
  const swapDayBucket = r.i64();
  const pendingWithdrawValueLamports = r.u64();
  const pendingWithdrawShares = r.u128();
  const platformFeesOwedLamports = r.u64();
  const enforceMintAllowlist = r.bool();
  const allowedMints: PublicKey[] = [];
  for (let i = 0; i < 8; i += 1) allowedMints.push(r.pubkey());
  // Recorded cost basis, one slot per held mint. Empty slots carry the
  // default pubkey and are dropped rather than surfaced as a holding.
  const positions: VaultPosition[] = [];
  for (let i = 0; i < 8; i += 1) {
    const mint = r.pubkey();
    const tokenAmount = r.u64();
    const wsolBasisLamports = r.u64();
    if (!mint.equals(PublicKey.default)) {
      positions.push({ mint, tokenAmount, wsolBasisLamports });
    }
  }
  // trailing [u8; 64] padding is intentionally not surfaced
  return {
    bump,
    name: decodeVaultName(nameBytes),
    nameBytes,
    creator,
    trader,
    operator,
    navKeeper,
    vaultType,
    status,
    frozenBy,
    perfFeeBps,
    platformProfitBps,
    redeemWindowSeconds,
    navStalenessSeconds,
    totalShares,
    seedShares,
    managerShares,
    navLamports,
    navSlot,
    navPostedAt,
    lockedProfit,
    lockedProfitTs,
    unlockPeriodSeconds,
    maxNavDeltaBps,
    maxTradeNotionalLamports,
    maxPriceImpactBps,
    dailyLossLimitBps,
    dailyLossAccumulator,
    dailyGainAccumulator,
    dayBucket,
    dayStartEquity,
    depositCooldownUntil,
    dailySwapSpendLamports,
    swapDayBucket,
    pendingWithdrawValueLamports,
    pendingWithdrawShares,
    platformFeesOwedLamports,
    enforceMintAllowlist,
    allowedMints,
    positions,
  };
}

export function decodeVaultDepositor(data: Buffer): VaultDepositorAccount {
  assertDiscriminator(data, "VaultDepositor");
  const r = new BorshReader(data);
  r.skip(8);
  return {
    bump: r.u8(),
    vault: r.pubkey(),
    authority: r.pubkey(),
    shares: r.u128(),
    netDepositsLamports: r.u64(),
    cumulativeProfitShareLamports: r.u64(),
    lastWithdrawRequest: {
      shares: r.u128(),
      valueAtRequestLamports: r.u64(),
      requestedAt: r.i64(),
    },
    lastDepositTs: r.i64(),
  };
}

// ── fetch + decode ─────────────────────────────────────────────────

function requireProgramOwned(info: AccountInfo<Buffer>, address: PublicKey): void {
  if (!info.owner.equals(VAULT_PROGRAM_ID)) {
    throw new Error(
      `${address.toBase58()} is owned by ${info.owner.toBase58()}, not the vault program ` +
        `${VAULT_PROGRAM_ID.toBase58()}`,
    );
  }
}

export interface FetchedVault {
  address: PublicKey;
  lamports: number;
  data: VaultAccount;
}

export async function fetchVaultAccount(
  connection: Connection,
  address: PublicKey,
): Promise<FetchedVault | null> {
  const info = await connection.getAccountInfo(address, "confirmed");
  if (!info) return null;
  requireProgramOwned(info, address);
  return { address, lamports: info.lamports, data: decodeVault(info.data) };
}

export interface FetchedVaultDepositor {
  address: PublicKey;
  lamports: number;
  data: VaultDepositorAccount;
}

export async function fetchVaultDepositorAccount(
  connection: Connection,
  address: PublicKey,
): Promise<FetchedVaultDepositor | null> {
  const info = await connection.getAccountInfo(address, "confirmed");
  if (!info) return null;
  requireProgramOwned(info, address);
  return { address, lamports: info.lamports, data: decodeVaultDepositor(info.data) };
}

export async function fetchPlatformConfigAccount(
  connection: Connection,
  address: PublicKey = platformConfigPda()[0],
): Promise<PlatformConfigAccount | null> {
  const info = await connection.getAccountInfo(address, "confirmed");
  if (!info) return null;
  requireProgramOwned(info, address);
  return decodePlatformConfig(info.data);
}

// ── share math (math.rs) — used to PREDICT what a deposit should mint
// so callers can assert the chain agreed, never to report a balance ──

/** floor(amount * (S + VIRTUAL_SHARES) / (E + VIRTUAL_LAMPORTS)) */
export function sharesForDeposit(
  amountLamports: bigint,
  totalShares: bigint,
  equityLamports: bigint,
): bigint {
  return (amountLamports * (totalShares + VIRTUAL_SHARES)) / (equityLamports + VIRTUAL_LAMPORTS);
}

/**
 * floor(shares * (E + VIRTUAL_LAMPORTS) / (S + VIRTUAL_SHARES))
 *
 * The exact inverse of sharesForDeposit, and math.rs's `value_for_shares`.
 * Used to QUOTE what a withdrawal is worth before anyone signs one; the
 * authoritative number is always what the program computes at execution.
 */
export function valueForShares(
  shares: bigint,
  totalShares: bigint,
  equityLamports: bigint,
): bigint {
  if (shares <= 0n) return 0n;
  return (shares * (equityLamports + VIRTUAL_LAMPORTS)) / (totalShares + VIRTUAL_SHARES);
}

/** ceil(locked * (period - elapsed) / period) — the Meteora drip. */
export function lockedProfitRemaining(
  lockedProfit: bigint,
  lastTs: bigint,
  unlockPeriod: bigint,
  now: bigint,
): bigint {
  if (unlockPeriod <= 0n || lockedProfit === 0n) return 0n;
  const elapsed = now - lastTs > 0n ? now - lastTs : 0n;
  if (elapsed >= unlockPeriod) return 0n;
  const remaining = unlockPeriod - elapsed;
  const num = lockedProfit * remaining;
  return (num + unlockPeriod - 1n) / unlockPeriod;
}

/** Posted NAV minus still-locked profit — the equity ALL pricing uses. */
export function effectiveEquity(v: VaultAccount, nowSec: bigint): bigint {
  const locked = lockedProfitRemaining(
    v.lockedProfit,
    v.lockedProfitTs,
    v.unlockPeriodSeconds,
    nowSec,
  );
  return v.navLamports > locked ? v.navLamports - locked : 0n;
}

// ── instruction builders ───────────────────────────────────────────
// Each one documents the account order it mirrors. Order is load-bearing.

export interface InitVaultParams {
  /** ≤ 32 utf8 bytes; becomes the PDA seed. */
  name: string;
  vaultType: VaultTypeName;
  /** [1000, 3000] at init; only ever decreasable afterwards. */
  perfFeeBps: number;
  redeemWindowSeconds: bigint;
  /** [60, 86400] */
  navStalenessSeconds: bigint;
  /** [0, 7 days] */
  unlockPeriodSeconds: bigint;
  /** [100, 5000] */
  maxNavDeltaBps: number;
  maxTradeNotionalLamports: bigint;
  maxPriceImpactBps: number;
  /** [0, 10000]; 0 disables the daily-loss breaker. */
  dailyLossLimitBps: number;
  navKeeper: PublicKey;
  /** ≥ MIN_SEED_LAMPORTS; burned (owned by nobody) forever. */
  seedLamports: bigint;
}

/** Client-side mirror of init_vault's `require!`s — fail before paying a fee. */
export function validateInitVaultParams(p: InitVaultParams): void {
  const bad = (m: string): never => {
    throw new Error(`init_vault: ${m}`);
  };
  encodeVaultName(p.name); // throws on >32 bytes / empty
  if (p.perfFeeBps < MIN_PERF_FEE_BPS_AT_INIT || p.perfFeeBps > MAX_PERF_FEE_BPS)
    bad(`perfFeeBps must be within [${MIN_PERF_FEE_BPS_AT_INIT}, ${MAX_PERF_FEE_BPS}]`);
  if (
    p.redeemWindowSeconds < BigInt(MIN_REDEEM_WINDOW_SECONDS) ||
    p.redeemWindowSeconds > BigInt(MAX_REDEEM_WINDOW_SECONDS)
  )
    bad(
      `redeemWindowSeconds must be within [${MIN_REDEEM_WINDOW_SECONDS}, ${MAX_REDEEM_WINDOW_SECONDS}]`,
    );
  if (
    p.navStalenessSeconds < BigInt(MIN_NAV_STALENESS_SECONDS) ||
    p.navStalenessSeconds > BigInt(MAX_NAV_STALENESS_SECONDS)
  )
    bad(
      `navStalenessSeconds must be within [${MIN_NAV_STALENESS_SECONDS}, ${MAX_NAV_STALENESS_SECONDS}]`,
    );
  if (
    p.unlockPeriodSeconds < BigInt(MIN_UNLOCK_PERIOD_SECONDS) ||
    p.unlockPeriodSeconds > BigInt(MAX_UNLOCK_PERIOD_SECONDS)
  )
    bad(
      `unlockPeriodSeconds must be within [${MIN_UNLOCK_PERIOD_SECONDS}, ${MAX_UNLOCK_PERIOD_SECONDS}]`,
    );
  if (p.maxNavDeltaBps < MIN_NAV_DELTA_BPS || p.maxNavDeltaBps > MAX_NAV_DELTA_BPS)
    bad(`maxNavDeltaBps must be within [${MIN_NAV_DELTA_BPS}, ${MAX_NAV_DELTA_BPS}]`);
  // Zero used to be legal and switched the breaker off entirely, with no
  // instruction anywhere to switch it back on.
  if (
    p.dailyLossLimitBps < MIN_DAILY_LOSS_LIMIT_BPS ||
    p.dailyLossLimitBps > MAX_DAILY_LOSS_LIMIT_BPS
  )
    bad(
      `dailyLossLimitBps must be within [${MIN_DAILY_LOSS_LIMIT_BPS}, ${MAX_DAILY_LOSS_LIMIT_BPS}]`,
    );
  // u64::MAX went straight to state with no validation, and it was this
  // platform's own default, so the per-trade notional cap capped nothing.
  if (
    p.maxTradeNotionalLamports <= 0n ||
    p.maxTradeNotionalLamports > MAX_TRADE_NOTIONAL_CEILING
  )
    bad(`maxTradeNotionalLamports must be within (0, ${MAX_TRADE_NOTIONAL_CEILING}]`);
  if (p.maxPriceImpactBps < 0 || p.maxPriceImpactBps > 10_000)
    bad("maxPriceImpactBps must be within [0, 10000]");
  if (p.navKeeper.equals(PublicKey.default)) bad("navKeeper must not be the default pubkey");
  if (p.seedLamports < MIN_SEED_LAMPORTS)
    bad(`seedLamports must be >= ${MIN_SEED_LAMPORTS} (0.01 SOL)`);
}

function encodeInitVaultParams(p: InitVaultParams): Buffer {
  // Field order = InitVaultParams declaration order (init_vault.rs).
  return new BorshWriter()
    .fixedBytes(encodeVaultName(p.name), 32)
    .u8(VAULT_TYPE[p.vaultType])
    .u16(p.perfFeeBps)
    .i64(p.redeemWindowSeconds)
    .i64(p.navStalenessSeconds)
    .i64(p.unlockPeriodSeconds)
    .u16(p.maxNavDeltaBps)
    .u64(p.maxTradeNotionalLamports)
    .u16(p.maxPriceImpactBps)
    .u16(p.dailyLossLimitBps)
    .pubkey(p.navKeeper)
    .u64(p.seedLamports)
    .toBuffer();
}

/**
 * init_vault — creator becomes the trader and burns the seed deposit.
 * Accounts (InitVault, in order):
 *   0 creator        signer, mut   pays rent + the burned seed
 *   1 vault          mut           init, PDA ["vault", creator, name]
 *   2 platform_config              PDA ["platform_config_v2"] (must exist)
 *   3 system_program
 */
export function buildInitVaultIx(params: {
  creator: PublicKey;
  vault: InitVaultParams;
  programId?: PublicKey;
}): { ix: TransactionInstruction; vault: PublicKey; bump: number } {
  const programId = params.programId ?? VAULT_PROGRAM_ID;
  validateInitVaultParams(params.vault);
  const [vault, bump] = vaultPda(params.creator, params.vault.name, programId);
  const [platformConfig] = platformConfigPda(programId);
  const data = Buffer.concat([
    ixDiscriminator("init_vault"),
    encodeInitVaultParams(params.vault),
  ]);
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.creator, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: platformConfig, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
  return { ix, vault, bump };
}

/**
 * init_depositor — creates the per-(vault, user) record. No args.
 * Accounts (InitDepositor, in order):
 *   0 authority      signer, mut   pays the record's rent
 *   1 vault                        NOT mut (read-only in this ix)
 *   2 depositor      mut           init, PDA ["vault_depositor", vault, authority]
 *   3 system_program
 */
export function buildInitDepositorIx(params: {
  authority: PublicKey;
  vault: PublicKey;
  programId?: PublicKey;
}): { ix: TransactionInstruction; depositor: PublicKey; bump: number } {
  const programId = params.programId ?? VAULT_PROGRAM_ID;
  const [depositor, bump] = vaultDepositorPda(params.vault, params.authority, programId);
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.authority, isSigner: true, isWritable: true },
      { pubkey: params.vault, isSigner: false, isWritable: false },
      { pubkey: depositor, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: ixDiscriminator("init_depositor"),
  });
  return { ix, depositor, bump };
}

/**
 * deposit — SOL in, shares out (priced BEFORE the lamports land).
 * Accounts (Deposit, in order):
 *   0 authority      signer, mut
 *   1 vault          mut
 *   2 depositor      mut
 *   3 system_program
 * Args: amount_lamports u64
 */
export function buildDepositIx(params: {
  authority: PublicKey;
  vault: PublicKey;
  amountLamports: bigint;
  programId?: PublicKey;
}): { ix: TransactionInstruction; depositor: PublicKey } {
  const programId = params.programId ?? VAULT_PROGRAM_ID;
  if (params.amountLamports < MIN_DEPOSIT_LAMPORTS) {
    throw new Error(`deposit: amountLamports must be >= ${MIN_DEPOSIT_LAMPORTS}`);
  }
  const [depositor] = vaultDepositorPda(params.vault, params.authority, programId);
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.authority, isSigner: true, isWritable: true },
      { pubkey: params.vault, isSigner: false, isWritable: true },
      { pubkey: depositor, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      ixDiscriminator("deposit"),
      new BorshWriter().u64(params.amountLamports).toBuffer(),
    ]),
  });
  return { ix, depositor };
}

/* ---------------------------------------------------------------------------
 * WITHDRAWALS
 *
 * None of these existed. The API could build a deposit and nothing else, so a
 * depositor's only exit was a raw RPC client and a hand-encoded instruction.
 * A vault you can pay into and not out of is not a vault, and no amount of
 * program-level correctness fixes that from the client side.
 *
 * All five are USER-SIGNED, exactly like deposit: the server builds unsigned
 * bytes whose `authority` is the depositor's own wallet, and only that wallet
 * can make them do anything.
 * ------------------------------------------------------------------------- */

/**
 * WithdrawRequestOp — shared by request_withdraw and cancel_withdraw_request.
 *   0 authority      signer
 *   1 vault          mut
 *   2 depositor      mut   PDA ["vault_depositor", vault, authority]
 */
function withdrawRequestOpKeys(
  authority: PublicKey,
  vault: PublicKey,
  depositor: PublicKey,
): AccountMeta[] {
  return [
    { pubkey: authority, isSigner: true, isWritable: false },
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: depositor, isSigner: false, isWritable: true },
  ];
}

/**
 * ExecuteWithdraw — shared by execute_withdraw, instant_withdraw and
 * emergency_withdraw.
 *   0 authority      signer, mut   receives the payout
 *   1 vault          mut
 *   2 depositor      mut
 *   3 trader         mut           pinned by `address = vault.trader`;
 *                                  receives the crystallized performance fee
 */
function executeWithdrawKeys(
  authority: PublicKey,
  vault: PublicKey,
  depositor: PublicKey,
  trader: PublicKey,
): AccountMeta[] {
  return [
    { pubkey: authority, isSigner: true, isWritable: true },
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: depositor, isSigner: false, isWritable: true },
    { pubkey: trader, isSigner: false, isWritable: true },
  ];
}

/**
 * request_withdraw — start the redeem window and reserve the value.
 * Args: shares u128
 *
 * The reservation is re-marked at check time now, so it falls with NAV
 * instead of freezing at the request-time figure. Cancel is never NAV-gated,
 * so a depositor is never stuck behind their own request.
 */
export function buildRequestWithdrawIx(params: {
  authority: PublicKey;
  vault: PublicKey;
  shares: bigint;
  programId?: PublicKey;
}): { ix: TransactionInstruction; depositor: PublicKey } {
  const programId = params.programId ?? VAULT_PROGRAM_ID;
  if (params.shares <= 0n) throw new Error("request_withdraw: shares must be > 0");
  const [depositor] = vaultDepositorPda(params.vault, params.authority, programId);
  const ix = new TransactionInstruction({
    programId,
    keys: withdrawRequestOpKeys(params.authority, params.vault, depositor),
    data: Buffer.concat([
      ixDiscriminator("request_withdraw"),
      new BorshWriter().u128(params.shares).toBuffer(),
    ]),
  });
  return { ix, depositor };
}

/** cancel_withdraw_request — release the reservation, keep the shares. No args. */
export function buildCancelWithdrawRequestIx(params: {
  authority: PublicKey;
  vault: PublicKey;
  programId?: PublicKey;
}): { ix: TransactionInstruction; depositor: PublicKey } {
  const programId = params.programId ?? VAULT_PROGRAM_ID;
  const [depositor] = vaultDepositorPda(params.vault, params.authority, programId);
  const ix = new TransactionInstruction({
    programId,
    keys: withdrawRequestOpKeys(params.authority, params.vault, depositor),
    data: ixDiscriminator("cancel_withdraw_request"),
  });
  return { ix, depositor };
}

/**
 * execute_withdraw — settle a matured request. No args (the request carries
 * the share count).
 *
 * Priced at EXECUTION, capped at the request-time value only when the vault
 * has genuinely gained since.
 */
export function buildExecuteWithdrawIx(params: {
  authority: PublicKey;
  vault: PublicKey;
  trader: PublicKey;
  programId?: PublicKey;
}): { ix: TransactionInstruction; depositor: PublicKey } {
  const programId = params.programId ?? VAULT_PROGRAM_ID;
  const [depositor] = vaultDepositorPda(params.vault, params.authority, programId);
  const ix = new TransactionInstruction({
    programId,
    keys: executeWithdrawKeys(params.authority, params.vault, depositor, params.trader),
    data: ixDiscriminator("execute_withdraw"),
  });
  return { ix, depositor };
}

/**
 * instant_withdraw — skip the redeem window when free SOL covers it.
 * Args: shares u128
 *
 * Two extra gates the caller should be told about BEFORE they sign: the mark
 * must be under INSTANT_WITHDRAW_MAX_NAV_STALENESS_SECONDS old, and the
 * depositor must be MIN_DEPOSIT_HOLD_SECONDS past their last deposit.
 */
export function buildInstantWithdrawIx(params: {
  authority: PublicKey;
  vault: PublicKey;
  trader: PublicKey;
  shares: bigint;
  programId?: PublicKey;
}): { ix: TransactionInstruction; depositor: PublicKey } {
  const programId = params.programId ?? VAULT_PROGRAM_ID;
  if (params.shares <= 0n) throw new Error("instant_withdraw: shares must be > 0");
  const [depositor] = vaultDepositorPda(params.vault, params.authority, programId);
  const ix = new TransactionInstruction({
    programId,
    keys: executeWithdrawKeys(params.authority, params.vault, depositor, params.trader),
    data: Buffer.concat([
      ixDiscriminator("instant_withdraw"),
      new BorshWriter().u128(params.shares).toBuffer(),
    ]),
  });
  return { ix, depositor };
}

/**
 * emergency_withdraw — the permissionless escape hatch.
 * Args: shares u128
 *
 * Opens when the keeper has been silent for NAV_EMERGENCY_GRACE_SECONDS, OR
 * when the caller's own request matured and still cannot be settled. Prices
 * off the last posted mark less EMERGENCY_HAIRCUT_BPS, and ignores other
 * depositors' reservations — a third party must not be able to hold the hatch
 * shut. Needs no keeper, no admin and no trader cooperation.
 */
export function buildEmergencyWithdrawIx(params: {
  authority: PublicKey;
  vault: PublicKey;
  trader: PublicKey;
  shares: bigint;
  programId?: PublicKey;
}): { ix: TransactionInstruction; depositor: PublicKey } {
  const programId = params.programId ?? VAULT_PROGRAM_ID;
  if (params.shares <= 0n) throw new Error("emergency_withdraw: shares must be > 0");
  const [depositor] = vaultDepositorPda(params.vault, params.authority, programId);
  const ix = new TransactionInstruction({
    programId,
    keys: executeWithdrawKeys(params.authority, params.vault, depositor, params.trader),
    data: Buffer.concat([
      ixDiscriminator("emergency_withdraw"),
      new BorshWriter().u128(params.shares).toBuffer(),
    ]),
  });
  return { ix, depositor };
}

/**
 * clear_expired_request — PERMISSIONLESS. Release the free-SOL reservation an
 * abandoned request is holding. Shares are untouched; the depositor may
 * request again immediately.
 *   0 cranker        signer   anyone; pays the fee, gains nothing
 *   1 vault          mut
 *   2 depositor      mut      seeded on the DEPOSITOR's authority, not the
 *                             signer's — a third party signing a context
 *                             seeded on themselves could never reach the
 *                             abandoned account.
 */
export function buildClearExpiredRequestIx(params: {
  cranker: PublicKey;
  vault: PublicKey;
  depositorAuthority: PublicKey;
  programId?: PublicKey;
}): { ix: TransactionInstruction; depositor: PublicKey } {
  const programId = params.programId ?? VAULT_PROGRAM_ID;
  const [depositor] = vaultDepositorPda(params.vault, params.depositorAuthority, programId);
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.cranker, isSigner: true, isWritable: false },
      { pubkey: params.vault, isSigner: false, isWritable: true },
      { pubkey: depositor, isSigner: false, isWritable: true },
    ],
    data: ixDiscriminator("clear_expired_request"),
  });
  return { ix, depositor };
}

/**
 * post_nav — the keeper's mark.
 * Accounts (PostNav, in order — vault FIRST so the keeper's `address =
 * vault.nav_keeper` constraint can look "up" the struct):
 *   0 vault          mut
 *   1 keeper         signer        (declared without `mut`; being the fee
 *                                   payer anyway is fine — Anchor only
 *                                   enforces mut when it is declared)
 * Args: nav_lamports u64, mark_slot u64
 *
 * mark_slot must satisfy: > vault.nav_slot, <= clock.slot, and
 * clock.slot - mark_slot <= 750. Read the slot at CONFIRMED commitment:
 * a processed-commitment slot can be ahead of the slot the transaction
 * actually executes at, which reverts as NavSlotNotMonotonic.
 */
export function buildPostNavIx(params: {
  vault: PublicKey;
  keeper: PublicKey;
  navLamports: bigint;
  markSlot: bigint;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = params.programId ?? VAULT_PROGRAM_ID;
  if (params.navLamports > MAX_NAV_LAMPORTS) {
    throw new Error(`post_nav: navLamports exceeds MAX_NAV_LAMPORTS (${MAX_NAV_LAMPORTS})`);
  }
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.vault, isSigner: false, isWritable: true },
      { pubkey: params.keeper, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([
      ixDiscriminator("post_nav"),
      new BorshWriter().u64(params.navLamports).u64(params.markSlot).toBuffer(),
    ]),
  });
}

/**
 * A Jupiter instruction as `/swap-instructions` returns it.
 *
 * Accounts carry `isSigner` and `isWritable` exactly as Jupiter computed them,
 * and BOTH must survive into remaining_accounts: the program copies
 * `is_writable` verbatim and only re-derives `is_signer` for the vault PDA
 * (execute_swap.rs, the metas loop). Marking the route read-only — which the
 * previous builder did — makes the CPI fail on every writable pool account.
 */
export interface JupiterInstruction {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  /** base64 */
  data: string;
}

/**
 * execute_swap — a Jupiter-v6-pinned swap between two vault-owned token
 * accounts, signed by the vault PDA inside the program.
 *
 * REWRITTEN. The previous version of this function did not match the deployed
 * program in any respect and had never executed:
 *   · it omitted `platform_config` entirely and invented three accounts the
 *     struct does not have (token_program, system_program, a third wSOL ATA)
 *     — and that third ATA would have landed in remaining_accounts and been
 *     rejected outright by the program's third-vault-ATA scan;
 *   · it encoded `max_in, min_out, vec<instruction>, vec<pubkey>` when the
 *     program takes `data: Vec<u8>, max_in: u64, min_out: u64`;
 *   · it read `programIdIndex` / `accountKeyIndexes` off Jupiter's response
 *     objects, which have neither, so it threw a TypeError before a
 *     transaction was even built;
 *   · it marked every route account read-only and non-signer;
 *   · and its only caller passed the vault PDA as `authority`, which has no
 *     private key and is not a trade authority anyway.
 *
 * Accounts (ExecuteSwap, in declaration order):
 *   0 authority        signer   the vault's trader or operator
 *   1 vault            mut
 *   2 platform_config           PDA [PLATFORM_CONFIG_SEED] — the kill switch
 *   3 jupiter_program           pinned to Jupiter v6
 *   4 source_token     mut      vault-owned, the leg being spent
 *   5 dest_token       mut      vault-owned, the leg being received
 *   6+ remaining_accounts       Jupiter's COMPLETE account list, in order,
 *                               with its own writability preserved
 *
 * Args: data (raw Jupiter instruction bytes), max_in, min_out.
 */
export function buildExecuteSwapIx(params: {
  /** must equal the vault's on-chain `trader` or `operator` */
  authority: PublicKey;
  vault: PublicKey;
  /** the vault-owned token account being SPENT */
  sourceToken: PublicKey;
  /** the vault-owned token account being RECEIVED into */
  destToken: PublicKey;
  /** Jupiter's swap instruction, verbatim from /swap-instructions */
  swapInstruction: JupiterInstruction;
  maxIn: bigint;
  minOut: bigint;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = params.programId ?? VAULT_PROGRAM_ID;
  if (params.maxIn <= 0n) throw new Error("execute_swap: maxIn must be > 0");
  if (params.minOut <= 0n) throw new Error("execute_swap: minOut must be > 0");

  const jupiterProgram = new PublicKey(params.swapInstruction.programId);
  if (!jupiterProgram.equals(JUPITER_ROUTER_V6)) {
    // The program pins this too; failing here says why, with both addresses.
    throw new Error(
      `execute_swap: route targets ${jupiterProgram.toBase58()}, but the program ` +
        `only ever CPIs to Jupiter v6 (${JUPITER_ROUTER_V6.toBase58()})`,
    );
  }

  const [platformConfig] = platformConfigPda(programId);

  const keys: AccountMeta[] = [
    { pubkey: params.authority, isSigner: true, isWritable: false },
    { pubkey: params.vault, isSigner: false, isWritable: true },
    { pubkey: platformConfig, isSigner: false, isWritable: false },
    { pubkey: JUPITER_ROUTER_V6, isSigner: false, isWritable: false },
    { pubkey: params.sourceToken, isSigner: false, isWritable: true },
    { pubkey: params.destToken, isSigner: false, isWritable: true },
  ];

  // Jupiter's account list, verbatim. The vault PDA appears in it as Jupiter's
  // user-transfer-authority; it is passed with is_signer FALSE because the
  // outer transaction cannot mark a PDA as a signer — the program flips it on
  // for the invoke_signed.
  for (const a of params.swapInstruction.accounts) {
    const pubkey = new PublicKey(a.pubkey);
    keys.push({
      pubkey,
      isSigner: pubkey.equals(params.vault) ? false : a.isSigner,
      isWritable: a.isWritable,
    });
  }

  const data = Buffer.concat([
    ixDiscriminator("execute_swap"),
    // BorshWriter.bytes emits the u32 length prefix a Vec<u8> needs.
    new BorshWriter()
      .bytes(Buffer.from(params.swapInstruction.data, "base64"))
      .u64(params.maxIn)
      .u64(params.minOut)
      .toBuffer(),
  ]);

  return new TransactionInstruction({ programId, keys, data });
}

/**
 * close_depositor — reclaim the rent of an emptied depositor record.
 *
 * Accounts (CloseDepositor): authority(signer, mut, receives the rent),
 * vault, depositor(mut, close = authority). No args. The program requires
 * `shares == 0` and no pending request, so this can never abandon a position.
 * It moves only the depositor record's OWN rent, never vault funds.
 */
export function buildCloseDepositorIx(params: {
  authority: PublicKey;
  vault: PublicKey;
  programId?: PublicKey;
}): { ix: TransactionInstruction; depositor: PublicKey } {
  const programId = params.programId ?? VAULT_PROGRAM_ID;
  const [depositor] = vaultDepositorPda(params.vault, params.authority, programId);
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.authority, isSigner: true, isWritable: true },
      { pubkey: params.vault, isSigner: false, isWritable: false },
      { pubkey: depositor, isSigner: false, isWritable: true },
    ],
    data: ixDiscriminator("close_depositor"),
  });
  return { ix, depositor };
}

/**
 * wrap_sol — vault SOL into the vault's wSOL account, the trading float.
 *
 * Accounts (WrapSol): authority(signer), vault(mut), platform_config,
 * wsol_account(mut, vault-owned), token_program.
 * Args: amount_lamports u64.
 *
 * TWO THINGS THE CALLER MUST DO AROUND THIS:
 *   · PREPEND createAssociatedTokenAccountIdempotent — the vault program never
 *     creates the ATA; the Associated Token program does, permissionlessly.
 *   · APPEND SyncNative — the program moves lamports and stops there. It used
 *     to CPI sync_native itself, and that never worked: the runtime verifies
 *     the caller's account changes before executing a CPI, and a direct
 *     lamport credit into a Token-program-owned account does not survive it.
 *
 * There was no builder for wrap_sol at all, which is why a vault could never
 * have a source token account to swap from.
 */
export function buildWrapSolIx(params: {
  authority: PublicKey;
  vault: PublicKey;
  amountLamports: bigint;
  programId?: PublicKey;
}): { ix: TransactionInstruction; wsolAccount: PublicKey } {
  const programId = params.programId ?? VAULT_PROGRAM_ID;
  if (params.amountLamports <= 0n) throw new Error("wrap_sol: amount must be > 0");
  const [platformConfig] = platformConfigPda(programId);
  const wsolAccount = getAssociatedTokenAddressSync(WSOL_MINT, params.vault, true);
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.authority, isSigner: true, isWritable: false },
      { pubkey: params.vault, isSigner: false, isWritable: true },
      { pubkey: platformConfig, isSigner: false, isWritable: false },
      { pubkey: wsolAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      ixDiscriminator("wrap_sol"),
      new BorshWriter().u64(params.amountLamports).toBuffer(),
    ]),
  });
  return { ix, wsolAccount };
}

/**
 * unwrap_sol — close the vault's wSOL account back into vault SOL.
 *
 * Accounts (UnwrapSol): authority(signer), vault(mut), wsol_account(mut),
 * token_program. No args. Deliberately not status-gated in the program:
 * returning float to the withdrawal buffer must work on a frozen vault too.
 */
export function buildUnwrapSolIx(params: {
  authority: PublicKey;
  vault: PublicKey;
  programId?: PublicKey;
}): { ix: TransactionInstruction; wsolAccount: PublicKey } {
  const programId = params.programId ?? VAULT_PROGRAM_ID;
  const wsolAccount = getAssociatedTokenAddressSync(WSOL_MINT, params.vault, true);
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.authority, isSigner: true, isWritable: false },
      { pubkey: params.vault, isSigner: false, isWritable: true },
      { pubkey: wsolAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: ixDiscriminator("unwrap_sol"),
  });
  return { ix, wsolAccount };
}

/** The vault-owned associated token account for a mint. */
export function vaultTokenAccount(vault: PublicKey, mint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, vault, true);
}

// ── presentation helpers ───────────────────────────────────────────

export const lamportsToSol = (l: bigint): number => Number(l) / 1e9;
export const solToLamports = (sol: number): bigint =>
  BigInt(Math.round(sol * Number(LAMPORTS_PER_SOL)));

/** Cluster-aware explorer links (devnet needs the ?cluster= suffix). */
export function explorerTx(signature: string): string {
  const q = env.solanaCluster === "mainnet-beta" ? "" : `?cluster=${env.solanaCluster}`;
  return `https://explorer.solana.com/tx/${signature}${q}`;
}
export function explorerAddress(address: string): string {
  const q = env.solanaCluster === "mainnet-beta" ? "" : `?cluster=${env.solanaCluster}`;
  return `https://explorer.solana.com/address/${address}${q}`;
}

/**
 * JSON-safe view of a decoded Vault. BigInt does not survive
 * JSON.stringify (it throws), so every 64/128-bit field is emitted as a
 * decimal STRING and the SOL-denominated conveniences as numbers.
 */
export function vaultAccountToJson(v: VaultAccount, lamports?: number): Record<string, unknown> {
  return {
    name: v.name,
    bump: v.bump,
    trader: v.trader.toBase58(),
    operator: v.operator.equals(PublicKey.default) ? null : v.operator.toBase58(),
    navKeeper: v.navKeeper.toBase58(),
    vaultType: v.vaultType,
    status: v.status,
    frozenBy: v.frozenBy,
    perfFeeBps: v.perfFeeBps,
    platformProfitBps: v.platformProfitBps,
    redeemWindowSeconds: Number(v.redeemWindowSeconds),
    navStalenessSeconds: Number(v.navStalenessSeconds),
    totalShares: v.totalShares.toString(),
    seedShares: v.seedShares.toString(),
    managerShares: v.managerShares.toString(),
    navLamports: v.navLamports.toString(),
    navSol: lamportsToSol(v.navLamports),
    navSlot: v.navSlot.toString(),
    navPostedAt: Number(v.navPostedAt),
    lockedProfit: v.lockedProfit.toString(),
    lockedProfitTs: Number(v.lockedProfitTs),
    unlockPeriodSeconds: Number(v.unlockPeriodSeconds),
    maxNavDeltaBps: v.maxNavDeltaBps,
    maxTradeNotionalLamports: v.maxTradeNotionalLamports.toString(),
    maxPriceImpactBps: v.maxPriceImpactBps,
    dailyLossLimitBps: v.dailyLossLimitBps,
    dailyLossAccumulator: v.dailyLossAccumulator.toString(),
    dayBucket: Number(v.dayBucket),
    dayStartEquity: v.dayStartEquity.toString(),
    pendingWithdrawValueLamports: v.pendingWithdrawValueLamports.toString(),
    pendingWithdrawShares: v.pendingWithdrawShares.toString(),
    platformFeesOwedLamports: v.platformFeesOwedLamports.toString(),
    enforceMintAllowlist: v.enforceMintAllowlist,
    allowedMints: v.allowedMints
      .filter((m) => !m.equals(PublicKey.default))
      .map((m) => m.toBase58()),
    ...(lamports === undefined
      ? {}
      : { accountLamports: String(lamports), accountSol: lamports / 1e9 }),
  };
}

/** JSON-safe view of a decoded VaultDepositor (same BigInt rule). */
export function vaultDepositorToJson(
  d: VaultDepositorAccount,
  lamports?: number,
): Record<string, unknown> {
  return {
    vault: d.vault.toBase58(),
    authority: d.authority.toBase58(),
    shares: d.shares.toString(),
    netDepositsLamports: d.netDepositsLamports.toString(),
    netDepositsSol: lamportsToSol(d.netDepositsLamports),
    cumulativeProfitShareLamports: d.cumulativeProfitShareLamports.toString(),
    pendingWithdraw:
      d.lastWithdrawRequest.shares === 0n
        ? null
        : {
            shares: d.lastWithdrawRequest.shares.toString(),
            valueAtRequestLamports: d.lastWithdrawRequest.valueAtRequestLamports.toString(),
            requestedAt: Number(d.lastWithdrawRequest.requestedAt),
          },
    ...(lamports === undefined ? {} : { accountLamports: String(lamports) }),
  };
}

// ── program EVENTS (appended) ──────────────────────────────────────
// Anchor emits events as a base64 blob on a `Program data: <b64>` log
// line, prefixed with sha256("event:<Struct>")[0..8]. Reading the event
// is the only way to learn how many shares a deposit minted from the
// transaction ALONE — before/after account diffing needs a snapshot
// taken at the right slot, which a confirmation arriving later cannot
// reconstruct. Used by the deposit-confirm route to record the exact
// mint against a signature it has already verified on chain.

/** Anchor event discriminator: sha256("event:<Struct>")[0..8]. */
export function eventDiscriminator(structName: string): Buffer {
  return sha256(`event:${structName}`).subarray(0, 8);
}

export interface DepositedEvent {
  vault: PublicKey;
  depositor: PublicKey;
  amountLamports: bigint;
  sharesMinted: bigint;
  totalShares: bigint;
  navLamports: bigint;
}

/** Decode a `Deposited` event body (state.rs field order). */
export function decodeDepositedEvent(data: Buffer): DepositedEvent {
  const want = eventDiscriminator("Deposited");
  if (!data.subarray(0, 8).equals(want)) throw new Error("not a Deposited event");
  const r = new BorshReader(data);
  r.skip(8);
  return {
    vault: r.pubkey(),
    depositor: r.pubkey(),
    amountLamports: r.u64(),
    sharesMinted: r.u128(),
    totalShares: r.u128(),
    navLamports: r.u64(),
  };
}

/**
 * Scan transaction log lines for the FIRST `Deposited` event emitted for
 * `vault` by `depositor`. Returns null when the transaction carries none
 * (so callers can say "this signature is not a deposit into this vault"
 * instead of inventing a number).
 */
export function findDepositedEvent(
  logs: readonly string[],
  vault: PublicKey,
  depositor: PublicKey,
): DepositedEvent | null {
  for (const line of logs) {
    const m = /^Program data: (.+)$/.exec(line.trim());
    if (!m?.[1]) continue;
    let decoded: DepositedEvent;
    try {
      decoded = decodeDepositedEvent(Buffer.from(m[1], "base64"));
    } catch {
      continue; // some other event, or not an event at all
    }
    if (decoded.vault.equals(vault) && decoded.depositor.equals(depositor)) return decoded;
  }
  return null;
}
