/** Market micro-widgets: buy/sell ratio bars, bonding rings, timeframe strips. */
import type { TokenPoolStats } from "@trader-vaults/shared";

/** Green-vs-red split bar with counts — the paired-pressure pattern. */
export function RatioBar({
  a,
  b,
  labelA = "B",
  labelB = "S",
  width = 110,
}: {
  a: number;
  b: number;
  labelA?: string;
  labelB?: string;
  width?: number;
}) {
  const total = a + b;
  const fa = total > 0 ? a / total : 0.5;
  return (
    <span className="ratiobar" style={{ width }} title={`${labelA} ${a} / ${labelB} ${b}`}>
      <span className="nums">
        <span className="pos num">{a}</span>
        <span className="neg num">{b}</span>
      </span>
      <span className="bar">
        <span style={{ width: `${fa * 100}%` }} />
      </span>
    </span>
  );
}

/** Bonding-curve progress ring around a token avatar (conic gradient). */
export function BondRing({
  pct,
  src,
  size = 40,
}: {
  pct?: number;
  src?: string;
  size?: number;
}) {
  const p = Math.max(0, Math.min(100, pct ?? 0));
  return (
    <span
      className="bondring"
      style={{
        width: size,
        height: size,
        background:
          pct !== undefined
            ? `conic-gradient(var(--amber) ${p * 3.6}deg, var(--line-2) 0deg)`
            : "var(--line-2)",
      }}
      title={pct !== undefined ? `bonding ${p.toFixed(0)}%` : undefined}
    >
      {src ? <img src={src} alt="" loading="lazy" /> : <span className="ph" />}
    </span>
  );
}

/** 5M / 1H / 6H / 24H change chips from pool stats. */
export function TimeframeStrip({ stats }: { stats: TokenPoolStats | null }) {
  const frames: { k: keyof TokenPoolStats["priceChangePct"]; label: string }[] = [
    { k: "m5", label: "5M" },
    { k: "h1", label: "1H" },
    { k: "h6", label: "6H" },
    { k: "h24", label: "24H" },
  ];
  return (
    <div className="tfstrip">
      {frames.map((f) => {
        const v = stats?.priceChangePct[f.k];
        return (
          <div key={f.label} className="tfcell">
            <span className="k">{f.label}</span>
            <span className={`num ${v === undefined ? "dimtx" : v >= 0 ? "pos" : "neg"}`}>
              {v === undefined ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`}
            </span>
          </div>
        );
      })}
    </div>
  );
}
