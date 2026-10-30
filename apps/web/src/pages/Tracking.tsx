import { Fragment, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fmtSol, shortAddr, solscanTx, type TrackedWallet } from "@trader-vaults/shared";
import { api } from "../lib/api";
import { AddressChip } from "../components/bits";
import { usePageTitle } from "../lib/hooks";
import { useToast } from "../lib/toast";

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
  return <span className={`pill ${cls}`} title={w.scannedAt ? `scanned ${ago(w.scannedAt)}` : "never scanned"}>{label}</span>;
}

export function Tracking() {
  usePageTitle("Wallet tracking");
  const toast = useToast();
  const [wallets, setWallets] = useState<TrackedWallet[] | null>(null);
  const [addr, setAddr] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api
      .trackedWallets()
      .then(setWallets)
      .catch((e) => setError(e instanceof Error ? e.message : "failed"));

  useEffect(() => {
    void load();
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (addr.trim().length < 32) return;
    setBusy(true);
    setError(null);
    try {
      const w = await api.trackWallet(addr.trim(), label.trim() || undefined);
      toast(
        w.stats.trades > 0
          ? "good"
          : "info",
        w.stats.trades > 0
          ? `Scanned ${shortAddr(w.address)}: ${w.stats.trades} swaps found`
          : `Tracking ${shortAddr(w.address)} — no recent swaps detected`,
      );
      setAddr("");
      setLabel("");
      await load();
      setExpanded(w.address);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  async function rescan(address: string) {
    setScanning(address);
    try {
      const w = await api.scanWallet(address, true);
      toast("good", `Re-scanned ${shortAddr(address)}: ${w.stats.trades} swaps in window`);
      await load();
    } catch (e) {
      toast("bad", e instanceof Error ? e.message : "scan failed");
    } finally {
      setScanning(null);
    }
  }

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Wallet tracking</h1>
          <div className="sub">
            Paste any mainnet wallet — activity is scanned from chain via balance-diff classification,
            not self-reported. A wallet worth following is a mirror vault waiting to happen.
          </div>
        </div>
      </div>

      <form onSubmit={(e) => void add(e)} className="panel panel-pad" style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 20 }}>
        <div className="field" style={{ flex: "1 1 340px", marginBottom: 0 }}>
          <label>Wallet address (mainnet)</label>
          <input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="paste any Solana wallet…" spellCheck={false} />
        </div>
        <div className="field" style={{ flex: "0 1 180px", marginBottom: 0 }}>
          <label>Label</label>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="optional" />
        </div>
        <button className="btn primary" disabled={busy || addr.trim().length < 32}>
          {busy ? "scanning…" : "Track + scan"}
        </button>
      </form>

      {error && <div className="callout red" style={{ marginBottom: 16 }}>{error}</div>}
      {!wallets ? (
        <div className="empty">Loading tracked wallets…</div>
      ) : (
        <div className="panel">
          <div className="tablewrap">
            <table className="data">
              <thead>
                <tr>
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
                {wallets.map((w) => (
                  <Fragment key={w.address}>
                    <tr style={{ cursor: "pointer" }} onClick={() => setExpanded(expanded === w.address ? null : w.address)}>
                      <td>
                        <AddressChip addr={w.address} label={w.label} />
                      </td>
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
                      <td className="r" onClick={(e) => e.stopPropagation()}>
                        <button
                          className="btn ghost sm"
                          disabled={scanning === w.address}
                          onClick={() => void rescan(w.address)}
                        >
                          {scanning === w.address ? "…" : "scan"}
                        </button>{" "}
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
                    {expanded === w.address && (
                      <tr>
                        <td colSpan={7} style={{ background: "var(--ink)", padding: "10px 16px" }}>
                          {!w.recentSwaps || w.recentSwaps.length === 0 ? (
                            <span className="dimtx" style={{ fontSize: 12 }}>
                              No swaps detected in the scan window
                              {(w.scanStatus ?? "unscanned") === "unscanned" ? " — hit scan to read the chain" : ""}.
                            </span>
                          ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                              {w.recentSwaps.slice(0, 8).map((s) => (
                                <div key={s.txSig} className="mono" style={{ fontSize: 12, display: "flex", gap: 12 }}>
                                  <span className="dimtx" style={{ width: 64 }}>{ago(s.ts)}</span>
                                  <span className={s.side === "buy" ? "pos" : "neg"} style={{ width: 38 }}>
                                    {s.side.toUpperCase()}
                                  </span>
                                  <span style={{ width: 90 }}>{s.symbol ?? shortAddr(s.mint, 4)}</span>
                                  <span className="num" style={{ width: 90, textAlign: "right" }}>{fmtSol(s.solAmount)} ◎</span>
                                  <a className="dimtx" href={solscanTx(s.txSig)} target="_blank" rel="noreferrer">
                                    {shortAddr(s.txSig, 4)}
                                  </a>
                                </div>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
