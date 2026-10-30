// ── Trader Vaults shared types ─────────────────────────────────────────────
// One source of truth for web + api + engines (the PaperApe pattern).
// All money amounts are SOL-denominated numbers at the API boundary;
// on-chain code uses lamports (bigint) — convert at the edge only.

export type VaultType = "managed" | "mirror";
export type VaultStatus = "active" | "frozen" | "closed";
/**
 * The hard wall: "real" vaults hold real SOL and only ever execute
 * on-chain (blocked until the program is deployed — never simulated).
 * "paper" vaults live in the ledger sandbox, clearly labeled, and their
 * records feed the SEPARATE paper column of trader profiles.
 */
export type VaultMode = "real" | "paper";
export type TradeSide = "buy" | "sell";
export type WithdrawStatus = "pending" | "executable" | "paid" | "cancelled";

// ── Fee split at profit crystallization (basis points of profit) ────
// 70% depositor / 30% trader. There is NO platform cut: the 10 points
// that used to fund the buyback now belong to the trader, time-locked.
//
// THE RULE (one rule, no special cases): the creator picks a total
// performance fee inside [PERF_FEE_MIN_BPS, PERF_FEE_MAX_BPS]. Exactly
// ONE THIRD of whatever they picked is routed to the platform-controlled
// escrow wallet and locked for VEST_LOCK_DAYS; the other two thirds are
// paid to the trader immediately, as before. At the 30% default that is
// the headline split — 20 points now, 10 points vested for 60 days.
//
// WHY: it aligns traders long-term. A trader who blows up or disappears
// cannot walk away with their whole fee the same day they earned it.
//
// The depositor's side is UNAFFECTED by the vesting split: they always
// pay exactly perfFeeBps of profit, whatever the trader does with it.
export const PERF_FEE_DEFAULT_BPS = 3000;
export const PERF_FEE_MIN_BPS = 1000;
export const PERF_FEE_MAX_BPS = 3000;
/** Denominator of the vested share of the performance fee (1/3 vests). */
export const PERF_FEE_VEST_DIVISOR = 3;
/** Escrow lock length. Bookkeeping clock, not a program clock — see FeeBreakdown. */
export const VEST_LOCK_DAYS = 60;
export const VEST_LOCK_SECONDS = VEST_LOCK_DAYS * 86_400;

/**
 * Split a total performance fee into the part paid now and the part that
 * goes to escrow. The two ALWAYS sum back to `perfFeeBps` exactly, so no
 * rounding can leak value into or out of the depositor's payout.
 */
export function splitPerfFeeBps(perfFeeBps: number): {
  immediateBps: number;
  vestedBps: number;
} {
  const vestedBps = Math.round(perfFeeBps / PERF_FEE_VEST_DIVISOR);
  return { immediateBps: perfFeeBps - vestedBps, vestedBps };
}
// Swap fee on vault trades (SOL leg, Jupiter Router platformFeeBps).
export const VAULT_SWAP_FEE_BPS = 20;
// Terminal (personal, non-vault) swap fee — market standard headline.
export const TERMINAL_SWAP_FEE_BPS = 100;

export const LAMPORTS_PER_SOL = 1_000_000_000;

export interface TraderStats {
  winRatePct: number;
  pnlSol: number;
  trades: number;
  profitFactor?: number;
  avgHoldMin?: number;
}

export interface TraderProfile {
  id: string;
  handle: string;
  displayName: string;
  xHandle?: string;
  avatarUrl?: string;
  xVerified: boolean;
  bio?: string;
  /** Recomputed from chain data by our pipeline — never self-reported. */
  onchainStats: TraderStats;
  /** Optional PaperApe import. ALWAYS rendered separately from live stats. */
  paperStats?: TraderStats;
}

export interface EquityPoint {
  /** unix seconds */
  t: number;
  /** vault equity in SOL (or share price ×1000 for normalized curves) */
  v: number;
}

export interface VaultStats {
  pnlPct7d: number;
  pnlPct30d: number;
  pnlPctAll: number;
  maxDrawdownPct: number;
  winRatePct: number;
  tradesCount: number;
  depositorCount: number;
  ageDays: number;
  /** mirror vaults only: median copy lag vs leader, in slots */
  medianCopyLagSlots?: number;
}

export interface Vault {
  id: string;
  name: string;
  type: VaultType;
  mode: VaultMode;
  status: VaultStatus;
  trader: TraderProfile;
  /** mirror vaults: the leader wallet being copied */
  leaderWallet?: string;
  createdAt: number;
  tvlSol: number;
  sharePriceSol: number;
  totalShares: number;
  managerStakeSol: number;
  managerStakePct: number;
  perfFeeBps: number;
  redeemWindowHours: number;
  /** SOL held unallocated — instant withdrawals draw from this */
  solBufferSol: number;
  /** crystallized on exits, held outside tvl: trader perf fees paid immediately */
  traderFeesAccruedSol: number;
  /**
   * crystallized on exits and routed to the escrow wallet: the trader's
   * vested fee, locked VEST_LOCK_DAYS before they can claim it. Owed to
   * the TRADER, not the platform — the platform takes no cut.
   */
  vestedFeesAccruedSol: number;
  thesis?: string;
  stats: VaultStats;
  equityCurve: EquityPoint[];
}

export interface Position {
  id: string;
  vaultId: string;
  mint: string;
  symbol: string;
  name?: string;
  amountTokens: number;
  costSol: number;
  valueSol: number;
  pnlSol: number;
  pnlPct: number;
  /** stale marks are labeled, never hidden */
  markStale: boolean;
  updatedAt: number;
}

/** One UTC day of realized pnl. Days with no closed trade are absent, not zero. */
export interface PnlDay {
  /** YYYY-MM-DD, UTC */
  date: string;
  realizedSol: number;
  /** sells that closed against a recorded entry */
  trades: number;
  wins: number;
}

export interface Trade {
  id: string;
  vaultId: string;
  ts: number;
  side: TradeSide;
  mint: string;
  symbol: string;
  solAmount: number;
  tokenAmount: number;
  priceSol: number;
  txSig: string;
  source: VaultType;
  /** mirror trades: landed slot − leader slot (public metric) */
  copyLagSlots?: number;
}

export interface WithdrawRequest {
  id: string;
  vaultId: string;
  userId: string;
  shares: number;
  valueAtRequestSol: number;
  requestedAt: number;
  executableAt: number;
  status: WithdrawStatus;
}

/**
 * Fee crystallization on exit (the 70/30 money flow). Profit is
 * per-portion: gross proceeds minus the proportional cost basis of the
 * shares being burned. No profit → no fees, ever.
 *
 * The depositor only ever sees `perfFeeSol` leave: paidSol is exactly
 * `grossSol − perfFeeSol`. How the trader's side is split between cash
 * now and escrow is invisible to them, by design.
 */
export interface FeeBreakdown {
  grossSol: number;
  costBasisSol: number;
  profitSol: number;
  /** total performance fee charged: traderFeeSol + traderVestedSol */
  perfFeeSol: number;
  /** paid to the trader immediately (two thirds of perfFeeSol) */
  traderFeeSol: number;
  /** routed to the escrow wallet, claimable after VEST_LOCK_DAYS */
  traderVestedSol: number;
  paidSol: number;
}

// ── vested (escrowed) trader fees ──────────────────────────────────

/** A tranche flips locked → claimable purely by time; no cron involved. */
export type VestedFeeStatus = "locked" | "claimable" | "claimed";

export interface VestedFeeTranche {
  id: string;
  vaultId: string;
  vaultName: string;
  traderId: string;
  amountSol: number;
  /** unix seconds */
  crystallizedAt: number;
  /** unix seconds — crystallizedAt + VEST_LOCK_SECONDS */
  unlocksAt: number;
  status: VestedFeeStatus;
  claimedAt?: number;
  claimSig?: string;
  /** escrow wallet this tranche is booked against */
  escrowWallet?: string;
}

export interface VestedFeeSummary {
  traderId: string;
  /** the platform-controlled escrow destination (null when unconfigured) */
  escrowWallet: string | null;
  lockedSol: number;
  claimableSol: number;
  claimedSol: number;
  /** unix seconds of the soonest still-locked unlock, null when none */
  nextUnlockAt: number | null;
  tranches: VestedFeeTranche[];
}

export interface Holding {
  vaultId: string;
  vaultName: string;
  vaultType: VaultType;
  shares: number;
  valueSol: number;
  costSol: number;
  pnlSol: number;
  pnlPct: number;
}

export interface TrackedWallet {
  address: string;
  label?: string;
  stats: TraderStats;
  lastActiveAt: number;
  /** already leads a mirror vault on the platform */
  isVaultLeader: boolean;
  vaultId?: string;
  /** real chain scan state: ok = full scan, partial = rate-limited, unscanned = never scanned */
  scanStatus?: "ok" | "partial" | "unscanned";
  scannedAt?: number;
  /** most recent classified swaps from the scan */
  recentSwaps?: WalletSwap[];
}

export interface WalletSwap {
  ts: number;
  side: TradeSide;
  mint: string;
  symbol?: string;
  solAmount: number;
  txSig: string;
}

export type ActivityKind =
  | "trade"
  | "deposit"
  | "withdraw_request"
  | "withdraw_paid"
  | "order_fill"
  | "vault_created";

export interface ActivityEvent {
  id: string;
  ts: number;
  kind: ActivityKind;
  vaultId?: string;
  vaultName?: string;
  /** pre-rendered wire line, e.g. "WAGYU PRIME bought 5.0 SOL of BONK" */
  text: string;
  solAmount?: number;
  side?: TradeSide;
}

export interface PoolTrade {
  ts: number;
  side: TradeSide;
  priceUsd: number;
  amountUsd: number;
  amountToken: number;
  txSig: string;
  wallet: string;
}

export interface PlatformMeta {
  solPriceUsd: number;
  tvlSol: number;
  vaults: number;
  apiTime: number;
}

// ── pulse (lifecycle discovery board) ──────────────────────────────

export interface PulseCard {
  mint: string;
  symbol: string;
  name: string;
  imageUrl?: string;
  /** seconds since pool/token creation */
  ageSec?: number;
  priceUsd?: number;
  mcapUsd?: number;
  liquidityUsd?: number;
  volume24hUsd?: number;
  change5mPct?: number;
  txns5m?: { buys: number; sells: number };
  /** bonding-curve progress 0-100 when known (pump.fun phase) */
  bondingPct?: number;
  pairAddress?: string;
  source: "pumpfun" | "geckoterminal";
}

export type PulseColumnId = "new" | "graduating" | "migrated";

export interface PulseBoard {
  columns: { id: PulseColumnId; title: string; cards: PulseCard[] }[];
  fetchedAt: number;
}

export interface TokenPoolStats {
  mint: string;
  pool: string | null;
  priceChangePct: { m5?: number; h1?: number; h6?: number; h24?: number };
  txns: {
    m5?: { buys: number; sells: number };
    h1?: { buys: number; sells: number };
    h24?: { buys: number; sells: number };
  };
  volumeUsd: { m5?: number; h1?: number; h24?: number };
  fetchedAt: number;
}

/** $0.0₅4451-style notation for microcap prices. */
export function fmtSubscriptPrice(v: number): string {
  if (v <= 0 || !Number.isFinite(v)) return "$0";
  if (v >= 0.001) return fmtUsd(v);
  const s = v.toFixed(20).replace(/0+$/, "");
  const m = /^0\.(0+)(\d+)/.exec(s);
  if (!m) return fmtUsd(v);
  const zeros = m[1]!.length;
  const digits = m[2]!.slice(0, 4);
  const SUB = "₀₁₂₃₄₅₆₇₈₉";
  const sub = String(zeros)
    .split("")
    .map((c) => SUB[Number(c)])
    .join("");
  return `$0.0${sub}${digits}`;
}

export interface TokenRisk {
  mintAuthorityRevoked?: boolean;
  lpBurnedPct?: number;
  top10HolderPct?: number;
  devHoldingPct?: number;
}

export interface TokenInfo {
  mint: string;
  symbol: string;
  name: string;
  priceUsd: number;
  priceSol: number;
  mcapUsd?: number;
  liquidityUsd?: number;
  change24hPct?: number;
  volume24hUsd?: number;
  imageUrl?: string;
  dex?: string;
  pairAddress?: string;
  risk?: TokenRisk;
  /** which oracle tier produced this mark */
  source: "jupiter" | "birdeye" | "pumpfun" | "dexscreener" | "stale" | "none";
  fetchedAt: number;
}

// ── terminal execution & orders ────────────────────────────────────

export interface Candle {
  /** unix seconds, bucket start */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
}

export type OrderKind = "take_profit" | "stop_loss" | "limit_buy_dip" | "limit_buy_breakout";
export type OrderStatus = "open" | "filled" | "cancelled" | "failed";

export interface Order {
  id: string;
  vaultId: string;
  mint: string;
  symbol: string;
  kind: OrderKind;
  /** trigger on last-trade USD price */
  triggerPriceUsd: number;
  /** buys: SOL to spend. sells (tp/sl): fraction of position 0-1 */
  amountSol?: number;
  sellFraction?: number;
  status: OrderStatus;
  createdAt: number;
  filledAt?: number;
  filledTradeId?: string;
  /** set when status = failed */
  failReason?: string;
}

export interface TradeResult {
  trade: Trade;
  position: Position | null;
  vault: Vault;
}

export interface TokenSearchResult {
  mint: string;
  symbol: string;
  name: string;
  priceUsd: number;
  mcapUsd?: number;
  liquidityUsd?: number;
  imageUrl?: string;
}

export interface TrendingToken extends TokenSearchResult {
  change24hPct?: number;
  volume24hUsd?: number;
}

// ── helpers ────────────────────────────────────────────────────────

export function lamportsToSol(lamports: number | bigint): number {
  return Number(lamports) / LAMPORTS_PER_SOL;
}

export function shortAddr(addr: string, chars = 4): string {
  if (addr.length <= chars * 2 + 1) return addr;
  return `${addr.slice(0, chars)}…${addr.slice(-chars)}`;
}

export function fmtSol(v: number, digits = 2): string {
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k`;
  if (Math.abs(v) < 0.01 && v !== 0) return v.toFixed(4);
  return v.toFixed(digits);
}

export function fmtPct(v: number, digits = 1): string {
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(digits)}%`;
}

export function fmtUsd(v: number): string {
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toPrecision(3)}`;
}

export function solscanTx(sig: string): string {
  return `https://solscan.io/tx/${sig}`;
}

export function solscanAccount(addr: string): string {
  return `https://solscan.io/account/${addr}`;
}
