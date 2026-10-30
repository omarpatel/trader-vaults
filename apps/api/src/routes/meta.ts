import type { PlatformMeta } from "@trader-vaults/shared";
import { Router } from "express";
import { getOrSet } from "../cache.js";
import { prisma } from "../db.js";
import { solPriceUsd } from "../services/prices.js";

export const metaRouter = Router();

const META_TTL_MS = 10_000;

/**
 * GET /api/meta - Platform-wide numbers for the header strip
 */
metaRouter.get("/", async (_req, res, next) => {
  try {
    const cached = await getOrSet("platform:meta", META_TTL_MS, async () => {
      // headline numbers are REAL vaults only — paper money never poses
      // as platform TVL (QA finding)
      const [solUsd, tvlAgg, vaultCount] = await Promise.all([
        solPriceUsd(),
        prisma.vault.aggregate({
          where: { status: "active", mode: "real" },
          _sum: { tvlSol: true },
        }),
        prisma.vault.count({ where: { status: "active", mode: "real" } }),
      ]);
      return {
        solPriceUsd: solUsd,
        tvlSol: tvlAgg._sum.tvlSol ?? 0,
        vaults: vaultCount,
      };
    });
    const meta: PlatformMeta = { ...cached, apiTime: Math.floor(Date.now() / 1000) };
    res.json(meta);
  } catch (err) {
    next(err);
  }
});
