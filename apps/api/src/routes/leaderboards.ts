// ── Leaderboards API Routes ───────────────────────────────────────────
import { Router } from "express";
import { prisma } from "../db.js";

export const leaderboardsRouter = Router();

interface LeaderboardQuery {
  limit?: string;
  offset?: string;
  period?: "7d" | "30d" | "all";
  category?: "traders" | "vaults" | "wallets";
  sort?: "pnl" | "winrate" | "tvl" | "trades";
}

/**
 * GET /api/leaderboards
 * Unified leaderboard endpoint supporting traders, vaults, and tracked wallets
 */
leaderboardsRouter.get("/", async (req, res) => {
  try {
    const { limit = "50", offset = "0", period = "all", category = "traders", sort = "pnl" } = req.query as LeaderboardQuery;
    
    const limitNum = Math.min(parseInt(limit), 100);
    const offsetNum = parseInt(offset);

    let result;

    switch (category) {
      case "traders":
        result = await getTraderLeaderboard({ limit: limitNum, offset: offsetNum, period: period as any, sort: sort as any });
        break;
      case "vaults":
        result = await getVaultLeaderboard({ limit: limitNum, offset: offsetNum, period: period as any, sort: sort as any });
        break;
      case "wallets":
        result = await getWalletLeaderboard({ limit: limitNum, offset: offsetNum, sort: sort as any });
        break;
      default:
        return res.status(400).json({ error: "Invalid category. Must be: traders, vaults, or wallets" });
    }

    res.json({
      category,
      period,
      sort,
      limit: limitNum,
      offset: offsetNum,
      ...result,
    });
  } catch (error) {
    console.error("[leaderboards] Error:", error);
    res.status(500).json({ error: "Failed to fetch leaderboard data" });
  }
});

/**
 * GET /api/leaderboards/traders
 * Trader rankings by performance
 */
leaderboardsRouter.get("/traders", async (req, res) => {
  try {
    const { limit = "50", offset = "0", period = "all", sort = "pnl" } = req.query;
    
    const result = await getTraderLeaderboard({
      limit: Math.min(parseInt(limit as string), 100),
      offset: parseInt(offset as string),
      period: period as "7d" | "30d" | "all",
      sort: sort as any,
    });

    res.json(result);
  } catch (error) {
    console.error("[leaderboards/traders] Error:", error);
    res.status(500).json({ error: "Failed to fetch trader leaderboard" });
  }
});

/**
 * GET /api/leaderboards/vaults
 * Vault rankings by TVL and performance
 */
leaderboardsRouter.get("/vaults", async (req, res) => {
  try {
    const { limit = "50", offset = "0", period = "all", sort = "tvl" } = req.query;
    
    const result = await getVaultLeaderboard({
      limit: Math.min(parseInt(limit as string), 100),
      offset: parseInt(offset as string),
      period: period as "7d" | "30d" | "all",
      sort: sort as any,
    });

    res.json(result);
  } catch (error) {
    console.error("[leaderboards/vaults] Error:", error);
    res.status(500).json({ error: "Failed to fetch vault leaderboard" });
  }
});

/**
 * GET /api/leaderboards/wallets
 * Tracked wallet rankings by performance
 */
leaderboardsRouter.get("/wallets", async (req, res) => {
  try {
    const { limit = "50", offset = "0", sort = "pnl" } = req.query;
    
    const result = await getWalletLeaderboard({
      limit: Math.min(parseInt(limit as string), 100),
      offset: parseInt(offset as string),
      sort: sort as any,
    });

    res.json(result);
  } catch (error) {
    console.error("[leaderboards/wallets] Error:", error);
    res.status(500).json({ error: "Failed to fetch wallet leaderboard" });
  }
});

// ── Helper Functions ─────────────────────────────────────────────────

async function getTraderLeaderboard(params: {
  limit: number;
  offset: number;
  period: "7d" | "30d" | "all";
  sort: "pnl" | "winrate" | "tvl" | "trades";
}) {
  const { limit, offset, sort } = params;
  
  // Get traders with active vaults
  const users = await prisma.user.findMany({
    where: {
      vaults: {
        some: { status: "active" },
      },
    },
    include: {
      vaults: {
        where: { status: "active" },
      },
    },
    take: limit,
    skip: offset,
  });

  // Calculate stats for each trader
  const tradersWithStats = users.map(user => {
    const totalTvlsol = user.vaults.reduce((sum: number, v: any) => sum + (v.tvlSol || 0), 0);
    const activeVaults = user.vaults.length;
    
    return {
      id: user.id,
      handle: user.handle,
      displayName: user.displayName,
      xHandle: user.xHandle,
      xVerified: user.xVerified,
      createdAt: user.createdAt,
      totalTvlsol,
      activeVaults,
      vaults: user.vaults.map(v => ({
        id: v.id,
        name: v.name,
        mode: v.mode,
        tvlSol: v.tvlSol,
        sharePriceSol: v.sharePriceSol,
        totalShares: v.totalShares,
      })),
    };
  });

  const total = await prisma.user.count({
    where: {
      vaults: {
        some: { status: "active" },
      },
    },
  });

  return {
    leaders: tradersWithStats,
    total,
    hasMore: offset + limit < total,
  };
}

async function getVaultLeaderboard(params: {
  limit: number;
  offset: number;
  period: "7d" | "30d" | "all";
  sort: "pnl" | "winrate" | "tvl" | "trades";
}) {
  const { limit, offset, sort } = params;

  const where = {
    status: "active" as const,
  };

  const orderByMap: Record<string, any> = {
    pnl: { tvlSol: "desc" },
    winrate: { tvlSol: "desc" },
    tvl: { tvlSol: "desc" },
    trades: { tvlSol: "desc" },
  };

  const orderBy = orderByMap[sort] || orderByMap.tvl;

  const vaults = await prisma.vault.findMany({
    where,
    include: {
      trader: {
        select: {
          id: true,
          handle: true,
          displayName: true,
          xHandle: true,
          xVerified: true,
        },
      },
    },
    orderBy,
    take: limit,
    skip: offset,
  });

  const total = await prisma.vault.count({ where });

  return {
    leaders: vaults,
    total,
    hasMore: offset + limit < total,
  };
}

async function getWalletLeaderboard(params: {
  limit: number;
  offset: number;
  sort: "pnl" | "winrate" | "tvl" | "trades";
}) {
  const { limit, offset, sort } = params;

  const orderByMap: Record<string, any> = {
    pnl: { pnlSol: "desc" },
    winrate: { winRatePct: "desc" },
    tvl: { pnlSol: "desc" },
    trades: { trades: "desc" },
  };

  const orderBy = orderByMap[sort] || orderByMap.pnl;

  const wallets = await prisma.trackedWallet.findMany({
    orderBy,
    take: limit,
    skip: offset,
  });

  const total = await prisma.trackedWallet.count();

  return {
    leaders: wallets.map(w => ({
      ...w,
      totalValueSol: w.pnlSol // Map pnlSol to expected field
    })),
    total,
    hasMore: offset + limit < total,
  };
}