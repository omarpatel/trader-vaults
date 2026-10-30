import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  fmtSubscriptPrice,
  fmtUsd,
  type PulseBoard,
  type PulseCard,
  type Vault,
} from "@trader-vaults/shared";
import { api } from "../lib/api";
import { usePageTitle, usePoll } from "../lib/hooks";
import { usePresets } from "../lib/presets";
import { useToast } from "../lib/toast";
import { Skeleton } from "../components/bits";
import { BondRing, RatioBar } from "../components/market";
import { RiskPop } from "../components/RiskPop";

// ── per-column filters (Axiom/GMGN-style funnel) ───────────────────
// Persisted per column id under one key, same store pattern as lib/presets.

interface ColFilters {
  minMcap?: number;
  minLiq?: number;
  maxAgeMin?: number;
  minBondPct?: number;
  hasTxns?: boolean;
}

type PulseFilterState = Record<string, ColFilters>;

const FILTER_KEY = "trader-vaults.pulsefilters.v1";

let filterState: PulseFilterState = (() => {
  try {
    const raw = localStorage.getItem(FILTER_KEY);
    if (raw) return JSON.parse(raw) as PulseFilterState;
  } catch {
    /* fresh */
  }
  return {};
})();

const filterListeners = new Set<() => void>();

function setFilterState(next: PulseFilterState) {
  filterState = next;
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify(next));
  } catch {
    /* quota */
  }
  filterListeners.forEach((l) => l());
}

function usePulseFilters() {
  const snap = useSyncExternalStore(
    (cb) => {
      filterListeners.add(cb);
      return () => filterListeners.delete(cb);
    },
    () => filterState,
  );
  const patch = useCallback((colId: string, p: Partial<ColFilters>) => {
    setFilterState({ ...filterState, [colId]: { ...filterState[colId], ...p } });
  }, []);
  const clear = useCallback((colId: string) => {
    const next = { ...filterState };
    delete next[colId];
    setFilterState(next);
  }, []);
  return { filters: snap, patch, clear };
}

function countActive(f: ColFilters): number {
  let n = 0;
  if (f.minMcap !== undefined) n++;
  if (f.minLiq !== undefined) n++;
  if (f.maxAgeMin !== undefined) n++;
  if (f.minBondPct !== undefined) n++;
  if (f.hasTxns) n++;
  return n;
}

function applyFilters(cards: PulseCard[], f: ColFilters): PulseCard[] {
  if (countActive(f) === 0) return cards;
  return cards.filter((c) => {
    if (f.minMcap !== undefined && !(c.mcapUsd !== undefined && c.mcapUsd >= f.minMcap)) return false;
    if (f.minLiq !== undefined && !(c.liquidityUsd !== undefined && c.liquidityUsd >= f.minLiq)) return false;
    if (f.maxAgeMin !== undefined && !(c.ageSec !== undefined && c.ageSec <= f.maxAgeMin * 60)) return false;
    if (f.minBondPct !== undefined && !(c.bondingPct !== undefined && c.bondingPct >= f.minBondPct)) return false;
    if (f.hasTxns && !(c.txns5m && c.txns5m.buys + c.txns5m.sells > 0)) return false;
    return true;
  });
}

function numOrUndef(v: string): number | undefined {
  if (v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function FilterNum({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  placeholder?: string;
}) {
  return (
    <div className="field" style={{ marginBottom: 0, gap: 3 }}>
      <label>{label}</label>
      <input
        type="number"
        min={0}
        step="any"
        value={value ?? ""}
        placeholder={placeholder ?? "—"}
        style={{ padding: "5px 8px", fontSize: 11.5, width: "100%" }}
        onChange={(e) => onChange(numOrUndef(e.target.value))}
      />
    </div>
  );
}

function age(sec?: number): string {
  if (sec === undefined) return "—";
  if (sec < 60) return `${Math.floor(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

function Card({
  card,
  onQuickBuy,
  buySol,
  busy,
}: {
  card: PulseCard;
  onQuickBuy: (c: PulseCard) => void;
  buySol: number;
  busy: boolean;
}) {
  const nav = useNavigate();
  // Chain checks cost an RPC call each, so they load only for the card the
  // user is actually looking at. Touch devices get an explicit button
  // instead — there is no hover to lean on.
  const [inspect, setInspect] = useState(false);
  return (
    <div
      className="pcard"
      onClick={() => nav(`/token/${card.mint}`)}
      onMouseEnter={() => setInspect(true)}
      onMouseLeave={() => setInspect(false)}
    >
      <BondRing pct={card.bondingPct} src={card.imageUrl} />
      <div className="pmain">
        <div className="prow1">
          <span className="mono" style={{ fontWeight: 700 }}>{card.symbol}</span>
          <span className="dimtx pname">{card.name}</span>
          <span className="num dimtx">{age(card.ageSec)}</span>
        </div>
        <div className="prow2">
          <span className="num">
            <span className="dimtx">MC </span>
            {card.mcapUsd ? fmtUsd(card.mcapUsd) : "—"}
          </span>
          <span className="num">
            <span className="dimtx">V </span>
            {card.volume24hUsd ? fmtUsd(card.volume24hUsd) : "—"}
          </span>
          {card.priceUsd !== undefined && (
            <span className="num dimtx">{fmtSubscriptPrice(card.priceUsd)}</span>
          )}
          {card.change5mPct !== undefined && (
            <span className={`num ${card.change5mPct >= 0 ? "pos" : "neg"}`}>
              {card.change5mPct >= 0 ? "+" : ""}
              {card.change5mPct.toFixed(1)}%
            </span>
          )}
        </div>
      </div>
      {card.txns5m && <RatioBar a={card.txns5m.buys} b={card.txns5m.sells} width={84} />}
      <button
        className={`riskbtn ${inspect ? "on" : ""}`}
        title="On-chain checks"
        onClick={(e) => {
          e.stopPropagation();
          setInspect((v) => !v);
        }}
      >
        ⚑
      </button>
      {inspect && <RiskPop mint={card.mint} bondingPct={card.bondingPct} />}
      <button
        className="zap"
        disabled={busy}
        title={`Quick buy ${buySol} SOL`}
        onClick={(e) => {
          e.stopPropagation();
          onQuickBuy(card);
        }}
      >
        ⚡{buySol}
      </button>
    </div>
  );
}

export function Pulse() {
  usePageTitle("Pulse");
  const toast = useToast();
  const { presets, active, activePreset, setActive, vaultId, setVaultId } = usePresets();
  const { filters, patch, clear } = usePulseFilters();
  const [openCols, setOpenCols] = useState<Record<string, boolean>>({});
  const [busyMint, setBusyMint] = useState<string | null>(null);
  const hoverCol = useRef<string | null>(null);
  const lastBoard = useRef<PulseBoard | null>(null);

  const { data: board } = usePoll<PulseBoard>(
    async () => {
      // hover pauses the stream — serve the frozen board instead of refetching
      if (hoverCol.current && lastBoard.current) return lastBoard.current;
      const b = await api.pulse();
      lastBoard.current = b;
      return b;
    },
    10_000,
    [],
  );
  // quick buys are ledger fills → paper vaults only; real vaults never simulate
  const { data: vaults } = usePoll<Vault[]>(() => api.vaults({ mode: "paper" }), 60_000, []);
  const quickVault =
    (vaultId && vaults?.find((v) => v.id === vaultId)) || vaults?.[0] || null;

  async function quickBuy(card: PulseCard) {
    if (!quickVault) {
      toast("bad", "No vault available to trade from");
      return;
    }
    setBusyMint(card.mint);
    try {
      const r = await api.trade(quickVault.id, {
        side: "buy",
        mint: card.mint,
        solAmount: activePreset.buySol,
      });
      toast("good", `⚡ ${card.symbol}: ${activePreset.buySol} ◎ from ${quickVault.name}`);
      void r;
    } catch (e) {
      toast("bad", `${card.symbol}: ${e instanceof Error ? e.message : "quick buy failed"}`);
    } finally {
      setBusyMint(null);
    }
  }

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Pulse</h1>
          <div className="sub">
            Live token lifecycle — hover a column to pause it. ⚡ buys the active preset from{" "}
            {quickVault ? <strong>{quickVault.name}</strong> : "…"}{" "}
            <span className="pill paper">paper</span> — real vaults trade on-chain only.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select
            value={quickVault?.id ?? ""}
            onChange={(e) => setVaultId(e.target.value)}
            className="quickvault"
            aria-label="Quick-buy vault"
          >
            {(vaults ?? []).map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
          <div className="viewtoggle">
            {presets.map((p, i) => (
              <button key={p.label} className={active === i ? "on" : ""} onClick={() => setActive(i)} title={`${p.buySol} ◎ · slip ${p.slippagePct}% · prio ${p.prioSol}`}>
                {p.label}·{p.buySol}◎
              </button>
            ))}
          </div>
        </div>
      </div>

      {!board ? (
        <div className="pulsegrid">
          {[0, 1, 2].map((i) => (
            <div key={i}>
              <Skeleton h={30} style={{ marginBottom: 10 }} />
              {[0, 1, 2, 3, 4].map((j) => (
                <Skeleton key={j} h={64} style={{ marginBottom: 8 }} />
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="pulsegrid">
          {board.columns.map((col) => {
            const f = filters[col.id] ?? {};
            const nActive = countActive(f);
            const shown = applyFilters(col.cards, f);
            const open = !!openCols[col.id];
            const showBond =
              f.minBondPct !== undefined || col.cards.some((c) => c.bondingPct !== undefined);
            return (
              <div
                key={col.id}
                className="pulsecol"
                onMouseEnter={() => (hoverCol.current = col.id)}
                onMouseLeave={() => (hoverCol.current = null)}
              >
                <div className="pulsehead">
                  <span>{col.title}</span>
                  <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span className="num dimtx">
                      {nActive > 0 ? `${shown.length}/${col.cards.length}` : col.cards.length}
                    </span>
                    <button
                      className={`chip ${nActive > 0 ? "on" : ""}`}
                      style={{
                        padding: "1px 6px",
                        fontSize: 10,
                        lineHeight: "16px",
                        ...(open && nActive === 0 ? { borderColor: "var(--amber)", color: "var(--amber)" } : {}),
                      }}
                      title={open ? "Hide filters" : "Filter column"}
                      aria-label={`Filter ${col.title}`}
                      onClick={() => setOpenCols((s) => ({ ...s, [col.id]: !s[col.id] }))}
                    >
                      ▽{nActive > 0 ? nActive : ""}
                    </button>
                    {nActive > 0 && (
                      <button
                        className="chip"
                        style={{ padding: "1px 6px", fontSize: 10, lineHeight: "16px" }}
                        title="Clear column filters"
                        aria-label={`Clear ${col.title} filters`}
                        onClick={() => clear(col.id)}
                      >
                        ×
                      </button>
                    )}
                  </span>
                </div>
                {open && (
                  <div
                    style={{
                      padding: "9px 11px",
                      borderBottom: "2px solid var(--line-2)",
                      background: "var(--panel-2)",
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: 8,
                      alignItems: "end",
                    }}
                  >
                    <FilterNum
                      label="min mcap $"
                      value={f.minMcap}
                      onChange={(v) => patch(col.id, { minMcap: v })}
                    />
                    <FilterNum
                      label="min liq $"
                      value={f.minLiq}
                      onChange={(v) => patch(col.id, { minLiq: v })}
                    />
                    <FilterNum
                      label="max age min"
                      value={f.maxAgeMin}
                      onChange={(v) => patch(col.id, { maxAgeMin: v })}
                    />
                    {showBond && (
                      <FilterNum
                        label="min bond %"
                        value={f.minBondPct}
                        onChange={(v) => patch(col.id, { minBondPct: v })}
                      />
                    )}
                    <button
                      className={`chip ${f.hasTxns ? "on" : ""}`}
                      style={{ gridColumn: "1 / -1", padding: "5px 0", textAlign: "center" }}
                      onClick={() => patch(col.id, { hasTxns: f.hasTxns ? undefined : true })}
                    >
                      has txns
                    </button>
                  </div>
                )}
                <div className="pulsebody">
                  {col.cards.length === 0 ? (
                    <div className="empty" style={{ padding: 24 }}>feed quiet</div>
                  ) : shown.length === 0 ? (
                    <div className="empty" style={{ padding: 24 }}>
                      all {col.cards.length} filtered out
                    </div>
                  ) : (
                    shown.map((c) => (
                      <Card
                        key={`${col.id}-${c.mint}`}
                        card={c}
                        onQuickBuy={(x) => void quickBuy(x)}
                        buySol={activePreset.buySol}
                        busy={busyMint === c.mint}
                      />
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="dimtx" style={{ fontSize: 11.5, marginTop: 14 }}>
        Sources: pump.fun + GeckoTerminal, refreshed every 10s. Quick buys execute against your
        vault's ledger at the live oracle mark — tokens with no reliable price are refused, and
        brand-new bonding-curve tokens often have none yet.{" "}
        <Link to="/terminal">Open the terminal</Link> for the full ticket.
      </p>
    </>
  );
}
