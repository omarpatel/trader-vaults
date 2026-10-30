import { Link } from "react-router-dom";
import { fmtSol, type Position } from "@trader-vaults/shared";
import { Delta } from "./bits";
import { AnimatedRow, AnimatedBadge, AnimatedStatus, Skeleton } from "./AnimatedComponents";

/** Never floor a real holding to "0": sub-1 balances (WBTC, WETH) keep
 *  enough precision to stay truthful next to their SOL value. */
function fmtTokenAmount(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  if (v >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (v >= 1) return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return v.toPrecision(3);
}

export function PositionsTable({ positions }: { positions: Position[] }) {
  if (positions.length === 0) {
    return (
      <div className="empty animate-in fade-in duration-300">
        No open positions — vault is in SOL
      </div>
    );
  }

  return (
    <div className="tablewrap">
      <table className="data stack">
        <thead>
          <tr>
            <th>Token</th>
            <th className="r">Amount</th>
            <th className="r">Cost</th>
            <th className="r">Value</th>
            <th className="r">PnL</th>
            <th className="r">Mark</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p, index) => (
            <AnimatedRow 
              key={p.id} 
              index={index}
              onClick={() => window.location.href = `/token/${p.mint}`}
            >
              <td className="lead">
                <Link 
                  to={`/token/${p.mint}`} 
                  className="mono hover:text-blue-400 transition-colors duration-200"
                >
                  {p.symbol}
                </Link>
              </td>
              <td className="r num dimtx" data-label="Amount">
                <span className="tabular-nums">{fmtTokenAmount(p.amountTokens)}</span>
              </td>
              <td className="r num" data-label="Cost">
                <span className="tabular-nums">{fmtSol(p.costSol)} ◎</span>
              </td>
              <td className="r num" data-label="Value">
                <span className="tabular-nums">{fmtSol(p.valueSol)} ◎</span>
              </td>
              <td className="r num" data-label="PnL">
                <div className="flex items-center justify-end gap-2">
                  <span className={p.pnlSol >= 0 ? "pos" : "neg"}>
                    {p.pnlSol >= 0 ? "+" : ""}
                    <span className="tabular-nums">{fmtSol(p.pnlSol)} ◎</span>
                  </span>
                  <Delta v={p.pnlPct} />
                </div>
              </td>
              <td className="r" data-label="Mark">
                {p.markStale ? (
                  <AnimatedBadge variant="warning" pulse>
                    stale
                  </AnimatedBadge>
                ) : (
                  <AnimatedBadge variant="success">
                    live
                  </AnimatedBadge>
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
export function PositionsTableSkeleton() {
  return (
    <div className="tablewrap">
      <table className="data stack">
        <thead>
          <tr>
            <th>Token</th>
            <th className="r">Amount</th>
            <th className="r">Cost</th>
            <th className="r">Value</th>
            <th className="r">PnL</th>
            <th className="r">Mark</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 5 }).map((_, index) => (
            <tr key={index}>
              <td className="lead">
                <Skeleton width={80} height={20} />
              </td>
              <td className="r num" data-label="Amount">
                <Skeleton width={60} height={20} />
              </td>
              <td className="r num" data-label="Cost">
                <Skeleton width={70} height={20} />
              </td>
              <td className="r num" data-label="Value">
                <Skeleton width={70} height={20} />
              </td>
              <td className="r num" data-label="PnL">
                <Skeleton width={80} height={20} />
              </td>
              <td className="r" data-label="Mark">
                <Skeleton width={50} height={24} variant="rectangular" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
