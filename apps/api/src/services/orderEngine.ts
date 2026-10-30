// ── order trigger engine + live revaluation ────────────────────────
// Two timers, both started from src/index.ts AFTER the server boots
// (never during seed) and stopped via stopOrderEngine():
//
//   • every 15s — evaluate open orders against live oracle USD marks
//     and fire them through the SAME trading service the API uses.
//     take_profit / limit_buy_breakout fire at price >= trigger;
//     stop_loss / limit_buy_dip fire at price <= trigger. A buy whose
//     buffer is gone (or a sell whose position is gone) is marked
//     failed with a failReason; oracle blackouts just skip the order.
//     The same interval also fires due DCA legs (active DcaOrders with
//     nextLegAt <= now): success advances legsDone/nextLegAt (status
//     "done" on the last leg), a 422 (oracle blackout) retries next
//     tick WITHOUT advancing, any other TradeError (buffer gone,
//     frozen vault…) marks the DCA failed with a failReason.
//
//   • every 30s — re-mark every open position at the live price
//     (source none/absent ⇒ markStale, keep the old value), recompute
//     each vault's tvl = buffer + Σ position marks, and append an
//     equity point when the last one is > 5 min old. This is what
//     makes portfolios and equity curves move on their own.

import type { OrderKind, TokenInfo } from "@trader-vaults/shared";
import { prisma } from "../db.js";
import { getTokenInfos } from "./prices.js";
import { executeTrade, TradeError } from "./trading.js";

// Trigger latency the user actually feels. Early-returns when nothing is
// open, and batches one price lookup per distinct mint, so 6s is cheap.
const ORDER_TICK_MS = 6_000;
// Marks drive both displayed PnL and TVL. The upstream price cache is 5s, so
// a faster tick costs nothing there; the write volume is what it protects
// against, and MARK_EPSILON below handles that.
const REVAL_TICK_MS = 8_000;
/** Skip the DB write when a mark moved by less than this fraction. */
const MARK_EPSILON = 0.0002;
const EQUITY_MAX_AGE_SEC = 300; // append a point when last is older

const nowSec = () => Math.floor(Date.now() / 1000);

let orderTimer: NodeJS.Timeout | null = null;
let revalTimer: NodeJS.Timeout | null = null;
let orderTickRunning = false;
let revalTickRunning = false;
let dcaTickRunning = false;

export function startOrderEngine(): void {
  if (orderTimer || revalTimer) return; // already running
  orderTimer = setInterval(() => {
    void orderTick();
    void dcaTick();
  }, ORDER_TICK_MS);
  revalTimer = setInterval(() => void revalTick(), REVAL_TICK_MS);
  console.log(
    `[engine] started — orders every ${ORDER_TICK_MS / 1000}s, revaluation every ${REVAL_TICK_MS / 1000}s`,
  );
}

export function stopOrderEngine(): void {
  if (orderTimer) clearInterval(orderTimer);
  if (revalTimer) clearInterval(revalTimer);
  orderTimer = null;
  revalTimer = null;
}

// ── trigger evaluation ─────────────────────────────────────────────

function isTriggered(kind: OrderKind, priceUsd: number, triggerPriceUsd: number): boolean {
  switch (kind) {
    case "take_profit":
    case "limit_buy_breakout":
      return priceUsd >= triggerPriceUsd;
    case "stop_loss":
    case "limit_buy_dip":
      return priceUsd <= triggerPriceUsd;
    default:
      return false;
  }
}

async function orderTick(): Promise<void> {
  if (orderTickRunning) return; // previous tick still in flight
  orderTickRunning = true;
  try {
    // paper vaults only — real vaults can't create orders, but the engine
    // never touches them regardless (defense in depth for the wall)
    const open = await prisma.order.findMany({
      where: { status: "open", vault: { mode: "paper" } },
    });
    if (open.length === 0) return;

    const mints = [...new Set(open.map((o) => o.mint))];
    const infos = await getTokenInfos(mints);
    const byMint = new Map<string, TokenInfo>(infos.map((i) => [i.mint, i]));

    for (const order of open) {
      // each order is isolated — one failure never kills the tick
      try {
        const info = byMint.get(order.mint);
        // no live mark ⇒ can't evaluate; leave the order open
        if (!info || info.source === "none" || info.priceUsd <= 0) continue;
        if (!isTriggered(order.kind as OrderKind, info.priceUsd, order.triggerPriceUsd)) continue;

        const isBuy = order.kind === "limit_buy_dip" || order.kind === "limit_buy_breakout";
        try {
          const result = await executeTrade(
            order.vaultId,
            isBuy
              ? { side: "buy", mint: order.mint, solAmount: order.amountSol ?? 0 }
              : { side: "sell", mint: order.mint, sellFraction: order.sellFraction ?? 0 },
          );
          await prisma.order.update({
            where: { id: order.id },
            data: { status: "filled", filledAt: nowSec(), filledTradeId: result.trade.id },
          });
          console.log(
            `[engine] filled ${order.kind} ${order.id} (${order.symbol}) at $${info.priceUsd} ` +
              `(trigger $${order.triggerPriceUsd}) → trade ${result.trade.id}`,
          );
        } catch (err) {
          if (err instanceof TradeError && err.status !== 422) {
            // structural rejection: buffer gone, position gone, vault frozen…
            await prisma.order.update({
              where: { id: order.id },
              data: { status: "failed", failReason: err.message },
            });
            console.log(`[engine] failed ${order.kind} ${order.id} (${order.symbol}): ${err.message}`);
          } else {
            throw err; // transient (oracle blackout / db hiccup) — stays open
          }
        }
      } catch (err) {
        console.error(`[engine] error evaluating order ${order.id}:`, err);
      }
    }
  } catch (err) {
    console.error("[engine] order tick failed:", err);
  } finally {
    orderTickRunning = false;
  }
}

// ── DCA legs ───────────────────────────────────────────────────────
// Fire every active DcaOrder whose nextLegAt is due. Legs go through
// the same trading service as everything else, so buffer accounting,
// live-mark enforcement, and equity points all come for free.

async function dcaTick(): Promise<void> {
  if (dcaTickRunning) return; // previous tick still in flight
  dcaTickRunning = true;
  try {
    const now = nowSec();
    // paper vaults only (defensive — real vaults can't create DCAs)
    const due = await prisma.dcaOrder.findMany({
      where: { status: "active", nextLegAt: { lte: now }, vault: { mode: "paper" } },
    });

    for (const dca of due) {
      // each DCA is isolated — one failure never kills the tick
      try {
        // re-read: a cancel may have landed since the findMany
        const fresh = await prisma.dcaOrder.findUnique({ where: { id: dca.id } });
        if (!fresh || fresh.status !== "active") continue;

        try {
          const result = await executeTrade(fresh.vaultId, {
            side: "buy",
            mint: fresh.mint,
            solAmount: fresh.amountSolPerLeg,
          });
          const legsDone = fresh.legsDone + 1;
          const done = legsDone >= fresh.legsTotal;
          await prisma.dcaOrder.update({
            where: { id: fresh.id },
            data: {
              legsDone,
              lastTradeId: result.trade.id,
              nextLegAt: fresh.nextLegAt + fresh.intervalSec,
              status: done ? "done" : "active",
            },
          });
          console.log(
            `[engine] filled dca leg ${legsDone}/${fresh.legsTotal} ${fresh.id} (${fresh.symbol}) ` +
              `${fresh.amountSolPerLeg} SOL → trade ${result.trade.id}${done ? " — dca done" : ""}`,
          );
        } catch (err) {
          if (err instanceof TradeError && err.status === 422) {
            // oracle blackout — retry next tick WITHOUT advancing
            continue;
          }
          if (err instanceof TradeError) {
            // structural rejection: buffer gone, vault frozen/closed…
            await prisma.dcaOrder.update({
              where: { id: fresh.id },
              data: { status: "failed", failReason: err.message },
            });
            console.log(`[engine] failed dca ${fresh.id} (${fresh.symbol}): ${err.message}`);
          } else {
            throw err; // transient (db hiccup) — stays active
          }
        }
      } catch (err) {
        console.error(`[engine] error executing dca ${dca.id}:`, err);
      }
    }
  } catch (err) {
    console.error("[engine] dca tick failed:", err);
  } finally {
    dcaTickRunning = false;
  }
}

// ── live revaluation ───────────────────────────────────────────────

async function revalTick(): Promise<void> {
  if (revalTickRunning) return;
  revalTickRunning = true;
  try {
    // paper vaults only — a real vault's marks come from chain state, never
    // from this simulated revaluation loop
    const positions = await prisma.position.findMany({ where: { vault: { mode: "paper" } } });
    const mints = [...new Set(positions.map((p) => p.mint))];
    const infos = mints.length > 0 ? await getTokenInfos(mints) : [];
    const byMint = new Map<string, TokenInfo>(infos.map((i) => [i.mint, i]));

    for (const pos of positions) {
      try {
        const info = byMint.get(pos.mint);
        if (!info || info.source === "none" || info.priceSol <= 0) {
          // no mark — keep the old value, but label it stale
          if (!pos.markStale) {
            await prisma.position.update({ where: { id: pos.id }, data: { markStale: true } });
          }
          continue;
        }
        const valueSol = pos.amountTokens * info.priceSol;
        const stale = info.source === "stale";
        // ticking 4x faster shouldn't mean 4x the writes — only persist a
        // mark that actually moved (or a staleness flag that flipped)
        const moved =
          pos.valueSol <= 0 ||
          Math.abs(valueSol - pos.valueSol) / pos.valueSol > MARK_EPSILON;
        if (!moved && stale === pos.markStale) continue;
        await prisma.position.update({
          where: { id: pos.id },
          data: { valueSol, markStale: stale },
        });
      } catch (err) {
        console.error(`[engine] error revaluing position ${pos.id}:`, err);
      }
    }

    // vault tvl = buffer + Σ live position marks (+ equity point if stale)
    const [vaults, sums] = await Promise.all([
      prisma.vault.findMany({
        where: { mode: "paper" },
        select: { id: true, solBufferSol: true, totalShares: true },
      }),
      prisma.position.groupBy({ by: ["vaultId"], _sum: { valueSol: true } }),
    ]);
    const sumByVault = new Map(sums.map((s) => [s.vaultId, s._sum.valueSol ?? 0]));
    const now = nowSec();
    for (const vault of vaults) {
      try {
        const tvlSol = vault.solBufferSol + (sumByVault.get(vault.id) ?? 0);
        // NAV per share moves with the marks; equity curve records it
        // (per-share = flow-independent performance, QA finding)
        const sharePriceSol = vault.totalShares > 0 ? tvlSol / vault.totalShares : 1;
        await prisma.vault.update({ where: { id: vault.id }, data: { tvlSol, sharePriceSol } });
        const last = await prisma.equityPoint.findFirst({
          where: { vaultId: vault.id },
          orderBy: { t: "desc" },
          select: { t: true },
        });
        if (!last || now - last.t > EQUITY_MAX_AGE_SEC) {
          await prisma.equityPoint.upsert({
            where: { vaultId_t: { vaultId: vault.id, t: now } },
            update: { v: sharePriceSol },
            create: { vaultId: vault.id, t: now, v: sharePriceSol },
          });
        }
      } catch (err) {
        console.error(`[engine] error revaluing vault ${vault.id}:`, err);
      }
    }
  } catch (err) {
    console.error("[engine] revaluation tick failed:", err);
  } finally {
    revalTickRunning = false;
  }
}
