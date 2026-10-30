import type {
  ActivityEvent,
  Candle,
  FeeBreakdown,
  Holding,
  Order,
  OrderKind,
  PlatformMeta,
  PnlDay,
  PoolTrade,
  Position,
  PulseBoard,
  TokenPoolStats,
  TokenInfo,
  TokenSearchResult,
  TrackedWallet,
  Trade,
  TradeResult,
  TrendingToken,
  Vault,
  VestedFeeSummary,
  VestedFeeTranche,
  WithdrawRequest,
} from "@trader-vaults/shared";

const BASE = "/api";

// ── Request cache with TTL ───────────────────────────────────────────
interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

const requestCache = new Map<string, CacheEntry<unknown>>();

function getCacheKey(url: string, body?: unknown): string {
  return body ? `${url}:${JSON.stringify(body)}` : url;
}

function getCached<T>(key: string): T | null {
  const entry = requestCache.get(key);
  if (!entry) return null;
  
  const now = Date.now();
  if (now - entry.timestamp > entry.ttl) {
    requestCache.delete(key);
    return null;
  }
  
  return entry.data as T;
}

function setCached<T>(key: string, data: T, ttl: number): void {
  requestCache.set(key, {
    data,
    timestamp: Date.now(),
    ttl,
  });
}

// ── Request deduplication ───────────────────────────────────────────
const pendingRequests = new Map<string, Promise<unknown>>();

async function deduplicatedRequest<T>(
  key: string,
  requestFn: () => Promise<T>
): Promise<T> {
  const existing = pendingRequests.get(key);
  if (existing) {
    return existing as Promise<T>;
  }
  
  const promise = requestFn().finally(() => {
    pendingRequests.delete(key);
  });
  
  pendingRequests.set(key, promise);
  return promise;
}

// ── Cache TTL constants (milliseconds) ──────────────────────────────
const CACHE_TTL = {
  SHORT: 30_000,      // 30 seconds
  MEDIUM: 300_000,    // 5 minutes
  LONG: 600_000,      // 10 minutes
  VERY_LONG: 3600000, // 1 hour
} as const;

/**
 * An API failure that keeps the server's machine-readable `code` and the
 * rest of the JSON body.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly body: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>, fallback: string) {
    super(typeof body.error === "string" && body.error ? body.error : fallback);
    this.name = "ApiError";
    this.status = status;
    this.code = typeof body.code === "string" ? body.code : null;
    this.body = body;
  }
}

async function get<T>(
  path: string,
  options: { cache?: boolean; ttl?: number } = {}
): Promise<T> {
  const cacheKey = getCacheKey(path);
  const { cache = true, ttl = CACHE_TTL.MEDIUM } = options;
  
  if (cache) {
    const cached = getCached<T>(cacheKey);
    if (cached) return cached;
  }
  
  const result = deduplicatedRequest(cacheKey, async () => {
    const res = await fetch(`${BASE}${path}`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
    return res.json() as Promise<T>;
  });
  
  const data = await result;
  
  if (cache) {
    setCached(cacheKey, data, ttl);
  }
  
  return data;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const cacheKey = getCacheKey(path, body);
  
  const result = deduplicatedRequest(cacheKey, async () => {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = "";
      try {
        const j = (await res.json()) as { error?: string };
        detail = j.error ?? "";
      } catch {
        /* not json */
      }
      throw new Error(detail || `${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<T>;
  });
  
  return result;
}

// ── authenticated calls (Privy) ────────────────────────────────────
export interface AuthTokens {
  accessToken: string | null;
  identityToken: string | null;
}

async function authedFetch<T>(
  path: string,
  tokens: AuthTokens,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  if (!tokens.accessToken) {
    throw new ApiError(401, { error: "sign in first", code: "missing_token" }, "sign in first");
  }
  const headers: Record<string, string> = { authorization: `Bearer ${tokens.accessToken}` };
  if (tokens.identityToken) headers["privy-id-token"] = tokens.identityToken;
  if (init?.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, {
    method: init?.method ?? "GET",
    headers,
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, body, `${res.status} ${res.statusText}`);
  return body as T;
}

// ── Type definitions ───────────────────────────────────────────────
export interface OnChainConfig {
  enabled: boolean;
  cluster: string;
  mainnetRefused: boolean;
  privyConfigured: boolean;
  programId: string;
  rpcUrl: string;
  minDepositLamports: string;
  maxDepositSol: number;
  depositorRentLamports: string | null;
  feeHeadroomLamports: string;
}

export interface OnChainMe {
  userId: string;
  handle: string;
  privyId: string;
  wallet: string;
  walletSource: "identity_token" | "privy_api";
  explorerAddress: string;
  balanceLamports: string;
  balanceSol: number;
  cluster: string;
  depositorRentLamports: string | null;
}

export interface PreparedDeposit {
  transaction: string;
  encoding: "base64";
  transactionVersion: number;
  signed: false;
  vaultId: string;
  vaultPda: string;
  programId: string;
  depositorPda: string;
  needsDepositorInit: boolean;
  authority: string;
  feePayer: string;
  amountLamports: string;
  amountSol: number;
  sharesExpected: string;
  blockhash: string;
  lastValidBlockHeight: number;
  cluster: string;
  rpcUrl: string;
  instructions: Array<{
    index: number;
    programId: string;
    name: string;
    accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  }>;
  costs: {
    depositLamports: string;
    depositorRentLamports: string;
    estimatedFeeLamports: string;
    totalRequiredLamports: string;
    walletBalanceLamports: string;
  };
}

export interface OnChainVaultView {
  id: string;
  initSig: string | null;
  vaultPda: string;
  explorerAddress: string;
  vault: {
    status: string;
    navLamports: string;
    navSol: number;
    navPostedAt: number;
    navStalenessSeconds: number;
    totalShares: string;
    perfFeeBps: number;
    [k: string]: unknown;
  };
  depositor: {
    shares: string;
    netDepositsLamports: string;
    netDepositsSol: number;
    [k: string]: unknown;
  } | null;
}

export interface ConfirmedDeposit {
  recorded: "created" | "already";
  deposit: {
    id: string;
    vaultId: string;
    signature: string;
    explorerTx: string;
    slot: number | null;
    authority: string;
    vaultPda: string;
    depositorPda: string;
    amountLamports: string;
    amountSol: number;
    sharesMinted: string;
    sharesAfter: string;
    initDepositor: boolean;
    createdAt: number;
  };
  explorerTx: string;
  explorerDepositor?: string;
  sharesFrom?: "program_event" | "unavailable";
  depositor?: Record<string, unknown>;
  cluster?: string;
}

export type ChartTimeframe = "1s" | "15s" | "30s" | "1m" | "5m" | "15m" | "1h";

export interface VaultDetail {
  vault: Vault;
  positions: Position[];
  trades: Trade[];
  pendingWithdrawals: WithdrawRequest[];
  pnlCalendar?: PnlDay[];
}

export interface PortfolioView {
  holdings: Holding[];
  pendingWithdrawals: WithdrawRequest[];
  totalValueSol: number;
  totalPnlSol: number;
}

// ── API methods with caching ────────────────────────────────────────
export const api = {
  vaults: async (params?: { type?: string; sort?: string; mode?: "real" | "paper" }) => {
    const q = new URLSearchParams();
    if (params?.type && params.type !== "all") q.set("type", params.type);
    if (params?.sort) q.set("sort", params.sort);
    if (params?.mode) q.set("mode", params.mode);
    const qs = q.toString();
    const r = await get<{ vaults: Vault[] }>(
      `/vaults${qs ? `?${qs}` : ""}`,
      { cache: true, ttl: CACHE_TTL.SHORT }
    );
    return r.vaults;
  },
  vault: (id: string) => get<VaultDetail>(`/vaults/${id}`, { cache: true, ttl: CACHE_TTL.SHORT }),
  createVault: async (body: {
    name: string;
    type: string;
    mode?: "real" | "paper";
    perfFeeBps: number;
    thesis?: string;
    leaderWallet?: string;
    mirrorSizingMode?: "fixed" | "proportional";
    mirrorFixedSol?: number;
    mirrorMaxSol?: number;
  }) => {
    const r = await post<{ vault: Vault }>(`/vaults`, body);
    return r.vault;
  },
  deposit: async (vaultId: string, sol: number) => {
    const r = await post<{ deposit: { id: string; shares: number; costSol: number }; vault: Vault }>(
      `/vaults/${vaultId}/deposit`,
      { sol },
    );
    return { shares: r.deposit.shares, vault: r.vault };
  },
  withdraw: async (vaultId: string, shares: number) => {
    const r = await post<{
      mode: "instant" | "windowed";
      request: WithdrawRequest;
      fees?: FeeBreakdown;
    }>(`/vaults/${vaultId}/withdraw`, { shares });
    return { instant: r.mode === "instant", request: r.request, fees: r.fees };
  },
  token: (mint: string) => get<TokenInfo>(`/tokens/${mint}`, { cache: true, ttl: CACHE_TTL.MEDIUM }),
  portfolio: async (): Promise<PortfolioView> => {
    const r = await get<{ holdings: Holding[]; withdrawRequests: WithdrawRequest[] }>(
      `/portfolio`,
      { cache: false } // Don't cache portfolio data
    );
    return {
      holdings: r.holdings,
      pendingWithdrawals: r.withdrawRequests.filter((w) => w.status === "pending" || w.status === "executable"),
      totalValueSol: r.holdings.reduce((s, h) => s + h.valueSol, 0),
      totalPnlSol: r.holdings.reduce((s, h) => s + h.pnlSol, 0),
    };
  },
  trackedWallets: async () => {
    const r = await get<{ wallets: TrackedWallet[] }>(`/wallets/tracked`, { cache: true, ttl: CACHE_TTL.MEDIUM });
    return r.wallets;
  },
  trackWallet: async (address: string, label?: string) => {
    const r = await post<{ wallet: TrackedWallet }>(`/wallets/tracked`, { address, label });
    return r.wallet;
  },
  health: () => get<{ ok: boolean }>(`/health`, { cache: false }),

  // Live trading
  trade: (
    vaultId: string,
    body:
      | { side: "buy"; mint: string; solAmount: number }
      | { side: "sell"; mint: string; sellFraction: number },
  ) => post<TradeResult>(`/vaults/${vaultId}/trade`, body),
  ohlcv: async (mint: string, tf: ChartTimeframe, since?: number, currency: "USD" | "SOL" = "USD") => {
    const q =
      (since && since > 0 ? `&since=${Math.floor(since)}` : "") +
      (currency === "SOL" ? "&currency=SOL" : "");
    return get<{
      candles: Candle[];
      pool: string | null;
      source?: "pumpfun" | "geckoterminal";
      stale?: boolean;
      fetchedAt?: number;
      partial?: boolean;
      gap?: boolean;
    }>(`/ohlcv/${mint}?tf=${tf}${q}`, { cache: false }); // Don't cache live chart data
  },
  searchTokens: async (q: string) => {
    const r = await get<{ results: TokenSearchResult[] }>(
      `/tokens/search?q=${encodeURIComponent(q)}`,
      { cache: true, ttl: CACHE_TTL.LONG }
    );
    return r.results;
  },
  trending: async () => {
    const r = await get<{ tokens: TrendingToken[] }>(
      `/tokens/trending`,
      { cache: true, ttl: CACHE_TTL.MEDIUM }
    );
    return r.tokens;
  },
  orders: async (vaultId?: string, status?: string) => {
    const q = new URLSearchParams();
    if (vaultId) q.set("vaultId", vaultId);
    if (status) q.set("status", status);
    const r = await get<{ orders: Order[] }>(
      `/orders${q.toString() ? `?${q}` : ""}`,
      { cache: true, ttl: CACHE_TTL.SHORT }
    );
    return r.orders;
  },
  placeOrder: async (body: {
    vaultId: string;
    mint: string;
    kind: OrderKind;
    triggerPriceUsd: number;
    amountSol?: number;
    sellFraction?: number;
  }) => {
    const r = await post<{ order: Order }>(`/orders`, body);
    return r.order;
  },
  cancelOrder: async (id: string) => {
    const r = await post<{ order: Order }>(`/orders/${id}/cancel`, {});
    return r.order;
  },

  // Live platform layer
  meta: () => get<PlatformMeta>(`/meta`, { cache: true, ttl: CACHE_TTL.LONG }),
  activity: async (limit = 30) => {
    const r = await get<{ events: ActivityEvent[] }>(
      `/activity?limit=${limit}`,
      { cache: true, ttl: CACHE_TTL.SHORT }
    );
    return r.events;
  },
  poolTrades: async (mint: string) => {
    const r = await get<{ trades: PoolTrade[] }>(
      `/pooltrades/${mint}`,
      { cache: false }
    );
    return r.trades;
  },
  executeWithdrawal: (id: string) =>
    post<{ request: WithdrawRequest; paidSol: number; fees: FeeBreakdown; vault: Vault }>(
      `/withdrawals/${id}/execute`,
      {},
    ),
  mirrorState: (vaultId: string) =>
    get<{
      config: { sizingMode: "fixed" | "proportional"; fixedSol: number; maxSol: number };
      leaderWallet: string | null;
      lastSig: string | null;
      syncedAt: number | null;
    }>(`/vaults/${vaultId}/mirror`, { cache: true, ttl: CACHE_TTL.MEDIUM }),
  scanWallet: async (address: string, force = false) => {
    const r = await post<{ wallet: TrackedWallet }>(
      `/wallets/tracked/${address}/scan${force ? "?force=1" : ""}`,
      {},
    );
    return r.wallet;
  },
  pulse: () => get<PulseBoard>(`/pulse`, { cache: true, ttl: CACHE_TTL.SHORT }),
  tokenStats: (mint: string) => get<TokenPoolStats>(`/tokenstats/${mint}`, { cache: true, ttl: CACHE_TTL.MEDIUM }),

  // Vested fees
  vested: (traderId?: string) =>
    get<VestedFeeSummary & { lockDays: number; now: number }>(
      `/vested${traderId ? `?traderId=${encodeURIComponent(traderId)}` : ""}`,
      { cache: true, ttl: CACHE_TTL.MEDIUM }
    ),
  claimVested: (id: string) =>
    post<{
      tranche: VestedFeeTranche;
      claimSig: string | null;
      escrowWallet: string | null;
      summary: VestedFeeSummary;
    }>(`/vested/${id}/claim`, {}),

  // On-chain deposits
  onchainConfig: () => get<OnChainConfig>(`/onchain/config`, { cache: true, ttl: CACHE_TTL.LONG }),
  vaultOnchain: (vaultId: string, authority?: string) =>
    get<OnChainVaultView>(
      `/vaults/${vaultId}/onchain${authority ? `?authority=${encodeURIComponent(authority)}` : ""}`,
      { cache: true, ttl: CACHE_TTL.SHORT }
    ),
  onchainMe: (tokens: AuthTokens) => authedFetch<OnChainMe>(`/onchain/me`, tokens),
  prepareOnchainDeposit: (tokens: AuthTokens, vaultId: string, sol: number) =>
    authedFetch<PreparedDeposit>(`/onchain/deposit/prepare`, tokens, {
      method: "POST",
      body: { vaultId, sol },
    }),
  confirmOnchainDeposit: (tokens: AuthTokens, vaultId: string, signature: string) =>
    authedFetch<ConfirmedDeposit>(`/onchain/deposit/confirm`, tokens, {
      method: "POST",
      body: { vaultId, signature },
    }),
  onchainDeposits: (tokens: AuthTokens, vaultId?: string) =>
    authedFetch<{ deposits: ConfirmedDeposit["deposit"][] }>(
      `/onchain/deposits${vaultId ? `?vaultId=${encodeURIComponent(vaultId)}` : ""}`,
      tokens,
    ),

  // DCA orders
  dcaList: async (vaultId: string) => {
    const r = await get<{ orders: DcaOrder[] }>(
      `/dca?vaultId=${vaultId}`,
      { cache: true, ttl: CACHE_TTL.SHORT }
    );
    return r.orders;
  },
  dcaCreate: async (body: {
    vaultId: string;
    mint: string;
    amountSolPerLeg: number;
    intervalSec: number;
    legsTotal: number;
  }) => {
    const r = await post<{ dca: DcaOrder }>(`/dca`, body);
    return r.dca;
  },
  dcaCancel: async (id: string) => {
    const r = await post<{ dca: DcaOrder }>(`/dca/${id}/cancel`, {});
    return r.dca;
  },
};

export interface DcaOrder {
  id: string;
  vaultId: string;
  mint: string;
  symbol: string;
  amountSolPerLeg: number;
  intervalSec: number;
  legsTotal: number;
  legsDone: number;
  nextLegAt: number;
  status: "active" | "done" | "cancelled" | "failed";
  createdAt: number;
  failReason?: string;
}

// ── Cache management ────────────────────────────────────────────────
export function clearCache(pattern?: string): void {
  if (!pattern) {
    requestCache.clear();
    return;
  }
  
  for (const key of requestCache.keys()) {
    if (key.includes(pattern)) {
      requestCache.delete(key);
    }
  }
}

export function getCacheSize(): number {
  return requestCache.size;
}
