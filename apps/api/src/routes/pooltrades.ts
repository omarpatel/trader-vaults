import { Router } from "express";
import { getPoolTrades } from "../services/poolTrades.js";

export const poolTradesRouter = Router();

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// GET /api/pooltrades/:mint — recent trades in the mint's deepest pool.
// Always 200: failures come back as {trades: []} and the UI shows an
// empty tape.
poolTradesRouter.get("/:mint", async (req, res, next) => {
  try {
    const mint = req.params.mint;
    if (!BASE58_RE.test(mint)) {
      res.status(400).json({ error: "not a valid mint address" });
      return;
    }
    res.json(await getPoolTrades(mint));
  } catch (err) {
    next(err);
  }
});
