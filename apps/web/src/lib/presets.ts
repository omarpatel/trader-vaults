/**
 * Quick-buy execution presets — the P1/P2/P3 pattern every serious terminal
 * uses (GMGN, Padre, Photon's S1-S3). A preset bundles size + execution
 * settings; the active one powers ⚡ quick buys on Pulse and the terminal.
 */
import { useCallback, useSyncExternalStore } from "react";

export interface Preset {
  label: string;
  buySol: number;
  slippagePct: number;
  prioSol: number;
  mev: "off" | "reduced" | "secure";
}

interface PresetState {
  presets: [Preset, Preset, Preset];
  active: number;
  /** last vault used for quick buys */
  vaultId: string | null;
}

const KEY = "trader-vaults.presets.v1";

const DEFAULTS: PresetState = {
  presets: [
    { label: "P1", buySol: 0.5, slippagePct: 2, prioSol: 0.001, mev: "reduced" },
    { label: "P2", buySol: 1, slippagePct: 5, prioSol: 0.002, mev: "reduced" },
    { label: "P3", buySol: 3, slippagePct: 10, prioSol: 0.005, mev: "off" },
  ],
  active: 0,
  vaultId: null,
};

let state: PresetState = (() => {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<PresetState>) };
  } catch {
    /* fresh */
  }
  return DEFAULTS;
})();

const listeners = new Set<() => void>();

function setState(next: PresetState) {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* quota */
  }
  listeners.forEach((l) => l());
}

export function usePresets() {
  const snap = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
  const setActive = useCallback((i: number) => setState({ ...state, active: i }), []);
  const updatePreset = useCallback((i: number, p: Partial<Preset>) => {
    const presets = state.presets.map((x, j) => (j === i ? { ...x, ...p } : x)) as PresetState["presets"];
    setState({ ...state, presets });
  }, []);
  const setVaultId = useCallback((vaultId: string | null) => setState({ ...state, vaultId }), []);
  return {
    presets: snap.presets,
    active: snap.active,
    activePreset: snap.presets[snap.active] ?? snap.presets[0]!,
    vaultId: snap.vaultId,
    setActive,
    updatePreset,
    setVaultId,
  };
}
