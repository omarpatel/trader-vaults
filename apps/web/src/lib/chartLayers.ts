import { useCallback, useSyncExternalStore } from "react";

/**
 * Chart overlay layers — the "Display Options" idea.
 *
 * A memecoin chart is more useful as an event canvas than as candles alone:
 * what matters is WHO traded and WHEN, not just where price went. Each layer
 * is independently toggleable and the choice persists, because a trader sets
 * this up once and expects it to survive a reload.
 *
 * Every layer here is backed by data the app already has on-chain — nothing
 * is drawn that can't be traced to a real fill or a real pool trade.
 */

export type LayerId = "mine" | "tracked" | "whales" | "avgEntry";

export interface LayerDef {
  id: LayerId;
  label: string;
  /** shown under the label in the menu — says where the data comes from */
  hint: string;
}

export const CHART_LAYERS: LayerDef[] = [
  { id: "mine", label: "My trades", hint: "this vault's fills" },
  { id: "tracked", label: "Tracked trades", hint: "wallets you follow" },
  { id: "whales", label: "Whale trades", hint: "pool trades ≥ $500" },
  { id: "avgEntry", label: "Average entry", hint: "your cost basis line" },
];

type LayerState = Record<LayerId, boolean>;

const DEFAULTS: LayerState = { mine: true, tracked: true, whales: false, avgEntry: true };

const KEY = "trader-vaults.chartlayers.v1";

let state: LayerState = (() => {
  try {
    const raw = localStorage.getItem(KEY);
    // merge over defaults so a new layer appears without wiping the saved set
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<LayerState>) };
  } catch {
    /* fresh */
  }
  return { ...DEFAULTS };
})();

const listeners = new Set<() => void>();

function set(next: LayerState) {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* quota */
  }
  listeners.forEach((l) => l());
}

export function useChartLayers() {
  const layers = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
  const toggle = useCallback((id: LayerId) => {
    set({ ...state, [id]: !state[id] });
  }, []);
  return { layers, toggle };
}

/** USD size at which a pool trade counts as a whale print. */
export const WHALE_USD = 500;
