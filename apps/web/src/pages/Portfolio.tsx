import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fmtSol, type Holding } from "@trader-vaults/shared";
import { api, type PortfolioView } from "../lib/api";
import { CountStat, Delta, Stat, TypePill } from "../components/bits";
import { Histogram, type HistogramBucket } from "../components/Histogram";
import { useAuth } from "../lib/auth";
import { usePageTitle, usePoll } from "../lib/hooks";
import { renderShareCard } from "../lib/sharecard";
import { useToast } from "../lib/toast";

function countdown(ts: number): string {
  const s = ts - Math.floor(Date.now() / 1000);
  if (s <= 0) return "ready";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}

/** GMGN-style buckets, most-positive → most-negative. 0% counts as green. */
const BUCKET_DEFS: { label: string; tone: "pos" | "neg"; test: (p: number) => boolean }[] = [
  { label: ">+100%", tone: "pos", test: (p) => p > 100 },
  { label: "+25..100%", tone: "pos", test: (p) => p > 25 && p <= 100 },
  { label: "0..+25%", tone: "pos", test: (p) => p >= 0 && p <= 25 },
  { label: "0..-25%", tone: "neg", test: (p) => p < 0 && p >= -25 },
  { label: "<-25%", tone: "neg", test: (p) => p < -25 },
];

function bucketHoldings(holdings: Holding[]): HistogramBucket[] {
  return BUCKET_DEFS.map((d) => ({
    label: d.label,
    tone: d.tone,
    count: holdings.filter((h) => d.test(h.pnlPct)).length,
  }));
}

interface ShareState {
  url: string;
  blob: Blob;
  vaultName: string;
}

export function Portfolio() {
  usePageTitle("Portfolio");
  const toast = useToast();
  const { user, wallet } = useAuth();

  // Portfolio is per-caller now: the API returns an empty one rather than the
  // shared demo account's rows when it cannot identify you.
  const authTokens = useCallback(async () => {
    if (!wallet) return undefined;
    const accessToken = await wallet.getAccessToken();
    return { accessToken, identityToken: wallet.identityToken };
  }, [wallet]);
  const [busy, setBusy] = useState<string | null>(null);
  const [sharing, setSharing] = useState<string | null>(null);
  const [share, setShare] = useState<ShareState | null>(null);
  const { data: view, error, setData } = usePoll<PortfolioView>(
    async () => api.portfolio(await authTokens()),
    15_000,
    [wallet?.address],
  );

  useEffect(() => {
    if (!share) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        URL.revokeObjectURL(share.url);
        setShare(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [share]);

  function closeShare() {
    if (share) URL.revokeObjectURL(share.url);
    setShare(null);
  }

  function downloadCard(url: string) {
    const a = document.createElement("a");
    a.href = url;
    a.download = "trader-vaults-pnl.png";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function copyCard(blob: Blob) {
    try {
      if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
        throw new Error("unsupported");
      }
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast("good", "Card copied to clipboard as PNG");
    } catch {
      toast("info", "Clipboard image copy unavailable — use the downloaded PNG");
    }
  }

  async function shareHolding(h: Holding) {
    setSharing(h.vaultId);
    try {
      const blob = await renderShareCard({
        vaultName: h.vaultName,
        pnlPct: h.pnlPct,
        pnlSol: h.pnlSol,
        sinceLabel: `as of ${new Date().toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        })}`,
        handle: user?.handle ?? "you",
      });
      const url = URL.createObjectURL(blob);
      if (share) URL.revokeObjectURL(share.url);
      setShare({ url, blob, vaultName: h.vaultName });
      downloadCard(url);
      void copyCard(blob);
    } catch (e) {
      toast("bad", e instanceof Error ? e.message : "share card render failed");
    } finally {
      setSharing(null);
    }
  }

  async function execute(id: string) {
    setBusy(id);
    try {
      const r = await api.executeWithdrawal(id);
      toast(
        "good",
        r.fees && r.fees.profitSol > 0
          ? `Paid ${fmtSol(r.paidSol)} ◎ — profit ${fmtSol(r.fees.profitSol)}, performance fee ${fmtSol(r.fees.perfFeeSol)} (trader ${fmtSol(r.fees.traderFeeSol)} now, ${fmtSol(r.fees.traderVestedSol)} vested)`
          : `Withdrawal paid: ${fmtSol(r.paidSol)} ◎ (worse-of rule, no profit → no fees)`,
      );
      const fresh = await api.portfolio(await authTokens());
      setData(fresh);
    } catch (e) {
      toast("bad", e instanceof Error ? e.message : "execution failed");
    } finally {
      setBusy(null);
    }
  }

  if (error && !view) return <div className="callout red">Couldn't load portfolio: {error}</div>;
  if (!view) return <div className="empty">Loading portfolio…</div>;

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Portfolio</h1>
          <div className="sub">Marks degrade to stale, never to wrong — stale values are labeled. Live, refreshes 15s.</div>
        </div>
      </div>

      <div className="statrow" style={{ marginBottom: 20 }}>
        <CountStat k="Total value" value={view.totalValueSol} fmt={(n) => `${fmtSol(n)} ◎`} />
        <CountStat
          k="Total PnL"
          value={view.totalPnlSol}
          fmt={(n) => `${n >= 0 ? "+" : ""}${fmtSol(n)} ◎`}
          tone={view.totalPnlSol >= 0 ? "pos" : "neg"}
        />
        <Stat k="Vaults" v={String(view.holdings.length)} />
        <Stat k="Pending withdrawals" v={String(view.pendingWithdrawals.length)} />
      </div>

      {view.holdings.length > 0 && (
        <>
          <div className="sectiontitle">PnL distribution</div>
          <div className="panel panel-pad" style={{ marginBottom: 20 }}>
            <Histogram buckets={bucketHoldings(view.holdings)} />
            <div
              className="dimtx"
              style={{ fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase", marginTop: 8 }}
            >
              {view.holdings.length} vault{view.holdings.length === 1 ? "" : "s"} bucketed by
              unrealized PnL %
            </div>
          </div>
        </>
      )}

      <div className="sectiontitle">Holdings</div>
      <div className="panel" style={{ marginBottom: 20 }}>
        {view.holdings.length === 0 ? (
          <div className="empty">
            No vault holdings yet — <Link to="/explore">explore vaults</Link> to start.
          </div>
        ) : (
          <div className="tablewrap">
            <table className="data stack">
              <thead>
                <tr>
                  <th>Vault</th>
                  <th className="r">Shares</th>
                  <th className="r">Cost</th>
                  <th className="r">Value</th>
                  <th className="r">PnL</th>
                  <th className="r"></th>
                </tr>
              </thead>
              <tbody>
                {view.holdings.map((h) => (
                  <tr key={h.vaultId}>
                    <td className="lead">
                      <Link to={`/vault/${h.vaultId}`}>{h.vaultName}</Link>{" "}
                      <TypePill type={h.vaultType} />
                    </td>
                    <td className="r num dimtx" data-label="Shares">{fmtSol(h.shares)}</td>
                    <td className="r num" data-label="Cost">{fmtSol(h.costSol)} ◎</td>
                    <td className="r num" data-label="Value">{fmtSol(h.valueSol)} ◎</td>
                    <td className="r num" data-label="PnL">
                      <span className={h.pnlSol >= 0 ? "pos" : "neg"}>
                        {h.pnlSol >= 0 ? "+" : ""}
                        {fmtSol(h.pnlSol)} ◎
                      </span>{" "}
                      <Delta v={h.pnlPct} />
                    </td>
                    <td className="r act">
                      <button
                        className="btn sm ghost"
                        disabled={sharing === h.vaultId}
                        onClick={() => void shareHolding(h)}
                        title="Render a PnL card, download + copy it"
                      >
                        {sharing === h.vaultId ? "…" : "Share"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="sectiontitle">Pending withdrawals</div>
      <div className="panel">
        {view.pendingWithdrawals.length === 0 ? (
          <div className="empty">Nothing pending</div>
        ) : (
          <div className="tablewrap">
            <table className="data stack">
              <thead>
                <tr>
                  <th>Vault</th>
                  <th className="r">Shares</th>
                  <th className="r">Value at request</th>
                  <th className="r">Window</th>
                  <th className="r">Payout rule</th>
                  <th className="r"></th>
                </tr>
              </thead>
              <tbody>
                {view.pendingWithdrawals.map((w) => {
                  const ready = w.executableAt <= Date.now() / 1000;
                  return (
                    <tr key={w.id}>
                      <td className="lead">
                        <Link to={`/vault/${w.vaultId}`}>
                          {view.holdings.find((h) => h.vaultId === w.vaultId)?.vaultName ??
                            `${w.vaultId.slice(0, 8)}…`}
                        </Link>
                      </td>
                      <td className="r num" data-label="Shares">{fmtSol(w.shares)}</td>
                      <td className="r num" data-label="Value at request">{fmtSol(w.valueAtRequestSol)} ◎</td>
                      <td className="r num" data-label="Window">
                        {ready ? <span className="pos">ready</span> : countdown(w.executableAt)}
                      </td>
                      <td className="r dimtx" data-label="Payout rule">worse-of</td>
                      <td className="r act">
                        <button
                          className="btn sm"
                          disabled={!ready || busy === w.id}
                          onClick={() => void execute(w.id)}
                        >
                          {busy === w.id ? "…" : "Execute"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {share && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Share card preview for ${share.vaultName}`}
          onClick={closeShare}
          className="modal-backdrop"
        >
          <div
            className="modal-card"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 640, background: "var(--paper)", padding: 14 }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                gap: 10,
                marginBottom: 10,
                fontSize: 10.5,
                letterSpacing: "0.16em",
                textTransform: "uppercase",
              }}
            >
              <span style={{ color: "var(--amber)" }}>// share card</span>
              <span className="dimtx">{share.vaultName}</span>
            </div>
            <img
              src={share.url}
              alt={`PnL share card for ${share.vaultName}`}
              style={{ width: "100%", display: "block", border: "1px solid var(--line-2)" }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12, flexWrap: "wrap" }}>
              <button className="btn sm primary" onClick={() => downloadCard(share.url)}>
                Download
              </button>
              <button className="btn sm" onClick={() => void copyCard(share.blob)}>
                Copy PNG
              </button>
              <button className="btn sm ghost" onClick={closeShare}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
