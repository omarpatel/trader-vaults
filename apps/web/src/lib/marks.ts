import { useEffect, useMemo, useSyncExternalStore } from "react";

/**
 * Live price marks, shared across every component that wants one.
 *
 * The vault endpoint is heavy and the server only revalues positions on its
 * own tick, so PnL read from it lags the market badly. This store polls the
 * tiny /api/marks endpoint instead: one request per interval covering every
 * mint anyone on the page currently cares about, so the terminal, the
 * position bar and the portfolio all tick together for the cost of one fetch.
 *
 * Mints are reference-counted — a mint stops being polled when its last
 * consumer unmounts.
 */

export interface Mark {
  priceSol: number;
  priceUsd: number;
  stale: boolean;
  /** client clock when this mark arrived */
  at: number;
}

export type MarkMap = ReadonlyMap<string, Mark>;

const POLL_MS = 3_000;
/** Matches the server's per-request cap. */
const MAX_MINTS = 40;

const refs = new Map<string, number>();
let marks: Map<string, Mark> = new Map();
/** Replaced (not mutated) on every change so snapshot identity is meaningful. */
let snapshot: MarkMap = marks;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

function emit() {
  snapshot = marks;
  listeners.forEach((l) => l());
}

async function tick(force = false) {
  if (inFlight) return; // never stack requests on a slow network
  if (document.hidden && !force) return;
  const mints = [...refs.keys()].slice(0, MAX_MINTS);
  if (mints.length === 0) return;
  inFlight = true;
  try {
    const r = await fetch(`/api/marks?mints=${encodeURIComponent(mints.join(","))}`);
    if (!r.ok) return;
    const body = (await r.json()) as {
      marks?: { mint: string; priceSol: number; priceUsd: number; stale: boolean }[];
    };
    if (!body.marks?.length) return;
    const at = Date.now();
    const next = new Map(marks);
    let changed = false;
    for (const m of body.marks) {
      const prev = next.get(m.mint);
      // identity only changes on a real move, so consumers of a single mark
      // don't re-render every 3 seconds for nothing
      if (prev && prev.priceSol === m.priceSol && prev.stale === m.stale) continue;
      next.set(m.mint, { priceSol: m.priceSol, priceUsd: m.priceUsd, stale: m.stale, at });
      changed = true;
    }
    if (changed) {
      marks = next;
      emit();
    }
  } catch {
    // a dropped poll is not an error worth surfacing — the previous mark
    // stays on screen and the next tick corrects it
  } finally {
    inFlight = false;
  }
}

function ensureTimer() {
  if (timer || refs.size === 0) return;
  timer = setInterval(() => void tick(), POLL_MS);
  document.addEventListener("visibilitychange", onVis);
  void tick(true);
}

function onVis() {
  if (!document.hidden) void tick(true);
}

function stopTimer() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  document.removeEventListener("visibilitychange", onVis);
}

function retain(mints: string[]) {
  for (const m of mints) refs.set(m, (refs.get(m) ?? 0) + 1);
  ensureTimer();
}

function release(mints: string[]) {
  for (const m of mints) {
    const n = (refs.get(m) ?? 0) - 1;
    if (n > 0) refs.set(m, n);
    else refs.delete(m);
  }
  if (refs.size === 0) stopTimer();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Subscribe to live marks for `mints`. Returns a map of whatever has arrived. */
export function useMarks(mints: string[]): MarkMap {
  // join key keeps the effect from re-running on every render's new array
  const key = mints.join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const list = useMemo(() => (key ? key.split(",") : []), [key]);

  useEffect(() => {
    if (list.length === 0) return;
    retain(list);
    return () => release(list);
  }, [list]);

  return useSyncExternalStore(subscribe, () => snapshot);
}

/** Single-mint convenience. */
export function useMark(mint: string | null | undefined): Mark | undefined {
  const map = useMarks(mint ? [mint] : []);
  return mint ? map.get(mint) : undefined;
}

/**
 * Mark a position against a live price.
 *
 * `amountTokens × priceSol` is exactly what the server's revaluation does, so
 * this is the same number arriving sooner — not a different one. Falls back to
 * the server's value when no live mark has arrived yet.
 */
export function liveMark(
  pos: { amountTokens: number; costSol: number; valueSol: number; pnlSol: number; pnlPct: number },
  mark: Mark | undefined,
): { valueSol: number; pnlSol: number; pnlPct: number; live: boolean } {
  if (!mark || mark.priceSol <= 0) {
    return { valueSol: pos.valueSol, pnlSol: pos.pnlSol, pnlPct: pos.pnlPct, live: false };
  }
  const valueSol = pos.amountTokens * mark.priceSol;
  const pnlSol = valueSol - pos.costSol;
  return {
    valueSol,
    pnlSol,
    pnlPct: pos.costSol > 0 ? (pnlSol / pos.costSol) * 100 : 0,
    live: true,
  };
}
