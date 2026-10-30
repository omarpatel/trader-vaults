// ── global GeckoTerminal budgeter ──────────────────────────────────
// One token bucket for EVERY GeckoTerminal HTTP call the API makes.
// GT's free tier allows ~30 req/min; we run 25 capacity / 25 refilled
// per minute to leave headroom. Priorities:
//   high   (candles, tokenstats)      — may borrow into the reserve
//   normal (pool resolution, tape)    — waits briefly above the reserve
//   low    (pulse board)              — near-zero patience: fails fast
// When the bucket is dry for a caller's priority it throws the typed
// BudgetExhausted error so callers fall back to their cached/empty
// shapes instead of hammering GT into 429s. A real 429 response still
// triggers a global 10s cool-off (logged once per cool-off, not per
// call) during which every call fails fast. This sits BENEATH the
// services' own response caches — cache hits never reach the bucket.

const CAPACITY = 25;
const REFILL_PER_MS = 25 / 60_000; // 25 tokens per minute, continuous
const RESERVE = 5; // tokens only "high" may borrow into
const COOL_OFF_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 8_000;

export type GtPriority = "high" | "normal" | "low";

/** floor: bucket level a priority may not draw below.
 *  maxWaitMs: longest a caller will queue for refill before giving up. */
const PRIORITY_RULES: Record<GtPriority, { floor: number; maxWaitMs: number }> = {
  high: { floor: 0, maxWaitMs: 6_000 },
  normal: { floor: RESERVE, maxWaitMs: 3_000 },
  low: { floor: RESERVE + 3, maxWaitMs: 250 },
};

/** Thrown when the budget can't cover a call in time (or during a 429
 *  cool-off). Callers treat it like any upstream failure: serve the
 *  cached/empty shape. Distinguishable via `err instanceof BudgetExhausted`. */
export class BudgetExhausted extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExhausted";
  }
}

let tokens = CAPACITY;
let lastRefillAt = Date.now();
let coolOffUntil = 0;

function refill(now: number): void {
  if (now <= lastRefillAt) return;
  tokens = Math.min(CAPACITY, tokens + (now - lastRefillAt) * REFILL_PER_MS);
  lastRefillAt = now;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquire(priority: GtPriority): Promise<void> {
  const { floor, maxWaitMs } = PRIORITY_RULES[priority];
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const now = Date.now();
    if (now < coolOffUntil) {
      throw new BudgetExhausted(
        `GeckoTerminal in 429 cool-off for another ${coolOffUntil - now}ms`,
      );
    }
    refill(now);
    if (tokens >= floor + 1) {
      tokens -= 1;
      return;
    }
    // ms until a full token accrues above this priority's floor
    const needMs = Math.ceil((floor + 1 - tokens) / REFILL_PER_MS);
    if (now + needMs > deadline) {
      throw new BudgetExhausted(
        `GeckoTerminal budget dry for priority "${priority}" (~${needMs}ms to next token)`,
      );
    }
    // re-check after sleeping — another caller may have taken the token
    await sleep(Math.min(needMs + 5, deadline - now));
  }
}

export interface GtFetchOptions {
  priority: GtPriority;
  timeoutMs?: number;
}

/**
 * Budgeted fetch for GeckoTerminal. Resolves to the raw Response so
 * callers keep their own `res.ok` / JSON handling — except 429, which
 * is intercepted here: it starts (or rides out) the global cool-off and
 * throws. Throws BudgetExhausted without touching the network when the
 * bucket can't cover the call.
 */
export async function gtFetch(url: string, opts: GtFetchOptions): Promise<Response> {
  await acquire(opts.priority);
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (res.status === 429) {
    const now = Date.now();
    if (now >= coolOffUntil) {
      coolOffUntil = now + COOL_OFF_MS;
      console.warn(
        `[gtBudget] 429 from GeckoTerminal — global cool-off ${COOL_OFF_MS / 1000}s`,
      );
    }
    throw new Error(`HTTP 429 from ${url}`);
  }
  return res;
}
