// ── DCA orders (the PaperApe pattern) ──────────────────────────────
// Buy X SOL of a token every N seconds, M times total. Creation fires
// the FIRST leg immediately through the same trading service the API
// uses everywhere — if that leg is rejected, the whole creation is
// rejected with the trade's error. Later legs are fired by the engine
// tick in services/orderEngine.ts.
//
// NOTE: the DCA wire shape is defined locally (packages/shared is
// frozen for this feature — the web client types it locally too).

import type { DcaOrder as DbDcaOrder } from "@prisma/client";
import { Router } from "express";
import { prisma } from "../db.js";
import { getTokenInfo } from "../services/prices.js";
import { executeTrade, REAL_VAULT_WALL, TradeError } from "../services/trading.js";

export const dcaRouter = Router();

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MIN_INTERVAL_SEC = 60;
const MIN_LEGS = 1;
const MAX_LEGS = 96;

export type DcaStatus = "active" | "done" | "cancelled" | "failed";

/** Wire shape returned by every /api/dca endpoint. */
export interface DcaOrderWire {
  id: string;
  vaultId: string;
  mint: string;
  symbol: string;
  amountSolPerLeg: number;
  intervalSec: number;
  legsTotal: number;
  legsDone: number;
  nextLegAt: number;
  status: DcaStatus;
  createdAt: number;
  failReason?: string;
}

const nowSec = () => Math.floor(Date.now() / 1000);

export function toDca(row: DbDcaOrder): DcaOrderWire {
  return {
    id: row.id,
    vaultId: row.vaultId,
    mint: row.mint,
    symbol: row.symbol,
    amountSolPerLeg: row.amountSolPerLeg,
    intervalSec: row.intervalSec,
    legsTotal: row.legsTotal,
    legsDone: row.legsDone,
    nextLegAt: row.nextLegAt,
    status: row.status as DcaStatus,
    createdAt: row.createdAt,
    failReason: row.failReason ?? undefined,
  };
}

// POST /api/dca { vaultId, mint, amountSolPerLeg, intervalSec, legsTotal }
// Validates, then executes leg 1 synchronously — the created row starts
// at legsDone=1 with nextLegAt=now+intervalSec (or already "done" for a
// single-leg order). Total notional must fit the vault's CURRENT buffer
// as a soft sanity check; later legs re-check at fill time.
dcaRouter.post("/", async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as { vaultId?: unknown; mint?: unknown };
    const vaultId = body.vaultId;
    const mint = body.mint;
    const amountSolPerLeg = Number((req.body ?? {}).amountSolPerLeg);
    const intervalSec = Number((req.body ?? {}).intervalSec);
    const legsTotal = Number((req.body ?? {}).legsTotal);

    if (!vaultId || typeof vaultId !== "string") {
      res.status(400).json({ error: "vaultId is required" });
      return;
    }
    if (typeof mint !== "string" || !BASE58_RE.test(mint)) {
      res.status(400).json({ error: "not a valid mint address" });
      return;
    }
    if (!Number.isFinite(amountSolPerLeg) || amountSolPerLeg <= 0) {
      res.status(400).json({ error: "amountSolPerLeg must be a positive number" });
      return;
    }
    if (!Number.isInteger(intervalSec) || intervalSec < MIN_INTERVAL_SEC) {
      res.status(400).json({ error: `intervalSec must be an integer >= ${MIN_INTERVAL_SEC}` });
      return;
    }
    if (!Number.isInteger(legsTotal) || legsTotal < MIN_LEGS || legsTotal > MAX_LEGS) {
      res.status(400).json({ error: `legsTotal must be an integer in [${MIN_LEGS}, ${MAX_LEGS}]` });
      return;
    }

    const vault = await prisma.vault.findUnique({ where: { id: vaultId } });
    if (!vault) {
      res.status(404).json({ error: "vault not found" });
      return;
    }
    if (vault.mode === "real") {
      // THE WALL: DCA legs fill through the simulated engine — paper only
      res.status(409).json(REAL_VAULT_WALL);
      return;
    }
    if (vault.status !== "active") {
      res.status(409).json({ error: `vault is ${vault.status}` });
      return;
    }

    // Live oracle mark required up front — a DCA into an unpriceable
    // token would just fail every leg.
    const info = await getTokenInfo(mint);
    if (info.source === "none" || info.priceUsd <= 0 || info.priceSol <= 0) {
      res.status(422).json({ error: `no live price for ${mint} — refusing to schedule a DCA without an oracle mark` });
      return;
    }

    // Soft sanity check at creation: the whole plan should fit today's
    // buffer. (Deposits/sells can still change the buffer later — legs
    // re-check for real at fill time.)
    const totalNotional = amountSolPerLeg * legsTotal;
    if (totalNotional > vault.solBufferSol) {
      res.status(400).json({
        error:
          `total notional ${totalNotional.toFixed(4)} SOL (${amountSolPerLeg} × ${legsTotal} legs) ` +
          `exceeds the vault's SOL buffer (${vault.solBufferSol.toFixed(4)})`,
      });
      return;
    }

    // ── leg 1 fires NOW; a rejected first leg rejects the creation ──
    let firstTradeId: string;
    try {
      const result = await executeTrade(vaultId, { side: "buy", mint, solAmount: amountSolPerLeg });
      firstTradeId = result.trade.id;
      console.log(
        `[dca] leg 1/${legsTotal} (${result.trade.symbol}) filled at creation → trade ${firstTradeId}`,
      );
    } catch (err) {
      if (err instanceof TradeError) {
        res.status(err.status).json({ error: `first DCA leg rejected: ${err.message}` });
        return;
      }
      throw err;
    }

    const now = nowSec();
    const row = await prisma.dcaOrder.create({
      data: {
        vaultId,
        mint,
        symbol: info.symbol,
        amountSolPerLeg,
        intervalSec,
        legsTotal,
        legsDone: 1,
        nextLegAt: now + intervalSec,
        status: legsTotal <= 1 ? "done" : "active",
        createdAt: now,
        lastTradeId: firstTradeId,
      },
    });
    res.status(201).json({ dca: toDca(row) });
  } catch (err) {
    next(err);
  }
});

// GET /api/dca?vaultId= — newest first
dcaRouter.get("/", async (req, res, next) => {
  try {
    const vaultId = typeof req.query.vaultId === "string" ? req.query.vaultId : undefined;
    const rows = await prisma.dcaOrder.findMany({
      where: vaultId ? { vaultId } : {},
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    res.json({ orders: rows.map(toDca) });
  } catch (err) {
    next(err);
  }
});

// POST /api/dca/:id/cancel — only active DCAs can be cancelled
dcaRouter.post("/:id/cancel", async (req, res, next) => {
  try {
    const row = await prisma.dcaOrder.findUnique({ where: { id: req.params.id } });
    if (!row) {
      res.status(404).json({ error: "dca order not found" });
      return;
    }
    if (row.status !== "active") {
      res.status(409).json({ error: `dca order is ${row.status}` });
      return;
    }
    const updated = await prisma.dcaOrder.update({
      where: { id: row.id },
      data: { status: "cancelled" },
    });
    res.json({ dca: toDca(updated) });
  } catch (err) {
    next(err);
  }
});
