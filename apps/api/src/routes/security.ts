import { Router } from "express";
import { getTokenSecurity } from "../services/security.js";

export const securityRouter = Router();

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// GET /api/security/:mint — on-chain security audit for a mint
// (TokenSecurity, bare object). Always 200 for a valid mint: RPC
// failures leave the affected fields null — unknown means unknown.
securityRouter.get("/:mint", async (req, res, next) => {
  try {
    const mint = req.params.mint;
    if (!BASE58_RE.test(mint)) {
      res.status(400).json({ error: "not a valid mint address" });
      return;
    }
    res.json(await getTokenSecurity(mint));
  } catch (err) {
    next(err);
  }
});
