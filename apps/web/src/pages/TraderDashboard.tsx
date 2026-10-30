import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  fmtSol,
  fmtPct,
  VEST_LOCK_DAYS,
  type Vault,
  type VestedFeeSummary,
} from "@trader-vaults/shared";
import { api, type VaultDetail } from "../lib/api";
import { EquityChart, Stat, StatusPill, TypePill } from "../components/bits";
import { usePageTitle } from "../lib/hooks";
import { TradeTape } from "../components/TradeTape";

/** "in 59d 4h" / "in 3h 12m" — a countdown, not a timestamp. */
function countdown(unlocksAt: number, nowSec: number): string {
  const left = unlocksAt - nowSec;
  if (left <= 0) return "unlocked";
  const d = Math.floor(left / 86_400);
  const h = Math.floor((left % 86_400) / 3_600);
  const m = Math.floor((left % 3_600) / 60);
  if (d > 0) return `in ${d}d ${h}h`;
  if (h > 0) return `in ${h}h ${m}m`;
  return `in ${m}m`;
}

function fmtDate(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Trader side. P0 shows the demo trader's first vault; real auth maps the
 * signed-in user to their vaults.
 */
export function TraderDashboard() {
  usePageTitle("My vault");
  const [vaults, setVaults] = useState<Vault[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<VaultDetail | null>(null);

  useEffect(() => {
    api.vaults().then((vs) => {
      setVaults(vs);
      if (vs.length > 0) setSelected(vs[0]!.id);
    }).catch(() => setVaults([]));
  }, []);

  useEffect(() => {
    if (!selected) return;
    setDetail(null);
    api.vault(selected).then(setDetail).catch(() => {});
  }, [selected]);

  const pendingOut = useMemo(
    () => detail?.pendingWithdrawals.reduce((s, w) => s + w.valueAtRequestSol, 0) ?? 0,
    [detail],
  );

  // ── escrowed fees ────────────────────────────────────────────────
  // Scoped to the trader of the vault on screen, which is how the rest
  // of the API resolves identity here.
  const traderId = detail?.vault.trader.id;
  const [vested, setVested] = useState<VestedFeeSummary | null>(null);
  const [vestErr, setVestErr] = useState<string | null>(null);
  const [claiming, setClaiming] = useState<string | null>(null);
  // Ticks once a minute so the countdowns move and a tranche that matures
  // while the page is open becomes claimable without a reload.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const iv = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 60_000);
    return () => clearInterval(iv);
  }, []);

  const loadVested = useCallback(() => {
    if (!traderId) return;
    api
      .vested(traderId)
      .then((v) => {
        setVested(v);
        setVestErr(null);
      })
      .catch((e) => setVestErr(e instanceof Error ? e.message : "failed"));
  }, [traderId]);

  useEffect(() => {
    setVested(null);
    loadVested();
  }, [loadVested]);

  async function claim(id: string) {
    setClaiming(id);
    try {
      const r = await api.claimVested(id);
      setVested(r.summary);
      setVestErr(null);
    } catch (e) {
      setVestErr(e instanceof Error ? e.message : "claim failed");
    } finally {
      setClaiming(null);
    }
  }

  if (!vaults) return <div className="empty">Loading…</div>;
  if (vaults.length === 0)
    return (
      <div className="empty">
        You don't run a vault yet — <Link to="/create">create one</Link>. Zero SOL required.
      </div>
    );

  const vault = detail?.vault;

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>My vault</h1>
          <div className="sub">The trader side: what you manage, what's pending against you, where your fees stand.</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Link to="/settings/profile" className="btn ghost sm">Edit profile</Link>
          <Link to="/create" className="btn sm">+ New vault</Link>
        </div>
        <div className="chipsrow">
          {vaults.slice(0, 6).map((v) => (
            <button key={v.id} className={`chip ${selected === v.id ? "on" : ""}`} onClick={() => setSelected(v.id)}>
              {v.name}
            </button>
          ))}
        </div>
      </div>

      {!vault ? (
        <div className="empty">Loading vault…</div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
            <span className={`pill ${vault.mode}`}>{vault.mode === "real" ? "on-chain" : "paper"}</span>
            <TypePill type={vault.type} />
            <StatusPill status={vault.status} />
            <span className="dimtx mono" style={{ fontSize: 12 }}>
              perf fee {(vault.perfFeeBps / 100).toFixed(0)}% · window {vault.redeemWindowHours}h
            </span>
            <div style={{ flex: 1 }} />
            <Link to={`/vault/${vault.id}`} className="btn ghost sm">Public page ↗</Link>
            <Link to={vault.mode === "paper" ? "/paper" : "/terminal"} className="btn primary sm">
              Open {vault.mode === "paper" ? "paper " : ""}terminal
            </Link>
          </div>

          <div className="statrow" style={{ marginBottom: 16 }}>
            <Stat k="TVL" v={`${fmtSol(vault.tvlSol, 0)} ◎`} d={`${vault.stats.depositorCount} depositors`} />
            <Stat k="30d return" v={fmtPct(vault.stats.pnlPct30d)} tone={vault.stats.pnlPct30d >= 0 ? "pos" : "neg"} />
            <Stat k="Your stake" v={`${fmtSol(vault.managerStakeSol)} ◎`} d={`${vault.managerStakePct.toFixed(1)}% of TVL`} />
            <Stat k="SOL buffer" v={`${fmtSol(vault.solBufferSol)} ◎`} d="covers instant exits" />
            <Stat
              k="Fees paid out"
              v={`${fmtSol(vault.traderFeesAccruedSol)} ◎`}
              d="perf fee already yours"
              tone={vault.traderFeesAccruedSol > 0 ? "pos" : undefined}
            />
            <Stat
              k="Fees vesting"
              v={`${fmtSol(vault.vestedFeesAccruedSol)} ◎`}
              d={`escrowed ${VEST_LOCK_DAYS}d`}
            />
            <Stat
              k="Pending withdrawals"
              v={`${fmtSol(pendingOut)} ◎`}
              d={pendingOut > vault.solBufferSol ? "unwind needed" : "buffer covers it"}
              tone={pendingOut > vault.solBufferSol ? "neg" : undefined}
            />
          </div>

          {pendingOut > vault.solBufferSol && (
            <div className="callout red" style={{ marginBottom: 16 }}>
              Withdrawal requests exceed the SOL buffer — unwind{" "}
              <span className="num">{fmtSol(pendingOut - vault.solBufferSol)} ◎</span> of positions before
              the window closes, or the program will settle from forced position marks.
            </div>
          )}

          <div className="grid2">
            <div className="panel panel-pad">
              <div className="sectiontitle" style={{ marginTop: 0 }}>Equity</div>
              <EquityChart points={vault.equityCurve} height={180} />
            </div>
            <div className="panel panel-pad">
              <div className="sectiontitle" style={{ marginTop: 0 }}>
                Risk limits <span className="pill neutral" style={{ marginLeft: 6 }}>program defaults — enforced on-chain</span>
              </div>
              <div className="kv"><span className="k">Max trade notional</span><span className="v">10% of TVL</span></div>
              <div className="kv"><span className="k">Max price impact</span><span className="v">3%</span></div>
              <div className="kv"><span className="k">Daily loss breaker</span><span className="v">−15% → auto-freeze</span></div>
              <div className="kv"><span className="k">Kill switch</span><span className="v">trades only, never withdrawals</span></div>
              <p className="dimtx" style={{ fontSize: 12, marginBottom: 0 }}>
                These are the vault program's default parameters (programs/vault). They bind when
                the program is live — the ledger demo doesn't enforce them, and this label says so.
              </p>
            </div>
          </div>

          <div className="sectiontitle">Locked earnings</div>
          <div className="panel panel-pad">
            <div className="kv">
              <span className="k">Locked</span>
              <span className="v">{fmtSol(vested?.lockedSol ?? 0)} ◎</span>
            </div>
            <div className="kv">
              <span className="k">Claimable now</span>
              <span className="v" style={(vested?.claimableSol ?? 0) > 0 ? { color: "var(--pos)" } : undefined}>
                {fmtSol(vested?.claimableSol ?? 0)} ◎
              </span>
            </div>
            <div className="kv">
              <span className="k">Next unlock</span>
              <span className="v">
                {vested?.nextUnlockAt
                  ? `${fmtDate(vested.nextUnlockAt)} · ${countdown(vested.nextUnlockAt, now)}`
                  : "—"}
              </span>
            </div>
            {(vested?.claimedSol ?? 0) > 0 && (
              <div className="kv">
                <span className="k">Already claimed</span>
                <span className="v">{fmtSol(vested!.claimedSol)} ◎</span>
              </div>
            )}
            <div className="kv">
              <span className="k">Escrow wallet</span>
              <span className="v mono" style={{ fontSize: 12 }}>
                {vested?.escrowWallet ?? "not configured"}
              </span>
            </div>

            {vestErr && <div className="callout red" style={{ marginTop: 12 }}>{vestErr}</div>}

            {!vested ? (
              <p className="dimtx" style={{ fontSize: 12 }}>Loading…</p>
            ) : vested.tranches.length === 0 ? (
              <p className="dimtx" style={{ fontSize: 12, marginBottom: 0 }}>
                Nothing vesting yet. A third of every performance fee lands here the moment profit
                crystallizes on a withdrawal, and unlocks {VEST_LOCK_DAYS} days later.
              </p>
            ) : (
              <div style={{ marginTop: 12 }}>
                {vested.tranches.map((t) => {
                  const claimable = t.status === "claimable";
                  const claimed = t.status === "claimed";
                  return (
                    <div key={t.id} className="kv">
                      <span className="k">
                        {fmtSol(t.amountSol)} ◎ · {t.vaultName}
                        <span className="dimtx" style={{ marginLeft: 8, fontSize: 11.5 }}>
                          {claimed
                            ? `claimed ${t.claimedAt ? fmtDate(t.claimedAt) : ""}`
                            : `unlocks ${fmtDate(t.unlocksAt)} · ${countdown(t.unlocksAt, now)}`}
                        </span>
                      </span>
                      <span className="v">
                        <button
                          className="btn sm"
                          disabled={!claimable || claiming === t.id}
                          title={
                            claimed
                              ? "Already claimed"
                              : claimable
                                ? "Claim this tranche"
                                : `Locked until ${fmtDate(t.unlocksAt)} — ${VEST_LOCK_DAYS} days after it crystallized`
                          }
                          onClick={() => void claim(t.id)}
                        >
                          {claiming === t.id ? "…" : claimed ? "Claimed" : claimable ? "Claim" : "Locked"}
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            <p className="dimtx" style={{ fontSize: 12, marginBottom: 0 }}>
              You earn {(vault.perfFeeBps / 100).toFixed(0)}% of profit; two thirds is paid on exit
              and the last third waits here for {VEST_LOCK_DAYS} days. That delay is what lets
              depositors trust a track record they can't yet verify — it means you can't blow up a
              vault and walk off with the whole fee the same day.
              {vault.mode === "real" && (
                <>
                  {" "}
                  <strong>Vesting is not live on real vaults yet:</strong> the deployed
                  program pays your full fee on exit, so nothing accrues here for them
                  until escrow ships. The platform takes no cut either way — that part
                  is already true on chain.
                </>
              )}
            </p>
          </div>

          <div className="sectiontitle">Recent trades</div>
          <div className="panel">
            <TradeTape trades={detail?.trades.slice(0, 15) ?? []} showLag={vault.type === "mirror"} />
          </div>
        </>
      )}
    </>
  );
}
