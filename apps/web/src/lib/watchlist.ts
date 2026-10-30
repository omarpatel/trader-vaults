/** Global token watchlist — the star-everywhere pattern. localStorage-backed. */
import { useCallback, useSyncExternalStore } from "react";

export interface WatchItem {
  mint: string;
  symbol: string;
}

const KEY = "trader-vaults.watchlist.v1";

let items: WatchItem[] = (() => {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as WatchItem[];
  } catch {
    /* fresh */
  }
  return [];
})();

const listeners = new Set<() => void>();

function set(next: WatchItem[]) {
  items = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* quota */
  }
  listeners.forEach((l) => l());
}

export function useWatchlist() {
  const snap = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => items,
  );
  const toggle = useCallback((mint: string, symbol: string) => {
    if (items.some((i) => i.mint === mint)) set(items.filter((i) => i.mint !== mint));
    else set([...items, { mint, symbol }].slice(-12));
  }, []);
  const isWatched = useCallback((mint: string) => items.some((i) => i.mint === mint), []);
  return { items: snap, toggle, isWatched };
}
