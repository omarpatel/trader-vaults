import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { fmtPct, fmtSol, type TrackedWallet, type TraderProfile, type Vault } from "@trader-vaults/shared";
import { api } from "../lib/api";
import { AddressChip, Delta, Skeleton, Sparkline, TypePill } from "../components/bits";
import { usePageTitle, usePoll } from "../lib/hooks";

type Board = "vaults" | "traders" | "wallets";

const BOARDS: { id: Board; label: string }[] = [
  { id: "vaults", label: "Vaults" },
  { id: "traders", label: "Traders" },
  { id: "wallets", label: "Wallets" },
];

interface TraderRow {
  trader: TraderProfile;
  vaultCount: number;
  tvlSol: number;
  /** TVL-weighted 30d return across the trader's vaults */
  weighted30d: number;
}

function ago(ts: number): string {
  if (!ts) return "—";
  const s = Math.max(1, Math.floor(Date.now() / 1000 - ts));
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function ScanPill({ w }: { w: TrackedWallet }) {
  const s = w.scanStatus ?? "unscanned";
  const cls = s === "ok" ? "filled" : s === "partial" ? "stale" : "neutral";
  const label = s === "ok" ? "scanned" : s === "partial" ? "partial" : "unscanned";
  return (
    <span className={`pill ${cls}`} title={w.scannedAt ? `scanned ${ago(w.scannedAt)}` : "never scanned"}>
      {label}
    </span>
  );
}

function Rank({ i }: { i: number }) {
  return <td className={`rank num ${i < 3 ? "medal" : ""}`}>{String(i + 1).padStart(2, "0")}</td>;
}

function BoardSkeleton() {
  return (
    <div className="panel panel-pad" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} h={30} />
      ))}
    </div>
  );
}

export function Leaderboards() {
  usePageTitle("Leaderboards");
  const nav = useNavigate();
  const [board, setBoard] = useState<Board>("vaults");
  const [mode, setMode] = useState<"real" | "paper">("real");

  const { data: vaults, error: vaultsError } = usePoll<Vault[]>(
    () => api.vaults({ mode }),
    30_000,
    [mode],
  );
  const { data: wallets, error: walletsError } = usePoll<TrackedWallet[]>(() => api.trackedWallets(), 30_000, []);

  const rankedVaults = useMemo(
    () => (vaults ? [...vaults].sort((a, b) => b.stats.pnlPct30d - a.stats.pnlPct30d) : []),
    [vaults],
  );

  const rankedTraders = useMemo<TraderRow[]>(() => {
    if (!vaults) return [];
    const byId = new Map<string, { trader: TraderProfile; vs: Vault[] }>();
    for (const v of vaults) {
      const e = byId.get(v.trader.id);
      if (e) e.vs.push(v);
      else byId.set(v.trader.id, { trader: v.trader, vs: [v] });
    }
    const rows = [...byId.values()].map(({ trader, vs }) => {
      const tvlSol = vs.reduce((s, x) => s + x.tvlSol, 0);
      const weighted30d =
        tvlSol > 0
          ? vs.reduce((s, x) => s + x.stats.pnlPct30d * x.tvlSol, 0) / tvlSol
          : vs.reduce((s, x) => s + x.stats.pnlPct30d, 0) / vs.length;
      return { trader, vaultCount: vs.length, tvlSol, weighted30d };
    });
    return rows.sort((a, b) => b.weighted30d - a.weighted30d);
  }, [vaults]);

  const rankedWallets = useMemo(
    () => (wallets ? [...wallets].sort((a, b) => b.stats.pnlSol - a.stats.pnlSol) : []),
    [wallets],
  );

  const error = board === "wallets" ? walletsError : vaultsError;
  const loading = board === "wallets" ? !wallets : !vaults;

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Leaderboards</h1>
          <div className="sub">
            Every record here is recomputed from chain data — never self-reported. Refreshes 30s.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {board !== "wallets" && (
            <div className="viewtoggle" title="Real records and paper records never mix">
              <button className={mode === "real" ? "on" : ""} onClick={() => setMode("real")}>
                Real
              </button>
              <button className={mode === "paper" ? "on" : ""} onClick={() => setMode("paper")}>
                Paper
              </button>
            </div>
          )}
          <div className="viewtoggle">
            {BOARDS.map((b) => (
              <button key={b.id} className={board === b.id ? "on" : ""} onClick={() => setBoard(b.id)}>
                {b.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && loading && (
        <div className="callout red">
          API unreachable: {error}. Start it with <code>npm run dev:api</code>.
        </div>
      )}
      {loading && !error && <BoardSkeleton />}

      {board === "vaults" && vaults && (
        rankedVaults.length === 0 ? (
          <div className="empty">No vaults on the board yet — the first one tops it by default.</div>
        ) : (
          <div className="panel">
            <div className="tablewrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Vault</th>
                    <th>Trader</th>
                    <th></th>
                    <th className="r">30d</th>
                    <th className="r">All-time</th>
                    <th className="r">Max DD</th>
                    <th className="r">Win</th>
                    <th className="r">TVL</th>
                    <th>Curve</th>
                  </tr>
                </thead>
                <tbody>
                  {rankedVaults.map((v, i) => (
                    <tr key={v.id} onClick={() => nav(`/vault/${v.id}`)} style={{ cursor: "pointer" }}>
                      <Rank i={i} />
                      <td>
                        <Link to={`/vault/${v.id}`} style={{ color: "var(--text)", fontWeight: 600 }}>
                          {v.name}
                        </Link>
                      </td>
                      <td className="mono mutedtx" style={{ fontSize: 12 }}>
                        @{v.trader.handle}
                        {v.trader.xVerified ? " 𝕏" : ""}
                      </td>
                      <td><TypePill type={v.type} /></td>
                      <td className="r num"><Delta v={v.stats.pnlPct30d} /></td>
                      <td className="r num"><Delta v={v.stats.pnlPctAll} /></td>
                      <td className="r num neg">{fmtPct(-Math.abs(v.stats.maxDrawdownPct), 0)}</td>
                      <td className="r num dimtx">{v.stats.winRatePct.toFixed(0)}%</td>
                      <td className="r num">{fmtSol(v.tvlSol, 0)} ◎</td>
                      <td><Sparkline points={v.equityCurve.slice(-40)} width={90} height={26} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      )}

      {board === "traders" && vaults && (
        rankedTraders.length === 0 ? (
          <div className="empty">No traders ranked yet — a trader appears once their first vault is live.</div>
        ) : (
          <div className="panel">
            <div className="tablewrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Trader</th>
                    <th className="r">Vaults</th>
                    <th className="r">Σ TVL</th>
                    <th className="r">30d (TVL-wtd)</th>
                    <th className="r">On-chain PnL</th>
                    <th className="r">Win</th>
                  </tr>
                </thead>
                <tbody>
                  {rankedTraders.map((t, i) => (
                    <tr
                      key={t.trader.id}
                      onClick={() => nav(`/trader/${t.trader.handle}`)}
                      style={{ cursor: "pointer" }}
                    >
                      <Rank i={i} />
                      <td>
                        <Link to={`/trader/${t.trader.handle}`} style={{ color: "var(--text)", fontWeight: 600 }}>
                          {t.trader.displayName}
                        </Link>{" "}
                        <span className="mono mutedtx" style={{ fontSize: 12 }}>
                          @{t.trader.handle}
                          {t.trader.xVerified ? " 𝕏" : ""}
                        </span>
                      </td>
                      <td className="r num dimtx">{t.vaultCount}</td>
                      <td className="r num">{fmtSol(t.tvlSol, 0)} ◎</td>
                      <td className="r num"><Delta v={t.weighted30d} /></td>
                      <td className="r num">
                        <span className={t.trader.onchainStats.pnlSol >= 0 ? "pos" : "neg"}>
                          {t.trader.onchainStats.pnlSol >= 0 ? "+" : ""}
                          {fmtSol(t.trader.onchainStats.pnlSol)} ◎
                        </span>
                      </td>
                      <td className="r num dimtx">{t.trader.onchainStats.winRatePct.toFixed(0)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      )}

      {board === "wallets" && wallets && (
        rankedWallets.length === 0 ? (
          <div className="empty">
            No tracked wallets yet — paste one on the <Link to="/tracking">Tracking</Link> page to put it on the board.
          </div>
        ) : (
          <div className="panel">
            <div className="tablewrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Wallet</th>
                    <th>Scan</th>
                    <th className="r">Win rate</th>
                    <th className="r">Realized PnL</th>
                    <th className="r">Swaps</th>
                    <th className="r">Last active</th>
                    <th className="r"></th>
                  </tr>
                </thead>
                <tbody>
                  {rankedWallets.map((w, i) => (
                    <tr key={w.address}>
                      <Rank i={i} />
                      <td><AddressChip addr={w.address} label={w.label} /></td>
                      <td><ScanPill w={w} /></td>
                      <td className="r num">{w.stats.trades > 0 ? `${w.stats.winRatePct.toFixed(0)}%` : "—"}</td>
                      <td className="r num">
                        {w.stats.trades > 0 ? (
                          <span className={w.stats.pnlSol >= 0 ? "pos" : "neg"}>
                            {w.stats.pnlSol >= 0 ? "+" : ""}
                            {fmtSol(w.stats.pnlSol)} ◎
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="r num dimtx">{w.stats.trades}</td>
                      <td className="r num dimtx">{ago(w.lastActiveAt)}</td>
                      <td className="r">
                        {w.isVaultLeader && w.vaultId ? (
                          <Link to={`/vault/${w.vaultId}`} className="btn ghost sm">
                            vault
                          </Link>
                        ) : (
                          <Link to={`/create?leader=${w.address}`} className="btn sm">
                            mirror
                          </Link>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      )}
    </>
  );
}
