import type { Order, OrderKind, OrderStatus } from "@trader-vaults/shared";
import type { Order as DbOrder } from "@prisma/client";
import { Router } from "express";
import { prisma } from "../db.js";
import { getTokenInfo } from "../services/prices.js";
import { REAL_VAULT_WALL } from "../services/trading.js";

export const ordersRouter = Router();

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const KINDS: OrderKind[] = ["take_profit", "stop_loss", "limit_buy_dip", "limit_buy_breakout"];
const STATUSES: OrderStatus[] = ["open", "filled", "cancelled", "failed"];

const nowSec = () => Math.floor(Date.now() / 1000);

export function toOrder(row: DbOrder): Order {
  return {
    id: row.id,
    vaultId: row.vaultId,
    mint: row.mint,
    symbol: row.symbol,
    kind: row.kind as OrderKind,
    triggerPriceUsd: row.triggerPriceUsd,
    amountSol: row.amountSol ?? undefined,
    sellFraction: row.sellFraction ?? undefined,
    status: row.status as OrderStatus,
    createdAt: row.createdAt,
    filledAt: row.filledAt ?? undefined,
    filledTradeId: row.filledTradeId ?? undefined,
    failReason: row.failReason ?? undefined,
  };
}

// POST /api/orders { vaultId, mint, kind, triggerPriceUsd, amountSol?, sellFraction? }
// take_profit / stop_loss need sellFraction and an existing position;
// limit_buy_dip / limit_buy_breakout need amountSol. The engine checks
// buffer sufficiency at FILL time, not placement time.
ordersRouter.post("/", async (req, res, next) => {
  try {
    const { vaultId, mint, kind } = (req.body ?? {}) as {
      vaultId?: string;
      mint?: string;
      kind?: string;
    };
    const triggerPriceUsd = Number((req.body ?? {}).triggerPriceUsd);

    if (!vaultId || typeof vaultId !== "string") {
      res.status(400).json({ error: "vaultId is required" });
      return;
    }
    if (typeof mint !== "string" || !BASE58_RE.test(mint)) {
      res.status(400).json({ error: "not a valid mint address" });
      return;
    }
    if (!KINDS.includes(kind as OrderKind)) {
      res.status(400).json({ error: `kind must be one of ${KINDS.join(", ")}` });
      return;
    }
    if (!Number.isFinite(triggerPriceUsd) || triggerPriceUsd <= 0) {
      res.status(400).json({ error: "triggerPriceUsd must be a positive number" });
      return;
    }

    const vault = await prisma.vault.findUnique({ where: { id: vaultId } });
    if (!vault) {
      res.status(404).json({ error: "vault not found" });
      return;
    }
    if (vault.mode === "real") {
      // THE WALL: orders fill through the simulated engine — paper only
      res.status(409).json(REAL_VAULT_WALL);
      return;
    }
    if (vault.status !== "active") {
      res.status(409).json({ error: `vault is ${vault.status}` });
      return;
    }

    const isSellKind = kind === "take_profit" || kind === "stop_loss";
    let amountSol: number | null = null;
    let sellFraction: number | null = null;
    let symbol: string;

    if (isSellKind) {
      sellFraction = Number((req.body ?? {}).sellFraction);
      if (!Number.isFinite(sellFraction) || sellFraction <= 0 || sellFraction > 1) {
        res.status(400).json({ error: `${kind} requires sellFraction in (0, 1]` });
        return;
      }
      const position = await prisma.position.findUnique({
        where: { vaultId_mint: { vaultId, mint } },
      });
      if (!position || position.amountTokens <= 0) {
        res.status(400).json({ error: `${kind} requires an open position in this token` });
        return;
      }
      symbol = position.symbol;
    } else {
      amountSol = Number((req.body ?? {}).amountSol);
      if (!Number.isFinite(amountSol) || amountSol <= 0) {
        res.status(400).json({ error: `${kind} requires a positive amountSol` });
        return;
      }
      // metadata lookup only — orders may be placed while a price is absent
      symbol = (await getTokenInfo(mint)).symbol;
    }

    const row = await prisma.order.create({
      data: {
        vaultId,
        mint,
        symbol,
        kind: kind as string,
        triggerPriceUsd,
        amountSol,
        sellFraction,
        status: "open",
        createdAt: nowSec(),
      },
    });
    res.status(201).json({ order: toOrder(row) });
  } catch (err) {
    next(err);
  }
});

// GET /api/orders?vaultId=&status= — newest first
ordersRouter.get("/", async (req, res, next) => {
  try {
    const vaultId = typeof req.query.vaultId === "string" ? req.query.vaultId : undefined;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    if (status !== undefined && !STATUSES.includes(status as OrderStatus)) {
      res.status(400).json({ error: `status must be one of ${STATUSES.join(", ")}` });
      return;
    }
    const rows = await prisma.order.findMany({
      where: {
        ...(vaultId ? { vaultId } : {}),
        ...(status ? { status } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    res.json({ orders: rows.map(toOrder) });
  } catch (err) {
    next(err);
  }
});

// POST /api/orders/:id/cancel — only open orders can be cancelled
ordersRouter.post("/:id/cancel", async (req, res, next) => {
  try {
    const row = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!row) {
      res.status(404).json({ error: "order not found" });
      return;
    }
    if (row.status !== "open") {
      res.status(409).json({ error: `order is ${row.status}` });
      return;
    }
    const updated = await prisma.order.update({
      where: { id: row.id },
      data: { status: "cancelled" },
    });
    res.json({ order: toOrder(updated) });
  } catch (err) {
    next(err);
  }
});
