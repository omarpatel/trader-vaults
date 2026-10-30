// ── in-memory TTL cache ────────────────────────────────────────────
// REDIS SWAP POINT: this module is the only caching surface in the API.
// To move to Redis, reimplement get/set/getOrSet against a client keyed
// off REDIS_URL (JSON.stringify values, PX for ttlMs) and keep the same
// exports — callers never touch the store directly.

interface Entry {
  value: unknown;
  expiresAt: number; // epoch ms
}

const store = new Map<string, Entry>();

/** Occasional sweep so long-lived processes don't accumulate dead keys. */
let lastSweep = Date.now();
function maybeSweep(): void {
  const now = Date.now();
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key);
  }
}

export function cacheGet<T>(key: string): T | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return entry.value as T;
}

export function cacheSet<T>(key: string, value: T, ttlMs: number): T {
  maybeSweep();
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

// ── last-good layer ────────────────────────────────────────────────
// "Degrades to stale, never to blank": services remember the last GOOD
// payload per key (24h) and serve it — flagged stale — when the fresh
// fetch fails or comes back empty. An upstream 429 must never erase a
// chart the user has already seen.

const GOOD_TTL_MS = 24 * 3600_000;

export function rememberGood<T>(key: string, value: T): T {
  store.set(`good:${key}`, { value: { value, at: Date.now() }, expiresAt: Date.now() + GOOD_TTL_MS });
  return value;
}

export function recallGood<T>(key: string): { value: T; at: number } | undefined {
  return cacheGet<{ value: T; at: number }>(`good:${key}`);
}

/**
 * Read-through helper: returns the cached value or runs `load`, caches
 * the result for `ttlMs`, and returns it. Concurrent callers for the
 * same cold key each run `load` (fine at this scale; a Redis version
 * would add a lock or single-flight here).
 */
export async function getOrSet<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
): Promise<T> {
  const hit = cacheGet<T>(key);
  if (hit !== undefined) return hit;
  const value = await load();
  return cacheSet(key, value, ttlMs);
}

export function cacheDelete(key: string): void {
  store.delete(key);
}

export function cacheClear(): void {
  store.clear();
}
