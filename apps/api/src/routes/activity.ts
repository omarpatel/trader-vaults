import type { VaultMode } from "@trader-vaults/shared";
import { Router } from "express";
import { getActivity } from "../services/activity.js";

export const activityRouter = Router();

// GET /api/activity?limit=30&mode=real|paper — newest-first merged
// platform feed with pre-rendered ticker lines (paper-vault events are
// prefixed "PAPER · "). No mode param = all. Always {events: [...]}.
activityRouter.get("/", async (req, res, next) => {
  try {
    const raw = Number(req.query.limit);
    const limit = Number.isFinite(raw) && raw > 0 ? raw : 30;
    const mode = req.query.mode as VaultMode | undefined;
    if (mode !== undefined && mode !== "real" && mode !== "paper") {
      res.status(400).json({ error: 'mode must be "real" or "paper"' });
      return;
    }
    res.json({ events: await getActivity(limit, mode) });
  } catch (err) {
    next(err);
  }
});
