import { Router } from "express";
import { getTrending, searchTokens } from "../services/discovery.js";
import { getTokenInfo, getTokenInfos } from "../services/prices.js";
import { getOrSet, cacheGet } from "../cache.js";
import { QUERY_OPTS } from "../performance.js";

export const tokensRouter = Router();

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_BATCH = 50;

// GET /api/tokens?ids=mintA,mintB,... — batched oracle lookup (cached)
tokensRouter.get("/", async (req, res, next) => {
  try {
    const raw = typeof req.query.ids === "string" ? req.query.ids : "";
    const ids = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) {
      res.status(400).json({ error: "ids query param required, e.g. ?ids=mintA,mintB" });
      return;
    }
    if (ids.length > MAX_BATCH) {
      res.status(400).json({ error: `at most ${MAX_BATCH} ids per request` });
      return;
    }
    const bad = ids.find((id) => !BASE58_RE.test(id));
    if (bad) {
      res.status(400).json({ error: `not a valid mint: ${bad}` });
      return;
    }
    
    // Cache token lookups for 2 minutes
    const cacheKey = `tokens:batch:${ids.join(",")}`;
    const tokens = await getOrSet(
      cacheKey,
      QUERY_OPTS.CACHE_TTL.MEDIUM,
      () => getTokenInfos(ids)
    );
    
    res.setHeader("X-Cache", "HIT");
    res.json({ tokens });
  } catch (err) {
    next(err);
  }
});

// GET /api/tokens/search?q= — DexScreener search (Solana pairs, top 8
// by liquidity, deduped by mint). A raw base58 mint resolves through
// the oracle into a single result. Registered before /:mint on purpose.
tokensRouter.get("/search", async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) {
      res.status(400).json({ error: "q query param required, e.g. ?q=bonk" });
      return;
    }
    const results = await searchTokens(q);
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

// GET /api/tokens/trending — GeckoTerminal trending pools (top 10),
// falling back to oracle marks for the seeded well-known mints so this
// endpoint never 500s. Registered before /:mint on purpose. (cached)
tokensRouter.get("/trending", async (_req, res, next) => {
  try {
    const tokens = await getOrSet(
      "tokens:trending",
      QUERY_OPTS.CACHE_TTL.MEDIUM,
      () => getTrending()
    );
    res.setHeader("X-Cache", "HIT");
    res.json({ tokens });
  } catch (err) {
    next(err);
  }
});

// GET /api/tokens/:mint — single oracle lookup (TokenInfo) (cached)
tokensRouter.get("/:mint", async (req, res, next) => {
  try {
    const mint = req.params.mint;
    if (!BASE58_RE.test(mint)) {
      res.status(400).json({ error: "not a valid mint address" });
      return;
    }
    
    const result = await getOrSet(
      `tokens:single:${mint}`,
      QUERY_OPTS.CACHE_TTL.MEDIUM,
      () => getTokenInfo(mint)
    );
    
    res.setHeader("X-Cache", "HIT");
    res.json(result);
  } catch (err) {
    next(err);
  }
});
