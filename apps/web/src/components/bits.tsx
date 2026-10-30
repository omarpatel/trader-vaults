/** Shared primitives: pills, address chips, deltas, charts, stats, skeletons. */
import { useId, useMemo, useRef, useState } from "react";
import { fmtPct, shortAddr, solscanAccount, type EquityPoint } from "@trader-vaults/shared";
import { useCountUp } from "../lib/hooks";

export function TypePill({ type }: { type: "managed" | "mirror" }) {
  return <span className={`pill ${type}`}>{type === "managed" ? "● managed" : "◎ mirror"}</span>;
}

export function StatusPill({ status }: { status: string }) {
  return <span className={`pill ${status}`}>{status}</span>;
}

export function Delta({ v, digits = 1 }: { v: number; digits?: number }) {
  return <span className={`num ${v >= 0 ? "pos" : "neg"}`}>{fmtPct(v, digits)}</span>;
}

export function AddressChip({ addr, label }: { addr: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="addr" title={addr}>
      {label && <span>{label}</span>}
      <a href={solscanAccount(addr)} target="_blank" rel="noreferrer">
        {shortAddr(addr)}
      </a>
      <button
        onClick={(e) => {
          e.preventDefault();
          void navigator.clipboard.writeText(addr);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
        title="Copy address"
        aria-label="Copy address"
      >
        {copied ? "✓" : "⧉"}
      </button>
    </span>
  );
}

export function Skeleton({ h = 16, w, style }: { h?: number; w?: number | string; style?: React.CSSProperties }) {
  return <div className="skel" style={{ height: h, width: w ?? "100%", ...style }} aria-hidden="true" />;
}

/** Sparkline with soft gradient fill — endpoint emphasized. */
export function Sparkline({
  points,
  width = 124,
  height = 38,
}: {
  points: EquityPoint[];
  width?: number;
  height?: number;
}) {
  const gid = useId();
  if (points.length < 2) return <svg width={width} height={height} aria-hidden="true" />;
  const vs = points.map((p) => p.v);
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const span = max - min || 1;
  const step = width / (points.length - 1);
  const y = (v: number) => height - 3 - ((v - min) / span) * (height - 6);
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const up = vs[vs.length - 1]! >= vs[0]!;
  const color = up ? "var(--green)" : "var(--red)";
  const last = points[points.length - 1]!;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d} L${width},${height} L0,${height} Z`} fill={`url(#${gid})`} />
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" />
      <circle cx={width} cy={y(last.v)} r="2.4" fill={color} />
    </svg>
  );
}

/** Equity area chart with hover crosshair + value bubble. Pure SVG. */
export function EquityChart({ points, height = 230 }: { points: EquityPoint[]; height?: number }) {
  const gid = useId();
  const width = 820;
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const geom = useMemo(() => {
    if (points.length < 2) return null;
    const vs = points.map((p) => p.v);
    const min = Math.min(...vs);
    const max = Math.max(...vs);
    const span = max - min || 1;
    const step = width / (points.length - 1);
    const y = (v: number) => height - 10 - ((v - min) / span) * (height - 30);
    const line = points
      .map((p, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${y(p.v).toFixed(1)}`)
      .join(" ");
    return { min, max, span, step, y, line };
  }, [points, height]);

  if (!geom || points.length < 2) return <div className="empty">No equity history yet</div>;
  const vs = points.map((p) => p.v);
  const up = vs[vs.length - 1]! >= vs[0]!;
  const color = up ? "var(--green)" : "var(--red)";
  const hi = hover !== null ? points[Math.min(points.length - 1, Math.max(0, hover))] : null;
  const hx = hover !== null ? hover * geom.step : 0;

  function onMove(e: React.MouseEvent) {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    setHover(Math.round(frac * (points.length - 1)));
  }

  return (
    <div ref={wrapRef} onMouseMove={onMove} onMouseLeave={() => setHover(null)} style={{ position: "relative" }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: "100%", height: "auto", display: "block" }}
        role="img"
        aria-label="Per-share value over time — deposits and withdrawals don't move it, only performance does"
      >
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.26" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1="0"
            x2={width}
            y1={10 + f * (height - 30)}
            y2={10 + f * (height - 30)}
            stroke="var(--line)"
            strokeWidth="1"
          />
        ))}
        <path d={`${geom.line} L${width},${height} L0,${height} Z`} fill={`url(#${gid})`} />
        <path d={geom.line} fill="none" stroke={color} strokeWidth="1.9" />
        {hi && (
          <>
            <line x1={hx} x2={hx} y1={6} y2={height - 6} stroke="var(--line-bright)" strokeWidth="1" strokeDasharray="3 3" />
            <circle cx={hx} cy={geom.y(hi.v)} r="3.4" fill={color} stroke="var(--bg)" strokeWidth="1.5" />
          </>
        )}
      </svg>
      {hi && (
        <div
          className="panel mono"
          style={{
            position: "absolute",
            top: 4,
            left: `min(max(${(hx / width) * 100}% - 60px, 4px), calc(100% - 130px))`,
            padding: "5px 10px",
            fontSize: 11.5,
            pointerEvents: "none",
            background: "var(--paper)",
            whiteSpace: "nowrap",
          }}
        >
          {hi.v.toFixed(4)} ◎/share ·{" "}
          {new Date(hi.t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
        </div>
      )}
    </div>
  );
}

export function Stat({ k, v, d, tone }: { k: string; v: string; d?: string; tone?: "pos" | "neg" }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className={`v ${tone ?? ""}`}>{v}</div>
      {d && <div className="d mutedtx">{d}</div>}
    </div>
  );
}

/** Stat whose number animates to its value. */
export function CountStat({
  k,
  value,
  fmt,
  d,
  tone,
}: {
  k: string;
  value: number;
  fmt: (n: number) => string;
  d?: string;
  tone?: "pos" | "neg";
}) {
  const animated = useCountUp(value);
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className={`v ${tone ?? ""}`}>{fmt(animated)}</div>
      {d && <div className="d mutedtx">{d}</div>}
    </div>
  );
}
