import { Router } from "express";
import { getTokenPoolStats } from "../services/tokenStats.js";

export const tokenStatsRouter = Router();

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// GET /api/tokenstats/:mint — rolling stats for the mint's deepest pool
// (TokenPoolStats, bare object). Always 200 for a valid mint: lookup or
// upstream failures return empty stats with pool: null.
tokenStatsRouter.get("/:mint", async (req, res, next) => {
  try {
    const mint = req.params.mint;
    if (!BASE58_RE.test(mint)) {
      res.status(400).json({ error: "not a valid mint address" });
      return;
    }
    res.json(await getTokenPoolStats(mint));
  } catch (err) {
    next(err);
  }
});
