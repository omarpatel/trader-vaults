import { shortAddr } from "@trader-vaults/shared";
import { top10Tone, useTokenSecurity } from "../lib/security";

/**
 * The forensics panel behind a discovery card.
 *
 * A board of tokens can only show price and size; what decides whether a
 * token is a trap is who can still mint it, who can freeze your wallet, and
 * how much of the supply sits in ten accounts. That belongs one hover away
 * from the card, not three pages deep.
 *
 * Unknown is rendered as unknown. A rate-limited RPC must never look like
 * a clean bill of health.
 */
export function RiskPop({ mint, bondingPct }: { mint: string; bondingPct?: number }) {
  const { data, loading } = useTokenSecurity(mint);

  const authority = (revoked: boolean | null, label: string) => {
    const tone = revoked === null ? "dim" : revoked ? "pos" : "neg";
    const text = revoked === null ? "unknown" : revoked ? "revoked" : "ACTIVE";
    return (
      <div className="riskrow">
        <span className="k">{label}</span>
        <span className={`v ${tone}`}>{text}</span>
      </div>
    );
  };

  return (
    <div className="riskpop" onClick={(e) => e.stopPropagation()}>
      <div className="riskhead">On-chain checks</div>

      {loading && <div className="riskloading">reading chain…</div>}

      {!loading && !data && <div className="riskloading">no chain data</div>}

      {data && (
        <>
          {authority(data.mintAuthorityRevoked, "Mint authority")}
          {authority(data.freezeAuthorityRevoked, "Freeze authority")}
          <div className="riskrow">
            <span className="k">Top 10 hold</span>
            <span className={`v ${top10Tone(data.top10Pct)}`}>
              {data.top10Pct === null ? "unknown" : `${data.top10Pct.toFixed(1)}%`}
            </span>
          </div>
          {bondingPct !== undefined && (
            <div className="riskrow">
              <span className="k">Bonding curve</span>
              <span className="v">{bondingPct.toFixed(1)}%</span>
            </div>
          )}

          {data.largestHolders.length > 0 && (
            <>
              <div className="riskhead sub">Largest accounts</div>
              {data.largestHolders.slice(0, 4).map((h) => (
                <div className="riskrow" key={h.address}>
                  <span className="k mono">{shortAddr(h.address)}</span>
                  <span className="v">{h.pct.toFixed(1)}%</span>
                </div>
              ))}
              {/* these are token ACCOUNTS: pools and program vaults included,
                  so a big one is not automatically a whale */}
              <div className="risknote">
                Token accounts — pools and program vaults count here too.
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
