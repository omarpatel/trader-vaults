import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  fmtPct,
  fmtSol,
  type TraderProfile,
  type TraderStats,
  type Vault,
} from "@trader-vaults/shared";
import { usePageTitle } from "../lib/hooks";
import { Stat } from "../components/bits";
import { VaultCard } from "../components/VaultCard";

interface TraderView {
  trader: TraderProfile;
  vaults: Vault[];
  totals: {
    tvlSol: number;
    depositors: number;
    trades30d: number;
    pnlPct30dWeighted: number;
  };
}

/** One record block (on-chain or paper) rendered as a stat row. */
function RecordStats({ s }: { s: TraderStats }) {
  return (
    <div className="statrow">
      <Stat k="Realized PnL" v={`${fmtSol(s.pnlSol)} ◎`} tone={s.pnlSol >= 0 ? "pos" : "neg"} />
      <Stat k="Win rate" v={`${s.winRatePct.toFixed(0)}%`} />
      <Stat k="Trades" v={String(s.trades)} />
      {s.profitFactor !== undefined && <Stat k="Profit factor" v={s.profitFactor.toFixed(2)} />}
      {s.avgHoldMin !== undefined && <Stat k="Avg hold" v={`${s.avgHoldMin.toFixed(0)}m`} />}
    </div>
  );
}

export function TraderPage() {
  const { handle } = useParams<{ handle: string }>();
  const [data, setData] = useState<TraderView | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!handle) return;
    fetch(`/api/traders/${encodeURIComponent(handle)}`)
      .then(async (res) => {
        if (res.status === 404) {
          setNotFound(true);
          return null;
        }
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return (await res.json()) as TraderView;
      })
      .then((d) => {
        if (d) {
          setData(d);
          setNotFound(false);
          setError(null);
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : "failed"));
  }, [handle]);

  useEffect(() => {
    load();
    const iv = setInterval(() => {
      if (!document.hidden) load();
    }, 15_000);
    return () => clearInterval(iv);
  }, [load]);
  usePageTitle(data ? data.trader.displayName : "Trader");

  if (notFound) {
    return (
      <div className="empty" style={{ padding: "64px 24px" }}>
        No trader <span className="mono">@{handle}</span> on the books.{" "}
        <Link to="/explore">Back to explore</Link>
      </div>
    );
  }
  if (error && !data) return <div className="callout red">Couldn't load trader: {error}</div>;
  if (!data) return <div className="empty">Loading trader…</div>;

  const { trader, vaults, totals } = data;

  return (
    <>
      <div className="pagehead">
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
          <div
            className="avatar"
            style={{
              width: 52,
              height: 52,
              flexShrink: 0,
              background: "var(--panel-3)",
              border: "1px solid var(--line-2)",
              display: "grid",
              placeItems: "center",
              fontFamily: "var(--display)",
              fontSize: 22,
              color: "var(--amber)",
              overflow: "hidden",
            }}
          >
            {trader.avatarUrl ? (
              <img
                src={trader.avatarUrl}
                alt=""
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            ) : (
              trader.handle.slice(0, 1).toUpperCase()
            )}
          </div>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <h1>{trader.displayName}</h1>
              {trader.xVerified && (
                <span className="pill mirror" title="X account linked">
                  𝕏 verified
                </span>
              )}
            </div>
            <div
              className="sub"
              style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}
            >
              <span className="mono">@{trader.handle}</span>
              {trader.xHandle && (
                <a
                  href={`https://x.com/${trader.xHandle}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mono"
                >
                  𝕏 @{trader.xHandle}
                </a>
              )}
              <span>· {vaults.length} vault{vaults.length === 1 ? "" : "s"}</span>
            </div>
            {trader.bio && (
              <div className="sub" style={{ marginTop: 6 }}>
                {trader.bio}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="statrow" style={{ marginBottom: 4 }}>
        <Stat k="TVL managed" v={`${fmtSol(totals.tvlSol, 0)} ◎`} />
        <Stat k="Depositors" v={String(totals.depositors)} d="unique across vaults" />
        <Stat
          k="Weighted 30d"
          v={fmtPct(totals.pnlPct30dWeighted)}
          tone={totals.pnlPct30dWeighted >= 0 ? "pos" : "neg"}
          d={`${totals.trades30d} trades / 30d`}
        />
        <Stat k="Vaults" v={String(vaults.length)} />
      </div>

      <div className="sectiontitle">
        On-chain record
        <span className="pill neutral">recomputed from chain data</span>
      </div>
      <RecordStats s={trader.onchainStats} />

      {trader.paperStats && (
        <>
          <div className="sectiontitle">
            Paper record
            <span className="pill stale">imported</span>
          </div>
          <div className="callout" style={{ marginBottom: 10 }}>
            Simulated fills — not comparable to live results.
          </div>
          <RecordStats s={trader.paperStats} />
        </>
      )}

      <div className="sectiontitle">Vaults</div>
      {vaults.length === 0 ? (
        <div className="empty">
          No vaults yet — <Link to="/explore">back to explore</Link>
        </div>
      ) : (
        <div className="vaultgrid">
          {vaults.map((v) => (
            <VaultCard key={v.id} vault={v} />
          ))}
        </div>
      )}
    </>
  );
}
