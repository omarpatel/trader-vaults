import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fmtPct, fmtSol, splitPerfFeeBps, VEST_LOCK_DAYS } from "@trader-vaults/shared";
import { api, type VaultDetail } from "../lib/api";
import { usePageTitle } from "../lib/hooks";
import { AddressChip, Delta, EquityChart, Stat, StatusPill, TypePill } from "../components/bits";
import { PnlCalendar } from "../components/PnlCalendar";
import { PositionsTable } from "../components/PositionsTable";
import { TradeTape } from "../components/TradeTape";
import { DepositPanel } from "../components/DepositPanel";

const RANGES = [
  { id: "7d", label: "7D", seconds: 7 * 86400 },
  { id: "30d", label: "30D", seconds: 30 * 86400 },
  { id: "all", label: "ALL", seconds: Infinity },
] as const;

export function VaultPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<VaultDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<(typeof RANGES)[number]["id"]>("30d");
  const [hypo, setHypo] = useState("10");
  const [mirror, setMirror] = useState<Awaited<ReturnType<typeof api.mirrorState>> | null>(null);

  const load = useCallback(() => {
    if (!id) return;
    api
      .vault(id)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "failed"));
  }, [id]);

  useEffect(() => {
    load();
    const iv = setInterval(() => {
      if (!document.hidden) load();
    }, 15_000);
    return () => clearInterval(iv);
  }, [load]);

  // mirror vaults: copy engine sync state (60s cadence like the engine)
  useEffect(() => {
    if (!id || data?.vault.type !== "mirror") return;
    let alive = true;
    const loadMirror = () =>
      api
        .mirrorState(id)
        .then((m) => alive && setMirror(m))
        .catch(() => {});
    loadMirror();
    const iv = setInterval(loadMirror, 60_000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [id, data?.vault.type]);
  usePageTitle(data?.vault.name ?? "Vault");

  if (error) return <div className="callout red">Couldn't load vault: {error}</div>;
  if (!data) return <div className="empty">Loading vault…</div>;
  const { vault, positions, trades } = data;
  const s = vault.stats;
  const feeSplit = splitPerfFeeBps(vault.perfFeeBps);

  return (
    <>
      <div className="pagehead">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h1>{vault.name}</h1>
            <span className={`pill ${vault.mode}`}>{vault.mode === "real" ? "on-chain" : "paper"}</span>
            <TypePill type={vault.type} />
            <StatusPill status={vault.status} />
          </div>
          <div className="sub" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span>
              by <span className="mono">@{vault.trader.handle}</span>
              {vault.trader.xVerified ? " · 𝕏 linked" : ""}
            </span>
            {vault.leaderWallet && <AddressChip addr={vault.leaderWallet} label="copies" />}
            <span>· {s.ageDays}d old</span>
          </div>
        </div>
      </div>

      <div className="sidegrid">
        <div className="sg-head">
          <div className="statrow" style={{ marginBottom: 16 }}>
            <Stat k="TVL" v={`${fmtSol(vault.tvlSol)} ◎`} />
            <Stat k="30d return" v={fmtPct(s.pnlPct30d)} tone={s.pnlPct30d >= 0 ? "pos" : "neg"} />
            <Stat k="All-time" v={fmtPct(s.pnlPctAll)} tone={s.pnlPctAll >= 0 ? "pos" : "neg"} />
            <Stat k="Max drawdown" v={fmtPct(-Math.abs(s.maxDrawdownPct))} tone="neg" />
            <Stat k="Win rate" v={`${s.winRatePct.toFixed(0)}%`} d={`${s.tradesCount} trades`} />
            {vault.type === "mirror" && s.medianCopyLagSlots !== undefined && (
              <Stat k="Median copy lag" v={`+${s.medianCopyLagSlots} slots`} d="public metric" />
            )}
          </div>

          <div className="panel panel-pad" style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span className="dimtx mono" style={{ fontSize: 10, letterSpacing: "0.14em" }}>
                PER-SHARE VALUE — FLOWS DON'T MOVE IT, PERFORMANCE DOES
              </span>
              <div className="viewtoggle">
                {RANGES.map((r) => (
                  <button key={r.id} className={range === r.id ? "on" : ""} onClick={() => setRange(r.id)}>
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
            <EquityChart
              points={(() => {
                const spec = RANGES.find((r) => r.id === range)!;
                if (spec.seconds === Infinity) return vault.equityCurve;
                const cutoff = Date.now() / 1000 - spec.seconds;
                const sliced = vault.equityCurve.filter((p) => p.t >= cutoff);
                return sliced.length >= 2 ? sliced : vault.equityCurve;
              })()}
            />
          </div>

          <div className="panel panel-pad" style={{ marginTop: 14 }}>
            <div className="sectiontitle" style={{ marginTop: 0 }}>
              Daily realized pnl
            </div>
            <PnlCalendar days={data.pnlCalendar ?? []} />
          </div>
        </div>

        <div className="sg-side" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <DepositPanel vault={vault} onChanged={load} />

          <div className="panel panel-pad">
            <div className="sectiontitle" style={{ marginTop: 0 }}>The deal</div>
            {/* The platform takes NOTHING, on real and paper alike. This
                block used to quote real vaults a 10% platform cut while
                settle_withdrawal charged zero — a depositor with 10 SOL of
                profit was told 6 SOL and paid 7. Same number both sides now,
                and it comes from one expression so they cannot drift. */}
            <div className="kv">
              <span className="k">If you profit</span>
              <span className="v">
                {`keep ${(100 - vault.perfFeeBps / 100).toFixed(0)}% · trader ${(vault.perfFeeBps / 100).toFixed(0)}% · platform 0%`}
              </span>
            </div>
            <div className="kv">
              <span className="k">Trader's cut is split</span>
              <span className="v">
                {vault.mode === "real"
                  ? "no — full fee paid on exit"
                  : `${(feeSplit.immediateBps / 100).toFixed(0)}% now · ${(feeSplit.vestedBps / 100).toFixed(0)}% vested ${VEST_LOCK_DAYS}d`}
              </span>
            </div>
            <div className="kv"><span className="k">If you lose</span><span className="v">no fees, ever</span></div>
            <div className="kv"><span className="k">Big-exit wait</span><span className="v">up to {vault.redeemWindowHours}h</span></div>
            <div className="kv"><span className="k">Trader's own money in</span><span className="v">{fmtSol(vault.managerStakeSol)} ◎ ({vault.managerStakePct.toFixed(1)}%)</span></div>
            <div className="kv"><span className="k">Instant-exit cash</span><span className="v">{fmtSol(vault.solBufferSol)} ◎</span></div>
            <div className="kv">
              <span className="k">Fees paid so far</span>
              <span className="v" title="Charged only on realized profit above each depositor's cost basis — a recovery back to break-even is never charged">
                trader {fmtSol(vault.traderFeesAccruedSol)} ◎ · escrowed {fmtSol(vault.vestedFeesAccruedSol)} ◎
              </span>
            </div>
            {vault.mode === "real" ? (
              <p className="dimtx" style={{ fontSize: 11.5, marginBottom: 0 }}>
                <strong>These are the deployed program's terms, not Trader Vaults' new ones.</strong> The
                live bytecode pays the trader their full fee on exit and takes a separate 10%
                platform cut. Trader Vaults' new deal — depositors keep 70%, the platform takes nothing,
                and a third of the trader's fee is escrowed for {VEST_LOCK_DAYS} days — is running
                on paper vaults today and reaches real vaults only when the program is upgraded and
                redeployed.
              </p>
            ) : (
              <p className="dimtx" style={{ fontSize: 11.5, marginBottom: 0 }}>
                A third of the trader's fee is locked in escrow for {VEST_LOCK_DAYS} days before
                they can claim it, so a trader who blows up or disappears can't walk away with
                their whole fee the day they earn it. The platform takes no cut at all.
              </p>
            )}
          </div>

          {vault.type === "mirror" && mirror && (
            <div className="panel panel-pad">
              <div className="sectiontitle" style={{ marginTop: 0 }}>Copy engine</div>
              <div className="kv">
                <span className="k">Leader</span>
                <span className="v">{mirror.leaderWallet ? <AddressChip addr={mirror.leaderWallet} /> : "—"}</span>
              </div>
              <div className="kv">
                <span className="k">Sizing</span>
                <span className="v">
                  {mirror.config.sizingMode === "fixed"
                    ? `${mirror.config.fixedSol} ◎ / copy`
                    : "proportional"}{" "}
                  · cap {mirror.config.maxSol} ◎
                </span>
              </div>
              <div className="kv">
                <span className="k">Last sync</span>
                <span className="v">
                  {mirror.syncedAt
                    ? `${Math.max(0, Math.floor((Date.now() / 1000 - mirror.syncedAt) / 60))}m ago`
                    : "attaching…"}
                </span>
              </div>
              <p className="dimtx" style={{ fontSize: 11.5, marginBottom: 0 }}>
                Copies from attach time forward — never replayed history. Copy lag on each fill is
                the elapsed-time estimate shown in the tape.
              </p>
            </div>
          )}

          <div className="panel panel-pad">
            <div className="sectiontitle" style={{ marginTop: 0 }}>If you deposit</div>
            <div className="field" style={{ marginBottom: 8 }}>
              <label>Deposit (SOL)</label>
              <input type="number" min="0" value={hypo} onChange={(e) => setHypo(e.target.value)} />
            </div>
            {(() => {
              const dep = parseFloat(hypo) || 0;
              const ret = vault.stats.pnlPct30d / 100;
              const gross = dep * ret;
              // The trader's performance fee is the only thing charged, on
              // real and paper alike. This used to add 10% for real vaults,
              // which the program has never taken.
              const platformRate = 0;
              const traderRate = vault.perfFeeBps / 10_000;
              const yoursRate = 1 - traderRate - platformRate;
              const yours = gross > 0 ? gross * yoursRate : gross;
              return (
                <>
                  <div className="kv">
                    <span className="k">At last 30d pace</span>
                    <span className={`v ${gross >= 0 ? "pos" : "neg"}`}>
                      {gross >= 0 ? "+" : ""}{fmtSol(gross)} ◎ gross
                    </span>
                  </div>
                  <div className="kv">
                    <span className="k">Your cut ({(yoursRate * 100).toFixed(0)}%)</span>
                    <span className={`v ${yours >= 0 ? "pos" : "neg"}`}>
                      {yours >= 0 ? "+" : ""}{fmtSol(yours)} ◎
                    </span>
                  </div>
                  <div className="kv">
                    <span className="k">Trader's fee</span>
                    <span className="v dimtx">
                      {gross > 0
                        ? `${fmtSol(gross * traderRate)} ◎ · platform takes nothing`
                        : "0 — no profit, no fee"}
                    </span>
                  </div>
                  <p className="dimtx" style={{ fontSize: 11, marginBottom: 0 }}>
                    Illustration at the vault's last-30d pace — not a projection. Losses are all yours;
                    fees only ever apply above your personal high-water mark.
                  </p>
                </>
              );
            })()}
          </div>

          <div className="callout">
            Custody: funds live in a program-owned vault. The trader's only power is a validated swap
            instruction — there is no code path that lets them withdraw. They <em>can</em> still lose;
            manager stake above is their skin in the game.
          </div>

          <div className="panel panel-pad">
            <div className="sectiontitle" style={{ marginTop: 0 }}>Trader</div>
            <Link
              to={`/trader/${vault.trader.handle}`}
              style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, color: "inherit" }}
            >
              <div className="avatar" style={{ width: 34, height: 34, borderRadius: "50%", background: "var(--panel-3)", display: "grid", placeItems: "center", fontFamily: "var(--mono)", color: "var(--green)" }}>
                {vault.trader.handle.slice(0, 1).toUpperCase()}
              </div>
              <div>
                <div style={{ fontWeight: 650 }}>{vault.trader.displayName}</div>
                <div className="mono dimtx" style={{ fontSize: 12 }}>@{vault.trader.handle}{vault.trader.xHandle ? ` · 𝕏 @${vault.trader.xHandle}` : ""}</div>
              </div>
            </Link>
            <div className="kv"><span className="k">On-chain PnL</span><span className={`v ${vault.trader.onchainStats.pnlSol >= 0 ? "pos" : "neg"}`}>{fmtSol(vault.trader.onchainStats.pnlSol)} ◎</span></div>
            <div className="kv"><span className="k">Win rate</span><span className="v">{vault.trader.onchainStats.winRatePct.toFixed(0)}% · {vault.trader.onchainStats.trades} trades</span></div>
            {vault.trader.paperStats && (
              <>
                <div className="sectiontitle">Paper record (separate)</div>
                <div className="kv"><span className="k">Paper PnL</span><span className="v">{fmtSol(vault.trader.paperStats.pnlSol)} ◎ · {vault.trader.paperStats.winRatePct.toFixed(0)}% wins</span></div>
                <div className="dimtx" style={{ fontSize: 11.5 }}>Simulated fills — not comparable to live results.</div>
              </>
            )}
          </div>
        </div>

        <div className="sg-body">
          {vault.thesis && (
            <div className="panel panel-pad" style={{ marginBottom: 16 }}>
              <div className="sectiontitle" style={{ marginTop: 0 }}>Thesis</div>
              <p className="mutedtx" style={{ margin: 0 }}>{vault.thesis}</p>
            </div>
          )}

          <div className="sectiontitle">Open positions</div>
          <div className="panel">
            <PositionsTable positions={positions} />
          </div>

          <div className="sectiontitle">Trade tape</div>
          <div className="panel">
            <TradeTape trades={trades} showLag={vault.type === "mirror"} />
          </div>
        </div>
      </div>
    </>
  );
}
