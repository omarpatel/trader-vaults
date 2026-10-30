import { useEffect, useState } from "react";

/**
 * Token security facts, fetched lazily and cached for the session.
 *
 * Every field here costs a mainnet RPC round trip, so this is deliberately
 * NOT fetched for a whole board at once — thirty cards refreshing every ten
 * seconds would burn the rate limit for data nobody read. It loads when a
 * card is actually inspected, and once loaded it stays.
 */

export interface SecurityHolder {
  address: string;
  uiAmount: number;
  pct: number;
}

export interface TokenSecurity {
  /** true = revoked (safe), false = still ACTIVE (dangerous), null = unknown */
  mintAuthorityRevoked: boolean | null;
  freezeAuthorityRevoked: boolean | null;
  decimals: number | null;
  supplyUi: number | null;
  /** combined share of the 10 largest token accounts, 0-100 */
  top10Pct: number | null;
  largestHolders: SecurityHolder[];
  fetchedAt: number;
}

const cache = new Map<string, TokenSecurity>();
const inFlight = new Map<string, Promise<TokenSecurity | null>>();

function load(mint: string): Promise<TokenSecurity | null> {
  const hit = inFlight.get(mint);
  if (hit) return hit; // never fire the same lookup twice
  const p = fetch(`/api/security/${mint}`)
    .then((r) => (r.ok ? (r.json() as Promise<TokenSecurity>) : null))
    .then((s) => {
      if (s) cache.set(mint, s);
      return s;
    })
    .catch(() => null)
    .finally(() => inFlight.delete(mint));
  inFlight.set(mint, p);
  return p;
}

/** Pass null to fetch nothing — that's how hover-to-load stays lazy. */
export function useTokenSecurity(mint: string | null): {
  data: TokenSecurity | null;
  loading: boolean;
} {
  const [, bump] = useState(0);
  const cached = mint ? cache.get(mint) ?? null : null;
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!mint || cache.has(mint)) return;
    let alive = true;
    setLoading(true);
    void load(mint).then(() => {
      if (!alive) return;
      setLoading(false);
      bump((n) => n + 1);
    });
    return () => {
      alive = false;
    };
  }, [mint]);

  return { data: cached, loading: loading && !cached };
}

/** Concentration verdict — the single number that decides most rugs. */
export function top10Tone(pct: number | null | undefined): "pos" | "warn" | "neg" | "dim" {
  if (pct === null || pct === undefined) return "dim";
  if (pct < 25) return "pos";
  if (pct < 50) return "warn";
  return "neg";
}
