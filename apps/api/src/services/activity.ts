// ── platform activity wire ─────────────────────────────────────────
// Merges the newest events across trades, order fills, deposits,
// withdrawals and vault creations into one newest-first feed with
// pre-rendered text lines (vault names uppercased — ticker-tape style).
// Trades that were produced by a filled order render as "order_fill"
// (joined via Order.filledTradeId), not as plain trades. Cached 5s.
//
// Real/paper split: events from PAPER vaults are prefixed "PAPER · "
// server-side so no surface can pass sandbox activity off as real.
// Real-vault lifecycle events (vault_created — the only kind a walled
// real vault can produce) render unprefixed. ?mode= filters the feed.

import type { ActivityEvent, TradeSide, VaultMode } from "@trader-vaults/shared";
import { fmtSol } from "@trader-vaults/shared";
import { getOrSet } from "../cache.js";
import { prisma } from "../db.js";

const ACTIVITY_TTL_MS = 5_000;
export const ACTIVITY_MAX_LIMIT = 100;

const ORDER_LABEL: Record<string, string> = {
  take_profit: "TP",
  stop_loss: "SL",
  limit_buy_dip: "LIMIT BUY",
  limit_buy_breakout: "LIMIT BUY",
};

const sol = (v: number) => fmtSol(v, 1);
const up = (s: string) => s.toUpperCase();
/** Paper-vault events are labeled server-side; real events pass through. */
const tag = (mode: string, text: string) => (mode === "paper" ? `PAPER · ${text}` : text);

async function buildFeed(limit: number, mode?: VaultMode): Promise<ActivityEvent[]> {
  const vaultFilter = mode ? { vault: { mode } } : {};
  const [filledOrders, deposits, withdrawals, vaults] = await Promise.all([
    prisma.order.findMany({
      where: { status: "filled", filledTradeId: { not: null }, ...vaultFilter },
      orderBy: [{ filledAt: "desc" }, { id: "desc" }],
      take: limit,
      include: { vault: { select: { name: true, mode: true } } },
    }),
    prisma.deposit.findMany({
      where: { ...vaultFilter },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      include: { vault: { select: { name: true, mode: true } } },
    }),
    prisma.withdrawRequest.findMany({
      where: { status: { in: ["pending", "executable", "paid"] }, ...vaultFilter },
      orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
      take: limit,
      include: { vault: { select: { name: true, mode: true } } },
    }),
    prisma.vault.findMany({
      where: mode ? { mode } : {},
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, name: true, type: true, mode: true, createdAt: true },
    }),
  ]);

  // fill trades give the order events their real fill size/side
  const fillTradeIds = filledOrders
    .map((o) => o.filledTradeId)
    .filter((id): id is string => id !== null);
  const [fillTrades, trades] = await Promise.all([
    fillTradeIds.length
      ? prisma.trade.findMany({ where: { id: { in: fillTradeIds } } })
      : Promise.resolve([]),
    prisma.trade.findMany({
      where: { ...vaultFilter },
      orderBy: [{ ts: "desc" }, { id: "desc" }],
      take: limit + fillTradeIds.length, // room to drop the fill trades
      include: { vault: { select: { name: true, mode: true } } },
    }),
  ]);
  const fillTradeById = new Map(fillTrades.map((t) => [t.id, t]));

  const events: ActivityEvent[] = [];

  for (const t of trades) {
    if (fillTradeById.has(t.id)) continue; // rendered as order_fill below
    const vaultName = up(t.vault.name);
    events.push({
      id: `trade:${t.id}`,
      ts: t.ts,
      kind: "trade",
      vaultId: t.vaultId,
      vaultName,
      text: tag(t.vault.mode, `${vaultName} ${t.side === "buy" ? "BOUGHT" : "SOLD"} ${sol(t.solAmount)} SOL OF ${up(t.symbol)}`),
      solAmount: t.solAmount,
      side: t.side as TradeSide,
    });
  }

  for (const o of filledOrders) {
    const trade = o.filledTradeId ? fillTradeById.get(o.filledTradeId) : undefined;
    const vaultName = up(o.vault.name);
    const isSell = o.kind === "take_profit" || o.kind === "stop_loss";
    const solAmount = trade?.solAmount ?? o.amountSol ?? undefined;
    const label = ORDER_LABEL[o.kind] ?? up(o.kind);
    const amountText =
      solAmount !== undefined ? ` ${isSell ? "+" : "-"}${sol(solAmount)} SOL` : "";
    events.push({
      id: `order:${o.id}`,
      ts: o.filledAt ?? o.createdAt,
      kind: "order_fill",
      vaultId: o.vaultId,
      vaultName,
      text: tag(o.vault.mode, `${label} FILLED: ${up(o.symbol)}${amountText} (${vaultName})`),
      solAmount,
      side: isSell ? "sell" : "buy",
    });
  }

  for (const d of deposits) {
    const vaultName = up(d.vault.name);
    events.push({
      id: `deposit:${d.id}`,
      ts: Math.floor(d.createdAt.getTime() / 1000),
      kind: "deposit",
      vaultId: d.vaultId,
      vaultName,
      text: tag(d.vault.mode, `DEPOSIT +${sol(d.costSol)} SOL INTO ${vaultName}`),
      solAmount: d.costSol,
    });
  }

  for (const w of withdrawals) {
    const vaultName = up(w.vault.name);
    const paid = w.status === "paid";
    events.push({
      id: `withdraw:${w.id}`,
      ts: paid ? (w.paidAt ?? w.executableAt) : w.requestedAt,
      kind: paid ? "withdraw_paid" : "withdraw_request",
      vaultId: w.vaultId,
      vaultName,
      text: tag(w.vault.mode, `${paid ? "WITHDRAW PAID" : "WITHDRAW REQUEST"} ${sol(w.valueAtRequestSol)} SOL FROM ${vaultName}`),
      solAmount: w.valueAtRequestSol,
    });
  }

  for (const v of vaults) {
    const vaultName = up(v.name);
    events.push({
      id: `vault:${v.id}`,
      ts: Math.floor(v.createdAt.getTime() / 1000),
      kind: "vault_created",
      vaultId: v.id,
      vaultName,
      // real-vault lifecycle stays clean; paper creations carry the label too
      text: tag(v.mode, `VAULT CREATED: ${vaultName} (${up(v.type)})`),
    });
  }

  events.sort((a, b) => b.ts - a.ts || a.id.localeCompare(b.id));
  return events.slice(0, limit);
}

/** Newest-first merged activity feed, cached 5s per (limit, mode). */
export async function getActivity(limit: number, mode?: VaultMode): Promise<ActivityEvent[]> {
  const clamped = Math.max(1, Math.min(ACTIVITY_MAX_LIMIT, Math.floor(limit)));
  return getOrSet(`activity:${clamped}:${mode ?? "all"}`, ACTIVITY_TTL_MS, () =>
    buildFeed(clamped, mode),
  );
}
