import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  fmtSubscriptPrice,
  fmtUsd,
  shortAddr,
  solscanTx,
  type PoolTrade,
  type TokenInfo,
  type TokenPoolStats,
} from "@trader-vaults/shared";
import { api } from "../lib/api";
import { AddressChip, Skeleton, Stat } from "../components/bits";
import { CandleChart, CANDLE_TFS, type CandleTf } from "../components/CandleChart";
import { RatioBar, TimeframeStrip } from "../components/market";
import { useFlash, usePageTitle, usePoll } from "../lib/hooks";

// ── /api/security — local mirror of the API's TokenSecurity shape ──
// (api.ts is shared surface; this endpoint is fetched directly here)

interface SecurityHolder {
  address: string;
  pct: number;
  uiAmount: number;
}

interface TokenSecurity {
  mintAuthorityRevoked: boolean | null;
  freezeAuthorityRevoked: boolean | null;
  decimals: number | null;
  supplyUi: number | null;
  top10Pct: number | null;
  largestHolders: SecurityHolder[];
  fetchedAt: number;
}

async function fetchSecurity(mint: string): Promise<TokenSecurity> {
  const res = await fetch(`/api/security/${mint}`);
  if (!res.ok) throw new Error(`${res.status} for /security/${mint}`);
  return (await res.json()) as TokenSecurity;
}

/** Compact token-amount formatter (93.5T, 4.2B, 12.7M …). */
function fmtAmount(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function AuthorityFlag({ label, revoked }: { label: string; revoked: boolean | null }) {
  return (
    <span className={`rflag ${revoked === true ? "ok" : revoked === false ? "bad" : ""}`}>
      {label} {revoked === true ? "revoked" : revoked === false ? "ACTIVE" : "unknown"}
    </span>
  );
}

export function TokenPage() {
  const { mint = "" } = useParams<{ mint: string }>();

  const { data: info, error } = usePoll<TokenInfo>(() => api.token(mint), 10_000, [mint]);
  const { data: poolStats } = usePoll<TokenPoolStats>(() => api.tokenStats(mint), 30_000, [mint]);
  const { data: poolTape } = usePoll<PoolTrade[]>(() => api.poolTrades(mint), 15_000, [mint]);

  const [security, setSecurity] = useState<TokenSecurity | null>(null);
  const [tf, setTf] = useState<CandleTf>("5m");

  usePageTitle(info?.symbol ?? "Token");
  const priceFlash = useFlash(info?.priceUsd);

  // security once per mint — the server caches it 5 min anyway
  useEffect(() => {
    let alive = true;
    setSecurity(null);
    fetchSecurity(mint)
      .then((s) => alive && setSecurity(s))
      .catch(() => {
        /* strip renders "unknown" */
      });
    return () => {
      alive = false;
    };
  }, [mint]);

  if (error && !info) {
    return <div className="callout red">Couldn't load token: {error}</div>;
  }

  const top10 = security?.top10Pct ?? null;
  const holders = security?.largestHolders ?? [];

  return (
    <>
      {/* ── header ── */}
      <div className="pagehead">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {info?.imageUrl && (
              <img src={info.imageUrl} alt="" width={34} height={34} style={{ borderRadius: "50%" }} />
            )}
            {info ? (
              <h1>
                {info.symbol} <span className="mutedtx" style={{ fontWeight: 400 }}>{info.name}</span>
              </h1>
            ) : (
              <Skeleton h={26} w={240} />
            )}
            {info && (
              <>
                <span
                  className={`price num ${priceFlash === "up" ? "flash-up" : priceFlash === "down" ? "flash-down" : ""}`}
                  style={{ fontSize: 21, fontWeight: 700, padding: "2px 6px" }}
                >
                  {fmtSubscriptPrice(info.priceUsd)}
                </span>
                {info.change24hPct !== undefined && (
                  <span className={`num ${(info.change24hPct ?? 0) >= 0 ? "pos" : "neg"}`}>
                    {(info.change24hPct ?? 0) >= 0 ? "+" : ""}
                    {(info.change24hPct ?? 0).toFixed(1)}%
                  </span>
                )}
              </>
            )}
          </div>
          <div className="sub" style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
            <AddressChip addr={mint} />
            {info?.dex && <span className="pill neutral">{info.dex}</span>}
            <span className="pill neutral">mark src: {info?.source ?? "…"}</span>
          </div>
        </div>
      </div>

      {/* ── vitals ── */}
      <div style={{ display: "flex", gap: 12, alignItems: "stretch", marginBottom: 14, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 280px" }}>
          <TimeframeStrip stats={poolStats ?? null} />
        </div>
        {poolStats?.txns.h24 && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="dimtx mono" style={{ fontSize: 9.5, letterSpacing: "0.14em" }}>TXNS 24H</span>
            <RatioBar a={poolStats.txns.h24.buys} b={poolStats.txns.h24.sells} width={120} />
          </div>
        )}
      </div>
      <div className="statrow" style={{ marginBottom: 20 }}>
        <Stat k="Market cap" v={info?.mcapUsd ? fmtUsd(info.mcapUsd) : "—"} />
        <Stat k="Liquidity" v={info?.liquidityUsd ? fmtUsd(info.liquidityUsd) : "—"} />
        <Stat k="24h volume" v={info?.volume24hUsd ? fmtUsd(info.volume24hUsd) : "—"} />
        <Stat
          k="Supply"
          v={security?.supplyUi != null ? fmtAmount(security.supplyUi) : "—"}
          d={security?.decimals != null ? `${security.decimals} decimals` : undefined}
        />
      </div>

      {/* ── security audit (real on-chain reads) ── */}
      <div className="sectiontitle">Security audit — on-chain</div>
      <div className="riskflags" style={{ marginBottom: 20 }}>
        <AuthorityFlag label="mint auth" revoked={security?.mintAuthorityRevoked ?? null} />
        <AuthorityFlag label="freeze auth" revoked={security?.freezeAuthorityRevoked ?? null} />
        <span className={`rflag ${top10 === null ? "" : top10 < 25 ? "ok" : "warn"}`}>
          top-10 accounts {top10 === null ? "unknown" : `${top10.toFixed(1)}%`}
        </span>
      </div>

      {/* ── chart ── */}
      <div className="panel panel-pad" style={{ marginBottom: 20 }}>
        <div className="tokhead" style={{ marginBottom: 10 }}>
          <span className="mono" style={{ fontSize: 13, fontWeight: 700 }}>
            {info?.symbol ?? shortAddr(mint)} / USD
          </span>
          <span style={{ flex: 1 }} />
          <div className="chipsrow">
            {CANDLE_TFS.map((t) => (
              <button key={t} className={`chip ${tf === t ? "on" : ""}`} onClick={() => setTf(t)}>
                {t}
              </button>
            ))}
          </div>
        </div>
        <CandleChart mint={mint} tf={tf} />
      </div>

      {/* ── largest token accounts ── */}
      <div className="sectiontitle">Largest token accounts</div>
      <div className="panel" style={{ marginBottom: 20 }}>
        {!security ? (
          <div className="empty">Reading token accounts from mainnet…</div>
        ) : holders.length === 0 ? (
          <div className="empty">Largest accounts unavailable (RPC limited) — unknown, not fine</div>
        ) : (
          <div className="tablewrap">
            <table className="data">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Account</th>
                  <th className="r">% supply</th>
                  <th className="r">Amount</th>
                </tr>
              </thead>
              <tbody>
                {holders.map((h, i) => (
                  <tr key={h.address}>
                    <td className="num dimtx">{i + 1}</td>
                    <td><AddressChip addr={h.address} /></td>
                    <td className="r">
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                        <span className="num">{h.pct.toFixed(2)}%</span>
                        <span
                          style={{ width: 90, height: 4, background: "var(--line-2)", display: "inline-block" }}
                          aria-hidden="true"
                        >
                          <span
                            style={{
                              display: "block",
                              height: "100%",
                              width: `${Math.min(100, h.pct)}%`,
                              background: h.pct >= 10 ? "var(--amber)" : "var(--green)",
                            }}
                          />
                        </span>
                      </span>
                    </td>
                    <td className="r num">{fmtAmount(h.uiAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mono dimtx" style={{ fontSize: 10.5, padding: "6px 10px" }}>
          largest token accounts include pools and program vaults — not individual holders
        </div>
      </div>

      {/* ── pool tape ── */}
      <div className="sectiontitle">Pool tape — live on-chain trades</div>
      <div className="panel" style={{ marginBottom: 20 }}>
        {!poolTape || poolTape.length === 0 ? (
          <div className="empty">No recent pool trades surfaced</div>
        ) : (
          <div className="tablewrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Age</th>
                  <th>Side</th>
                  <th className="r">USD</th>
                  <th className="r">Price</th>
                  <th className="r">Wallet</th>
                  <th className="r">Tx</th>
                </tr>
              </thead>
              <tbody>
                {poolTape.slice(0, 10).map((t) => {
                  const age = Math.max(1, Math.floor(Date.now() / 1000 - t.ts));
                  const ageStr =
                    age < 60 ? `${age}s` : age < 3600 ? `${Math.floor(age / 60)}m` : `${Math.floor(age / 3600)}h`;
                  return (
                    <tr key={t.txSig}>
                      <td className="num dimtx">{ageStr}</td>
                      <td>
                        <span className={`num ${t.side === "buy" ? "pos" : "neg"}`}>
                          {t.side.toUpperCase()}
                        </span>
                      </td>
                      <td className="r num">{fmtUsd(t.amountUsd)}</td>
                      <td className="r num dimtx">{fmtUsd(t.priceUsd)}</td>
                      <td className="r num dimtx">{shortAddr(t.wallet, 4)}</td>
                      <td className="r">
                        <a className="num dimtx" href={solscanTx(t.txSig)} target="_blank" rel="noreferrer">
                          {shortAddr(t.txSig, 4)}
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── CTA — carries this token straight into the chart ── */}
      <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
        <Link className="btn primary" to={`/paper?mint=${mint}`}>Paper trade it</Link>
        <Link className="btn" to={`/terminal?mint=${mint}`}>Open in real terminal</Link>
        <Link className="btn ghost" to="/tracking">Track a wallet</Link>
      </div>
    </>
  );
}
