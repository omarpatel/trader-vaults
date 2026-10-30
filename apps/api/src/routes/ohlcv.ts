import { Router } from "express";
import { getOhlcv, isTimeframe, TIMEFRAMES, type Denom } from "../services/ohlcv.js";

export const ohlcvRouter = Router();

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// GET /api/ohlcv/:mint?tf=<tf>&since=<unix seconds> — real candles for the
// mint. Always 200: chart failures come back as {candles: [], pool: null}
// and the UI shows an empty state.
//
// `since` returns only the tail of the window, which is what makes a 1s
// chart affordable — a full 1s window is ~85KB and a poll every 1.2s would
// push hundreds of megabytes an hour at one viewer.
ohlcvRouter.get("/:mint", async (req, res, next) => {
  try {
    const mint = req.params.mint;
    if (!BASE58_RE.test(mint)) {
      res.status(400).json({ error: "not a valid mint address" });
      return;
    }
    const tf = req.query.tf ?? "1m";
    if (!isTimeframe(tf)) {
      res.status(400).json({ error: `tf must be one of ${TIMEFRAMES.join(", ")}` });
      return;
    }
    // The vault's book is denominated in SOL, so a USD chart misstates the
    // trader's own PnL every time SOL itself moves.
    const currency: Denom = req.query.currency === "SOL" ? "SOL" : "USD";
    const full = await getOhlcv(mint, tf, currency);

    const sinceRaw = req.query.since;
    const since = typeof sinceRaw === "string" ? Number(sinceRaw) : NaN;
    if (!Number.isFinite(since) || since <= 0) {
      res.json({ ...full, partial: false });
      return;
    }

    // >= not >: the newest bar the client holds is usually still forming,
    // and its OHLC changes while its timestamp does not. Excluding it would
    // freeze the live bar until the next second traded.
    const tail = full.candles.filter((c) => c.t >= since);
    res.json({
      ...full,
      candles: tail,
      // tells the client to merge rather than replace
      partial: true,
      // if the window no longer reaches back to `since` the client's held
      // bars are stale and it must refetch in full rather than merge
      gap: full.candles.length > 0 && full.candles[0]!.t > since,
    });
  } catch (err) {
    next(err);
  }
});
