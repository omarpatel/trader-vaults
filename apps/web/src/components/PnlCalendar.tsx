import { useMemo, useState } from "react";
import { fmtSol, type PnlDay } from "@trader-vaults/shared";

/**
 * Daily realized pnl as a grid of squares.
 *
 * An equity curve says where a trader ended up. This says how they got
 * there — whether the number came from one lucky day or from grinding, and
 * how often they trade at all. For a platform whose entire pitch is "back
 * the best traders", consistency is the thing a depositor most needs to see
 * and the thing a curve hides best.
 *
 * Colour encodes size relative to the trader's own best/worst day, so a
 * quiet vault isn't rendered as a flat grey slab.
 */

const DAY_MS = 86_400_000;

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function PnlCalendar({ days, weeks = 26 }: { days: PnlDay[]; weeks?: number }) {
  const byDate = useMemo(() => new Map(days.map((d) => [d.date, d])), [days]);
  const [hover, setHover] = useState<PnlDay | null>(null);

  const { cells, totals } = useMemo(() => {
    // end on the most recent Saturday so every column is a full week
    const today = new Date();
    const endMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    const endDow = new Date(endMs).getUTCDay();
    const gridEnd = endMs + (6 - endDow) * DAY_MS;
    const gridStart = gridEnd - (weeks * 7 - 1) * DAY_MS;

    const out: { date: string; day: PnlDay | null; future: boolean }[] = [];
    let best = 0;
    let worst = 0;
    let sum = 0;
    let traded = 0;

    for (let ms = gridStart; ms <= gridEnd; ms += DAY_MS) {
      const date = isoDay(ms);
      const day = byDate.get(date) ?? null;
      if (day) {
        best = Math.max(best, day.realizedSol);
        worst = Math.min(worst, day.realizedSol);
        sum += day.realizedSol;
        traded += 1;
      }
      out.push({ date, day, future: ms > endMs });
    }
    return { cells: out, totals: { best, worst, sum, traded } };
  }, [byDate, weeks]);

  // scale each side independently — a trader with one huge win shouldn't
  // have every losing day flattened to invisible
  const scale = (v: number): number => {
    if (v === 0) return 0;
    const ref = v > 0 ? totals.best : Math.abs(totals.worst);
    if (ref <= 0) return 0.35;
    return Math.min(1, Math.max(0.22, Math.abs(v) / ref));
  };

  const columns: typeof cells[] = [];
  for (let i = 0; i < cells.length; i += 7) columns.push(cells.slice(i, i + 7));

  return (
    <div className="pnlcal">
      <div className="pnlcal-grid">
        {columns.map((col, ci) => (
          <div className="pnlcal-col" key={ci}>
            {col.map((c) => {
              const v = c.day?.realizedSol ?? 0;
              const a = scale(v);
              const bg = c.future
                ? "transparent"
                : !c.day
                  ? "var(--panel-3)"
                  : v >= 0
                    ? `rgba(47, 217, 128, ${a})`
                    : `rgba(255, 79, 88, ${a})`;
              return (
                <div
                  key={c.date}
                  className={`pnlcal-cell ${c.future ? "future" : ""}`}
                  style={{ background: bg }}
                  onMouseEnter={() => c.day && setHover(c.day)}
                  onMouseLeave={() => setHover(null)}
                  title={
                    c.future
                      ? ""
                      : c.day
                        ? `${c.date}: ${c.day.realizedSol >= 0 ? "+" : ""}${fmtSol(c.day.realizedSol)} ◎ · ${c.day.trades} closed`
                        : `${c.date}: nothing closed`
                  }
                />
              );
            })}
          </div>
        ))}
      </div>

      <div className="pnlcal-foot">
        {hover ? (
          <span className="mono">
            {hover.date} ·{" "}
            <span className={hover.realizedSol >= 0 ? "pos" : "neg"}>
              {hover.realizedSol >= 0 ? "+" : ""}
              {fmtSol(hover.realizedSol)} ◎
            </span>{" "}
            <span className="dimtx">
              · {hover.wins}/{hover.trades} closed green
            </span>
          </span>
        ) : (
          <span className="dimtx">
            {totals.traded === 0
              ? "No closed trades in this window"
              : `${totals.traded} active ${totals.traded === 1 ? "day" : "days"} · net ${totals.sum >= 0 ? "+" : ""}${fmtSol(totals.sum)} ◎`}
          </span>
        )}
        <span className="pnlcal-key dimtx">
          loss
          <i style={{ background: "rgba(255,79,88,0.85)" }} />
          <i style={{ background: "var(--panel-3)" }} />
          <i style={{ background: "rgba(47,217,128,0.85)" }} />
          profit
        </span>
      </div>
      {/* a blank square means nothing CLOSED that day — the vault may well
          have been holding through it */}
      <div className="pnlcal-note">
        Realized only. A blank day means nothing was closed, not that nothing was held.
      </div>
    </div>
  );
}
