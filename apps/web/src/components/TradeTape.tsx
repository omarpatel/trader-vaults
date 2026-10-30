import { fmtSol, shortAddr, solscanTx, type Trade } from "@trader-vaults/shared";
import { AnimatedRow, AnimatedBadge, Skeleton } from "./AnimatedComponents";

function ago(ts: number): string {
  const s = Math.max(1, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function TradeTape({ trades, showLag }: { trades: Trade[]; showLag?: boolean }) {
  if (trades.length === 0) {
    return (
      <div className="empty animate-in fade-in duration-300">
        No trades yet
      </div>
    );
  }

  return (
    <div className="tablewrap">
      <table className="data stack">
        <thead>
          <tr>
            <th>Age</th>
            <th>Side</th>
            <th>Token</th>
            <th className="r">SOL</th>
            <th className="r">Price</th>
            {showLag && <th className="r">Copy lag</th>}
            <th className="r">Tx</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t, index) => (
            <AnimatedRow key={t.id} index={index}>
              <td className="num dimtx" data-label="Age">
                <span className="tabular-nums">{ago(t.ts)}</span>
              </td>
              <td data-label="Side">
                <AnimatedBadge 
                  variant={t.side === "buy" ? "success" : "error"}
                  className="font-semibold"
                >
                  {t.side.toUpperCase()}
                </AnimatedBadge>
              </td>
              <td className="mono lead">
                <span className="hover:text-blue-400 transition-colors duration-200 cursor-pointer">
                  {t.symbol}
                </span>
              </td>
              <td className="r num" data-label="SOL">
                <span className="tabular-nums">{fmtSol(t.solAmount)}</span>
              </td>
              <td className="r num dimtx" data-label="Price">
                <span className="tabular-nums">{t.priceSol.toExponential(2)}</span>
              </td>
              {showLag && (
                <td className="r num" data-label="Copy lag">
                  {t.copyLagSlots !== undefined && t.copyLagSlots !== null ? (
                    <AnimatedBadge 
                      variant={t.copyLagSlots <= 1 ? "success" : "default"}
                      className="font-mono text-xs"
                    >
                      +{t.copyLagSlots}
                    </AnimatedBadge>
                  ) : (
                    <span className="text-gray-500">—</span>
                  )}
                </td>
              )}
              <td className="r" data-label="Tx">
                {t.txSig.startsWith("demo-") ? (
                  <AnimatedBadge variant="info" pulse>
                    ledger
                  </AnimatedBadge>
                ) : (
                  <a
                    className="mono dimtx hover:text-blue-400 transition-colors duration-200"
                    href={solscanTx(t.txSig)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {shortAddr(t.txSig, 4)}
                  </a>
                )}
              </td>
            </AnimatedRow>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Skeleton Loading State ──────────────────────────────────────────
export function TradeTapeSkeleton({ showLag = false }: { showLag?: boolean }) {
  return (
    <div className="tablewrap">
      <table className="data stack">
        <thead>
          <tr>
            <th>Age</th>
            <th>Side</th>
            <th>Token</th>
            <th className="r">SOL</th>
            <th className="r">Price</th>
            {showLag && <th className="r">Copy lag</th>}
            <th className="r">Tx</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 8 }).map((_, index) => (
            <tr key={index}>
              <td className="num dimtx" data-label="Age">
                <Skeleton width={40} height={20} />
              </td>
              <td data-label="Side">
                <Skeleton width={50} height={24} variant="rectangular" />
              </td>
              <td className="mono lead">
                <Skeleton width={60} height={20} />
              </td>
              <td className="r num" data-label="SOL">
                <Skeleton width={60} height={20} />
              </td>
              <td className="r num dimtx" data-label="Price">
                <Skeleton width={70} height={20} />
              </td>
              {showLag && (
                <td className="r num" data-label="Copy lag">
                  <Skeleton width={40} height={24} variant="rectangular" />
                </td>
              )}
              <td className="r" data-label="Tx">
                <Skeleton width={50} height={24} variant="rectangular" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
