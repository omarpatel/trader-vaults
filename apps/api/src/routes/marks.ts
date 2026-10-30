import { Router } from "express";
import { getTokenInfos } from "../services/prices.js";

export const marksRouter = Router();

/** One request can't be used to fan out unbounded upstream lookups. */
const MAX_MINTS = 40;

/**
 * GET /api/marks?mints=a,b,c — the cheapest possible live price read.
 *
 * The terminal marks open positions client-side against this so PnL tracks
 * the market instead of waiting on the 30s revaluation tick plus a 15s vault
 * poll. Deliberately tiny: no metadata, no risk, no pool stats — just what a
 * mark needs. Backed by the same 5s price cache, so a 3s client poll costs
 * nothing upstream.
 */
marksRouter.get("/", async (req, res, next) => {
  try {
    const raw = typeof req.query.mints === "string" ? req.query.mints : "";
    const mints = [...new Set(raw.split(",").map((m) => m.trim()).filter(Boolean))];
    if (mints.length === 0) return res.json({ marks: [], at: Date.now() });
    if (mints.length > MAX_MINTS) {
      return res.status(400).json({ error: `too many mints (max ${MAX_MINTS})` });
    }

    const infos = await getTokenInfos(mints);
    res.json({
      marks: infos
        // a position with no mark keeps its last known value — sending 0 here
        // would flash every holding to -100% on a single upstream hiccup
        .filter((i) => i.source !== "none" && i.priceSol > 0)
        .map((i) => ({
          mint: i.mint,
          priceSol: i.priceSol,
          priceUsd: i.priceUsd,
          stale: i.source === "stale",
        })),
      at: Date.now(),
    });
  } catch (err) {
    next(err);
  }
});
