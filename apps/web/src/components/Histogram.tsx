/**
 * Inline-SVG bucket histogram — amber-on-ink brutalist. Bars carry graded
 * opacity: the further a bucket sits from zero, the harder it prints. Each
 * bar gets a solid cap so even faint bars keep a hard edge (no gradients —
 * stepped opacity only, per the design system).
 */

export interface HistogramBucket {
  label: string;
  count: number;
  tone: "pos" | "neg";
}

const SLOT = 96; // horizontal space per bucket
const BAR = 54; // bar width inside the slot

/** 0 = closest to the zero boundary (faintest), grades up toward the extremes. */
function opacityFor(buckets: HistogramBucket[], i: number): number {
  const tone = buckets[i]!.tone;
  const idxs: number[] = [];
  buckets.forEach((b, j) => {
    if (b.tone === tone) idxs.push(j);
  });
  const n = idxs.length;
  if (n <= 1) return 1;
  const k = idxs.indexOf(i);
  // buckets arrive ordered most-positive → most-negative, so for "pos" the
  // first of the group is the extreme; for "neg" it's the last.
  const rank = tone === "pos" ? n - 1 - k : k;
  return 0.4 + (0.6 * rank) / (n - 1);
}

export function Histogram({
  buckets,
  height = 150,
}: {
  buckets: HistogramBucket[];
  height?: number;
}) {
  const width = buckets.length * SLOT;
  const topPad = 26; // room for count labels
  const botPad = 30; // room for bucket labels
  const baseY = height - botPad;
  const maxCount = Math.max(1, ...buckets.map((b) => b.count));
  // dashed amber rule where pos flips to neg — the zero axis
  const zeroIdx = buckets.findIndex((b) => b.tone === "neg");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      style={{ width: "100%", maxWidth: width * 1.3, height: "auto", display: "block" }}
      role="img"
      aria-label={`Histogram of holdings by PnL percent: ${buckets
        .map((b) => `${b.label} ${b.count}`)
        .join(", ")}`}
    >
      {zeroIdx > 0 && (
        <line
          x1={zeroIdx * SLOT}
          x2={zeroIdx * SLOT}
          y1={topPad - 12}
          y2={baseY}
          stroke="var(--amber)"
          strokeWidth="1"
          strokeDasharray="2 5"
          opacity="0.6"
        />
      )}
      {buckets.map((b, i) => {
        const x = i * SLOT + (SLOT - BAR) / 2;
        const cx = i * SLOT + SLOT / 2;
        const h = b.count === 0 ? 0 : Math.max(6, ((baseY - topPad) * b.count) / maxCount);
        const color = b.tone === "pos" ? "var(--green)" : "var(--red)";
        return (
          <g key={b.label}>
            {b.count > 0 ? (
              <>
                <rect
                  x={x}
                  y={baseY - h}
                  width={BAR}
                  height={h}
                  fill={color}
                  fillOpacity={opacityFor(buckets, i)}
                />
                {/* hard cap — full-strength top edge */}
                <rect x={x} y={baseY - h} width={BAR} height={3} fill={color} />
              </>
            ) : (
              <rect x={x} y={baseY - 2} width={BAR} height={2} fill="var(--line-2)" />
            )}
            <text
              x={cx}
              y={baseY - h - 8}
              textAnchor="middle"
              fill={b.count > 0 ? color : "var(--dim)"}
              style={{
                fontFamily: "var(--mono)",
                fontSize: 12.5,
                fontWeight: 700,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {b.count}
            </text>
            <text
              x={cx}
              y={height - 9}
              textAnchor="middle"
              fill="var(--dim)"
              style={{
                fontFamily: "var(--mono)",
                fontSize: 10,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
              }}
            >
              {b.label}
            </text>
          </g>
        );
      })}
      {/* baseline last so it prints over the bar feet */}
      <line x1="0" x2={width} y1={baseY} y2={baseY} stroke="var(--line-2)" strokeWidth="1" />
    </svg>
  );
}
