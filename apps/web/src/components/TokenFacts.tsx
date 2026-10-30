import { fmtUsd, type TokenInfo, type TokenPoolStats } from "@trader-vaults/shared";
import { top10Tone, useTokenSecurity } from "../lib/security";

/**
 * The facts panel a memecoin terminal is judged on.
 *
 * Everything here is read from chain or from the pool, and anything that
 * couldn't be read says so. The failure mode to avoid is a panel that looks
 * complete while quietly showing zeros for data that never loaded — that
 * reads as "safe" when it means "unknown".
 */
export function TokenFacts({
  mint,
  info,
  stats,
  supplyUi,
  athUsd,
}: {
  mint: string;
  info: TokenInfo | null;
  stats: TokenPoolStats | null;
  supplyUi: number | null;
  /** highest close on the loaded candles — labelled as such, not as all-time */
  athUsd: number | null;
}) {
  const { data: sec, loading } = useTokenSecurity(mint);

  const authority = (revoked: boolean | null | undefined, label: string) => {
    const tone = revoked === null || revoked === undefined ? "dim" : revoked ? "pos" : "neg";
    const text =
      revoked === null || revoked === undefined ? "unknown" : revoked ? "revoked" : "ACTIVE";
    return (
      <div className="factrow">
        <span className="k">{label}</span>
        <span className={`v ${tone}`}>{text}</span>
      </div>
    );
  };

  const num = (v: number | null | undefined, fmt: (n: number) => string) =>
    v === null || v === undefined ? <span className="v dim">unknown</span> : <span className="v">{fmt(v)}</span>;

  return (
    <div className="panel panel-pad factpanel">
      <div className="sectiontitle" style={{ marginTop: 0 }}>Token facts</div>

      <div className="factrow">
        <span className="k">Liquidity</span>
        {num(info?.liquidityUsd, fmtUsd)}
      </div>
      <div className="factrow">
        <span className="k">Market cap</span>
        {num(info?.mcapUsd, fmtUsd)}
      </div>
      <div className="factrow">
        <span className="k">Supply</span>
        {num(supplyUi, (n) => n.toLocaleString(undefined, { maximumFractionDigits: 0 }))}
      </div>
      <div className="factrow">
        <span className="k" title="Highest close on the candles currently loaded — not a lifetime high">
          Period high
        </span>
        {num(athUsd, fmtUsd)}
      </div>
      {stats?.txns.h24 && (
        <div className="factrow">
          <span className="k">24h buys / sells</span>
          <span className="v">
            <span className="pos">{stats.txns.h24.buys}</span>
            <span className="dimtx"> / </span>
            <span className="neg">{stats.txns.h24.sells}</span>
          </span>
        </div>
      )}

      <div className="sectiontitle">Chain checks</div>
      {loading && <div className="factloading">reading chain…</div>}
      {!loading && !sec && <div className="factloading">chain data unavailable</div>}
      {sec && (
        <>
          {authority(sec.mintAuthorityRevoked, "Mint authority")}
          {authority(sec.freezeAuthorityRevoked, "Freeze authority")}
          <div className="factrow">
            <span className="k" title="Share held by the 10 largest token accounts">
              Top 10 hold
            </span>
            <span className={`v ${top10Tone(sec.top10Pct)}`}>
              {sec.top10Pct === null ? "unknown" : `${sec.top10Pct.toFixed(1)}%`}
            </span>
          </div>
          <div className="factnote">
            Largest accounts include pools and program vaults, so concentration
            here is a prompt to look, not a verdict.
          </div>
        </>
      )}
    </div>
  );
}
