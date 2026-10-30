import type { UTCTimestamp } from "lightweight-charts";
import type { PoolTrade, Trade } from "@trader-vaults/shared";
import { WHALE_USD, type LayerId } from "./chartLayers";

/**
 * Turn several independent event streams into ONE marker series.
 *
 * lightweight-charts requires markers in strictly ascending time with a single
 * entry per timestamp, so overlapping layers can't just be concatenated —
 * two prints in the same second would corrupt the series. Events are bucketed
 * by second and the most informative one wins: your own fill outranks a wallet
 * you follow, which outranks an anonymous whale.
 */

export interface ChartMarker {
  time: UTCTimestamp;
  position: "aboveBar" | "belowBar";
  color: string;
  shape: "arrowUp" | "arrowDown" | "circle";
  text: string;
  size?: number;
}

interface Event {
  ts: number;
  side: "buy" | "sell";
  /** lower rank wins the bucket */
  rank: number;
  layer: LayerId;
}

const COLORS = {
  mineBuy: "#2fd980",
  mineSell: "#ff4f58",
  mixed: "#ffb000",
  tracked: "#7db9ff",
  whale: "#b98cff",
};

export interface BuildArgs {
  mint: string;
  /** oldest charted timestamp — nothing before this can be drawn */
  firstTs: number;
  layers: Record<LayerId, boolean>;
  vaultTrades: Trade[];
  poolTrades: PoolTrade[] | null;
  trackedWallets: Set<string>;
}

export function buildMarkers({
  mint,
  firstTs,
  layers,
  vaultTrades,
  poolTrades,
  trackedWallets,
}: BuildArgs): ChartMarker[] {
  const events: Event[] = [];

  if (layers.mine) {
    for (const t of vaultTrades) {
      if (t.mint !== mint || t.ts < firstTs) continue;
      events.push({ ts: t.ts, side: t.side, rank: 0, layer: "mine" });
    }
  }

  if (poolTrades && (layers.tracked || layers.whales)) {
    for (const p of poolTrades) {
      if (p.ts < firstTs) continue;
      const isTracked = trackedWallets.has(p.wallet);
      if (layers.tracked && isTracked) {
        events.push({ ts: p.ts, side: p.side, rank: 1, layer: "tracked" });
      } else if (layers.whales && p.amountUsd >= WHALE_USD) {
        events.push({ ts: p.ts, side: p.side, rank: 2, layer: "whales" });
      }
    }
  }

  // bucket by second: keep the best-ranked layer, but remember whether the
  // bucket held both directions so a contested second reads as contested
  const buckets = new Map<number, { best: Event; buys: number; sells: number }>();
  for (const e of events) {
    const b = buckets.get(e.ts);
    if (!b) {
      buckets.set(e.ts, { best: e, buys: e.side === "buy" ? 1 : 0, sells: e.side === "sell" ? 1 : 0 });
      continue;
    }
    if (e.side === "buy") b.buys++;
    else b.sells++;
    if (e.rank < b.best.rank) b.best = e;
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([ts, b]) => {
      const mixed = b.buys > 0 && b.sells > 0;
      const buy = !mixed && b.buys > 0;
      const n = b.buys + b.sells;

      if (b.best.layer === "mine") {
        return {
          time: ts as UTCTimestamp,
          position: buy ? ("belowBar" as const) : ("aboveBar" as const),
          color: mixed ? COLORS.mixed : buy ? COLORS.mineBuy : COLORS.mineSell,
          shape: buy ? ("arrowUp" as const) : ("arrowDown" as const),
          text: mixed ? "B/S" : buy ? (n > 1 ? `B×${n}` : "B") : n > 1 ? `S×${n}` : "S",
        };
      }

      // other wallets get quieter dots — your own fills must stay the
      // loudest thing on the chart
      const tracked = b.best.layer === "tracked";
      return {
        time: ts as UTCTimestamp,
        position: buy ? ("belowBar" as const) : ("aboveBar" as const),
        color: tracked ? COLORS.tracked : COLORS.whale,
        shape: "circle" as const,
        text: tracked ? (n > 1 ? `👁×${n}` : "👁") : n > 1 ? `🐋×${n}` : "🐋",
        size: 0.6,
      };
    });
}

/**
 * Average entry price in USD for a held position.
 *
 * costSol/amountTokens is the SOL cost basis per token; the chart is
 * denominated in USD, so it needs the live SOL price to line up with the
 * candles. Returns null when there's nothing held or no SOL mark.
 */
export function avgEntryUsd(
  pos: { amountTokens: number; costSol: number } | null,
  solPriceUsd: number | undefined,
): number | null {
  if (!pos || pos.amountTokens <= 0 || pos.costSol <= 0) return null;
  if (!solPriceUsd || solPriceUsd <= 0) return null;
  return (pos.costSol / pos.amountTokens) * solPriceUsd;
}
