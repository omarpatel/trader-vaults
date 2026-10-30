import { Router } from "express";
import { getPulseBoard } from "../services/pulse.js";

export const pulseRouter = Router();

// GET /api/pulse — lifecycle discovery board (PulseBoard). The board IS
// the response envelope; individual upstream failures come back as an
// empty column, never a 500.
pulseRouter.get("/", async (_req, res, next) => {
  try {
    res.json(await getPulseBoard());
  } catch (err) {
    next(err);
  }
});
