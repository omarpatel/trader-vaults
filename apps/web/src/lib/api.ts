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

/**
 * An API failure that keeps the server's machine-readable `code` and the
 * rest of the JSON body. The on-chain routes answer "insufficient
 * balance", "nav stale" and "mainnet refused" with structured detail the
 * deposit form renders — flattening all of that to a string would throw
 * away exactly the part the user needs to act on.
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

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
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
}

// ── authenticated calls (Privy) ────────────────────────────────────
// Two headers, two different proofs: the ACCESS token says who you are,
// the IDENTITY token lets the server verify which wallet is yours off
// Privy's public JWKS. Both are verified server-side; neither is a claim
// the API takes on trust. See apps/api/src/services/privyAuth.ts.

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

/** One action's availability, with the reason when it is not available. */
export interface WithdrawActionState {
  available: boolean;
  blockers: string[];
  /** emergency only */
  haircutBps?: number;
  estimatedPayoutLamports?: string;
}

export interface WithdrawQuote {
  vaultId: string;
  vaultPda: string;
  wallet: string;
  depositorPda: string;
  shares: string;
  currentValueLamports: string;
  currentValueSol: number;
  netDepositsLamports: string;
  perfFeeBps: number;
  platformFeeBps: number;
  vault: {
    navLamports: string;
    equityLamports: string;
    totalShares: string;
    navAgeSeconds: number;
    navStalenessSeconds: number;
    redeemWindowSeconds: number;
    freeSolLamports: string;
    freeSolSol: number;
    status: string;
  };
  pendingRequest: {
    shares: string;
    valueAtRequestLamports: string;
    requestedAt: number;
    windowEndsAt: number;
    executableIn: number;
  } | null;
  actions: {
    request: WithdrawActionState;
    cancel: WithdrawActionState;
    execute: WithdrawActionState;
    instant: WithdrawActionState;
    emergency: WithdrawActionState;
  };
}

export type WithdrawAction = "request" | "cancel" | "execute" | "instant" | "emergency";

export interface PreparedWithdraw {
  transaction: string;
  encoding: "base64";
  action: WithdrawAction;
  vaultId: string;
  vaultPda: string;
  depositorPda: string;
  authority: string;
  shares: string | null;
  blockhash: string;
  cluster: string;
}

export interface ConfirmedWithdraw {
  ok: true;
  signature: string;
  vaultId: string;
  slot: number;
  feeLamports: number | null;
  logs: string[];
  position: {
    shares: string;
    netDepositsLamports: string;
    cumulativeProfitShareLamports: string;
    hasPendingRequest: boolean;
  };
  vault: { navLamports: string; totalShares: string } | null;
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

/** GET /api/vaults/:id/onchain — decoded program state, BigInts as strings. */
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

/**
 * Chart timeframes. Mirrors the API's TIMEFRAMES, which in turn mirrors the
 * subset of pump.fun's accepted intervals we expose. Sub-minute is the point
 * — memecoin entries are decided there, not on the 1m.
 */
export type ChartTimeframe = "1s" | "15s" | "30s" | "1m" | "5m" | "15m" | "1h";

export interface VaultDetail {
  vault: Vault;
  positions: Position[];
  trades: Trade[];
  pendingWithdrawals: WithdrawRequest[];
  /** absent on older API builds — callers must tolerate undefined */
  pnlCalendar?: PnlDay[];
}

export interface PortfolioView {
  holdings: Holding[];
  pendingWithdrawals: WithdrawRequest[];
  totalValueSol: number;
  totalPnlSol: number;
}

export const api = {
  vaults: async (params?: { type?: string; sort?: string; mode?: "real" | "paper" }) => {
    const q = new URLSearchParams();
    if (params?.type && params.type !== "all") q.set("type", params.type);
    if (params?.sort) q.set("sort", params.sort);
    if (params?.mode) q.set("mode", params.mode);
    const qs = q.toString();
    const r = await get<{ vaults: Vault[] }>(`/vaults${qs ? `?${qs}` : ""}`);
    return r.vaults;
  },
  vault: (id: string) => get<VaultDetail>(`/vaults/${id}`),
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
  }, tokens?: AuthTokens) => {
    // Vault creation went through the unauthenticated post(), which sends
    // only content-type. The server then could not identify the caller and
    // fell back to the demo user, so EVERY vault ever created was owned by
    // "you" no matter who made it.
    const r = tokens?.accessToken
      ? await authedFetch<{ vault: Vault }>(`/vaults`, tokens, { method: "POST", body })
      : await post<{ vault: Vault }>(`/vaults`, body);
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
  token: (mint: string) => get<TokenInfo>(`/tokens/${mint}`),
  /**
   * The caller's own portfolio.
   *
   * `tokens` is optional only so demo mode (no Privy) still works. With Privy
   * configured the API returns an EMPTY portfolio for an unauthenticated
   * caller rather than the shared demo account's positions, so a signed-in
   * user who does not send them sees nothing — which is why every call site
   * passes them.
   */
  portfolio: async (tokens?: AuthTokens): Promise<PortfolioView> => {
    const r = tokens
      ? await authedFetch<{ holdings: Holding[]; withdrawRequests: WithdrawRequest[] }>(
          `/portfolio`,
          tokens,
        )
      : await get<{ holdings: Holding[]; withdrawRequests: WithdrawRequest[] }>(`/portfolio`);
    return {
      holdings: r.holdings,
      pendingWithdrawals: r.withdrawRequests.filter((w) => w.status === "pending" || w.status === "executable"),
      totalValueSol: r.holdings.reduce((s, h) => s + h.valueSol, 0),
      totalPnlSol: r.holdings.reduce((s, h) => s + h.pnlSol, 0),
    };
  },
  trackedWallets: async () => {
    const r = await get<{ wallets: TrackedWallet[] }>(`/wallets/tracked`);
    return r.wallets;
  },
  trackWallet: async (address: string, label?: string) => {
    const r = await post<{ wallet: TrackedWallet }>(`/wallets/tracked`, { address, label });
    return r.wallet;
  },
  health: () => get<{ ok: boolean }>(`/health`),

  // ── live trading tech ──
  trade: (
    vaultId: string,
    body:
      | { side: "buy"; mint: string; solAmount: number }
      | { side: "sell"; mint: string; sellFraction: number },
  ) => post<TradeResult>(`/vaults/${vaultId}/trade`, body),
  /**
   * Candles. Pass `since` (the newest bar time already held) to get only the
   * tail — a full 1s window is ~85KB and polling it every 1.2s is hundreds
   * of megabytes an hour at one viewer. The response echoes `partial` so the
   * caller knows to merge, and `gap` when the window no longer reaches back
   * to `since` and a full refetch is required.
   */
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
    }>(`/ohlcv/${mint}?tf=${tf}${q}`);
  },
  searchTokens: async (q: string) => {
    const r = await get<{ results: TokenSearchResult[] }>(
      `/tokens/search?q=${encodeURIComponent(q)}`,
    );
    return r.results;
  },
  trending: async () => {
    const r = await get<{ tokens: TrendingToken[] }>(`/tokens/trending`);
    return r.tokens;
  },
  orders: async (vaultId?: string, status?: string) => {
    const q = new URLSearchParams();
    if (vaultId) q.set("vaultId", vaultId);
    if (status) q.set("status", status);
    const r = await get<{ orders: Order[] }>(`/orders${q.toString() ? `?${q}` : ""}`);
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

  // ── live platform layer ──
  meta: () => get<PlatformMeta>(`/meta`),
  activity: async (limit = 30) => {
    const r = await get<{ events: ActivityEvent[] }>(`/activity?limit=${limit}`);
    return r.events;
  },
  poolTrades: async (mint: string) => {
    const r = await get<{ trades: PoolTrade[] }>(`/pooltrades/${mint}`);
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
    }>(`/vaults/${vaultId}/mirror`),
  scanWallet: async (address: string, force = false) => {
    const r = await post<{ wallet: TrackedWallet }>(
      `/wallets/tracked/${address}/scan${force ? "?force=1" : ""}`,
      {},
    );
    return r.wallet;
  },
  pulse: () => get<PulseBoard>(`/pulse`),
  tokenStats: (mint: string) => get<TokenPoolStats>(`/tokenstats/${mint}`),

  // ── vested (escrowed) trader fees ──
  // The third of every performance fee that sits in escrow for 60 days.
  // Omit traderId for the demo/authenticated user.
  vested: (traderId?: string) =>
    get<VestedFeeSummary & { lockDays: number; now: number }>(
      `/vested${traderId ? `?traderId=${encodeURIComponent(traderId)}` : ""}`,
    ),
  claimVested: (id: string) =>
    post<{
      tranche: VestedFeeTranche;
      claimSig: string | null;
      escrowWallet: string | null;
      summary: VestedFeeSummary;
    }>(`/vested/${id}/claim`, {}),

  // ── real, user-signed on-chain deposits ──
  // prepare returns an UNSIGNED transaction; the user's wallet signs and
  // broadcasts it; confirm re-verifies the signature on chain before the
  // API will record anything.
  onchainConfig: () => get<OnChainConfig>(`/onchain/config`),
  /** decoded live program state; `authority` also returns that key's record */
  vaultOnchain: (vaultId: string, authority?: string) =>
    get<OnChainVaultView>(
      `/vaults/${vaultId}/onchain${authority ? `?authority=${encodeURIComponent(authority)}` : ""}`,
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
  // ── real, user-signed on-chain withdrawals ──
  // quote first: it names every reason a withdrawal would be refused, so the
  // user learns about a gate before signing rather than from a revert.
  withdrawQuote: (tokens: AuthTokens, vaultId: string) =>
    authedFetch<WithdrawQuote>(
      `/onchain/withdraw/quote?vaultId=${encodeURIComponent(vaultId)}`,
      tokens,
    ),
  prepareOnchainWithdraw: (
    tokens: AuthTokens,
    vaultId: string,
    action: WithdrawAction,
    shares?: string,
  ) =>
    authedFetch<PreparedWithdraw>(`/onchain/withdraw/prepare`, tokens, {
      method: "POST",
      body: { vaultId, action, ...(shares !== undefined ? { shares } : {}) },
    }),
  confirmOnchainWithdraw: (tokens: AuthTokens, vaultId: string, signature: string) =>
    authedFetch<ConfirmedWithdraw>(`/onchain/withdraw/confirm`, tokens, {
      method: "POST",
      body: { vaultId, signature },
    }),

  onchainDeposits: (tokens: AuthTokens, vaultId?: string) =>
    authedFetch<{ deposits: ConfirmedDeposit["deposit"][] }>(
      `/onchain/deposits${vaultId ? `?vaultId=${encodeURIComponent(vaultId)}` : ""}`,
      tokens,
    ),

  // ── DCA orders (wire type local until shared package ships it) ──
  dcaList: async (vaultId: string) => {
    const r = await get<{ orders: DcaOrder[] }>(`/dca?vaultId=${vaultId}`);
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
