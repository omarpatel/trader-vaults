import {
  PERF_FEE_DEFAULT_BPS,
  PERF_FEE_MAX_BPS,
  PERF_FEE_MIN_BPS,
  type Vault,
  type VaultMode,
  type VaultType,
} from "@trader-vaults/shared";
import { Router } from "express";
import { prisma } from "../db.js";
import { requirePrivyUser } from "../services/privyAuth.js";
import { env } from "../env.js";
import { crystallize, unlockAt } from "../services/fees.js";
import {
  initVaultOnChain,
  readOnChainVault,
} from "../services/onchainVaults.js";
import {
  MIN_DEPOSIT_LAMPORTS,
  StaleVaultLayoutError,
  solToLamports,
} from "../services/program.js";
import { OnChainError, getServerPublicKey, tryGetServerKeypair } from "../services/signer.js";
import { executeTrade, REAL_VAULT_WALL, TradeError } from "../services/trading.js";
import {
  assembleVault,
  assembleVaults,
  getDemoUser,
  realizedPnlByDay,
  toPosition,
  toTrade,
  toWithdrawRequest,
} from "../services/vaults.js";

export const vaultsRouter = Router();

/**
 * Real vaults a single trader may create per day.
 *
 * Each one costs the platform ~0.019 SOL it never gets back, and creation was
 * anonymous and unmetered: 26 were created in about two hours, several of them
 * obvious junk.
 */
const MAX_REAL_VAULTS_PER_DAY = 3;

const nowSec = () => Math.floor(Date.now() / 1000);

/** How far back the pnl calendar reaches. Roughly a half-year of squares. */
const CALENDAR_DAYS = 180;

type SortKey = "tvl" | "pnl7d" | "pnl30d" | "pnlAll" | "age" | "sharePrice";

const SORTERS: Record<SortKey, (a: Vault, b: Vault) => number> = {
  tvl: (a, b) => b.tvlSol - a.tvlSol,
  pnl7d: (a, b) => b.stats.pnlPct7d - a.stats.pnlPct7d,
  pnl30d: (a, b) => b.stats.pnlPct30d - a.stats.pnlPct30d,
  pnlAll: (a, b) => b.stats.pnlPctAll - a.stats.pnlPctAll,
  age: (a, b) => b.stats.ageDays - a.stats.ageDays,
  sharePrice: (a, b) => b.sharePriceSol - a.sharePriceSol,
};

// GET /api/vaults?sort=tvl|pnl7d|pnl30d|pnlAll|age|sharePrice&type=managed|mirror&mode=real|paper
// No mode param = ALL vaults — the web filters per surface.
vaultsRouter.get("/", async (req, res, next) => {
  try {
    const type = req.query.type as VaultType | undefined;
    if (type !== undefined && type !== "managed" && type !== "mirror") {
      res.status(400).json({ error: 'type must be "managed" or "mirror"' });
      return;
    }
    const mode = req.query.mode as VaultMode | undefined;
    if (mode !== undefined && mode !== "real" && mode !== "paper") {
      res.status(400).json({ error: 'mode must be "real" or "paper"' });
      return;
    }
    const sortKey = (req.query.sort as SortKey | undefined) ?? "tvl";
    // own-property lookup only: `?sort=constructor` would otherwise reach
    // an inherited Object.prototype member, pass the truthiness check and
    // crash Array.sort with a non-comparator
    const sorter = Object.prototype.hasOwnProperty.call(SORTERS, sortKey)
      ? SORTERS[sortKey]
      : undefined;
    if (!sorter) {
      res.status(400).json({ error: `sort must be one of ${Object.keys(SORTERS).join(", ")}` });
      return;
    }
    // List views get a downsampled curve (sparkline density).
    const vaults = await assembleVaults({ type, mode }, { curvePoints: 240 });
    vaults.sort(sorter);
    res.json({ vaults });
  } catch (err) {
    next(err);
  }
});

// GET /api/vaults/:id — vault + positions + last 50 trades + pending withdrawals
vaultsRouter.get("/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    const vault = await assembleVault(id);
    if (!vault) {
      res.status(404).json({ error: "vault not found" });
      return;
    }
    // The calendar needs the whole history, not the 50 rows the tape shows —
    // pairing a sell against its buy fails if the buy scrolled off.
    const calendarSince = nowSec() - CALENDAR_DAYS * 86_400;
    const [positions, trades, withdrawals, calendarTrades] = await Promise.all([
      prisma.position.findMany({ where: { vaultId: id }, orderBy: { valueSol: "desc" } }),
      prisma.trade.findMany({ where: { vaultId: id }, orderBy: { ts: "desc" }, take: 50 }),
      prisma.withdrawRequest.findMany({
        where: { vaultId: id, status: { in: ["pending", "executable"] } },
        orderBy: { requestedAt: "desc" },
      }),
      prisma.trade.findMany({ where: { vaultId: id, ts: { gte: calendarSince } }, orderBy: { ts: "asc" } }),
    ]);
    res.json({
      vault,
      positions: positions.map(toPosition),
      trades: trades.map(toTrade),
      pendingWithdrawals: withdrawals.map(toWithdrawRequest),
      pnlCalendar: realizedPnlByDay(calendarTrades),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/vaults/:id/mirror — mirror copy config + sync state. Kept as
// its own endpoint because the shared Vault shape has no mirror-config
// fields (packages/shared is not extended here). fixedSol/maxSol report
// the EFFECTIVE values (engine defaults applied when the row is null).
vaultsRouter.get("/:id/mirror", async (req, res, next) => {
  try {
    const vault = await prisma.vault.findUnique({ where: { id: req.params.id } });
    if (!vault) {
      res.status(404).json({ error: "vault not found" });
      return;
    }
    if (vault.type !== "mirror") {
      res.status(404).json({ error: "not a mirror vault" });
      return;
    }
    res.json({
      config: {
        sizingMode: vault.mirrorSizingMode ?? "fixed",
        fixedSol: vault.mirrorFixedSol ?? 0.25,
        maxSol: vault.mirrorMaxSol ?? 1.0,
      },
      leaderWallet: vault.leaderWallet,
      lastSig: vault.mirrorLastSig,
      syncedAt: vault.mirrorSyncedAt,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/vaults — create a vault (demo user becomes the trader).
// mode defaults to "real" when omitted: the MAIN platform is real SOL.
// Creating a real vault is just a DB row — its on-chain init is pending,
// and every ledger operation against it is walled until the program ships.
// Mirror vaults additionally accept mirrorSizingMode ("fixed" |
// "proportional"), mirrorFixedSol (0.01–100) and mirrorMaxSol
// (>= fixed); omitted values fall back to the engine defaults
// (fixed, 0.25 SOL, cap 1.0 SOL).
vaultsRouter.post("/", async (req, res, next) => {
  try {
    const {
      name,
      type,
      mode,
      perfFeeBps,
      thesis,
      leaderWallet,
      mirrorSizingMode,
      mirrorFixedSol,
      mirrorMaxSol,
    } = (req.body ?? {}) as {
      name?: string;
      type?: string;
      mode?: string;
      perfFeeBps?: number;
      thesis?: string;
      leaderWallet?: string;
      mirrorSizingMode?: string;
      mirrorFixedSol?: number;
      mirrorMaxSol?: number;
    };
    if (!name || typeof name !== "string" || name.trim().length < 3) {
      res.status(400).json({ error: "name must be at least 3 characters" });
      return;
    }
    // Upper bound matters as much as the lower one: an unbounded name is
    // rendered in every table, ticker and <select>, and one 10k-char name
    // blew the vault tables out to 75,000px, pushing TVL and performance
    // off-screen for EVERY other vault (audit).
    if (name.trim().length > 60) {
      res.status(400).json({ error: "name must be 60 characters or fewer" });
      return;
    }
    if (thesis !== undefined && typeof thesis !== "string") {
      res.status(400).json({ error: "thesis must be a string" });
      return;
    }
    if (typeof thesis === "string" && thesis.trim().length > 500) {
      res.status(400).json({ error: "thesis must be 500 characters or fewer" });
      return;
    }
    if (type !== "managed" && type !== "mirror") {
      res.status(400).json({ error: 'type must be "managed" or "mirror"' });
      return;
    }
    const vaultMode: VaultMode = mode === undefined ? "real" : (mode as VaultMode);
    if (vaultMode !== "real" && vaultMode !== "paper") {
      res.status(400).json({ error: 'mode must be "real" or "paper"' });
      return;
    }
    if (
      type === "mirror" &&
      (typeof leaderWallet !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(leaderWallet))
    ) {
      // a truthy non-string used to reach Prisma and 500
      res.status(400).json({ error: "mirror vaults require a valid base58 leaderWallet" });
      return;
    }
    // ── mirror copy config (mirror vaults only) ──────────────────────
    if (
      type !== "mirror" &&
      (mirrorSizingMode !== undefined || mirrorFixedSol !== undefined || mirrorMaxSol !== undefined)
    ) {
      res.status(400).json({ error: "mirror sizing config only applies to mirror vaults" });
      return;
    }
    if (
      mirrorSizingMode !== undefined &&
      mirrorSizingMode !== "fixed" &&
      mirrorSizingMode !== "proportional"
    ) {
      res.status(400).json({ error: 'mirrorSizingMode must be "fixed" or "proportional"' });
      return;
    }
    if (
      mirrorFixedSol !== undefined &&
      (typeof mirrorFixedSol !== "number" || !Number.isFinite(mirrorFixedSol) ||
        mirrorFixedSol < 0.01 || mirrorFixedSol > 100)
    ) {
      res.status(400).json({ error: "mirrorFixedSol must be a number between 0.01 and 100" });
      return;
    }
    // max must cover the effective fixed size (default 0.25 when omitted)
    const effectiveFixed = mirrorFixedSol ?? 0.25;
    if (
      mirrorMaxSol !== undefined &&
      (typeof mirrorMaxSol !== "number" || !Number.isFinite(mirrorMaxSol) ||
        mirrorMaxSol < effectiveFixed)
    ) {
      res.status(400).json({
        error: `mirrorMaxSol must be a number >= the fixed copy size (${effectiveFixed})`,
      });
      return;
    }
    const fee = Math.min(
      PERF_FEE_MAX_BPS,
      Math.max(PERF_FEE_MIN_BPS, Math.round(Number(perfFeeBps) || PERF_FEE_DEFAULT_BPS)),
    );
    // Whoever is signed in owns the vault they create.
    //
    // This was getDemoUser() unconditionally, so every vault ever created was
    // assigned to the same "you" account regardless of who made it. That made
    // vault ownership meaningless — and with creator-fee distribution paying
    // out per vault, it would have paid every share to one account.
    //
    // Falls back to the demo user only for PAPER vaults, and only when there
    // is no Privy session — which is what keeps local demo mode working.
    //
    // For a REAL vault the fallback is refused. Creating one spends about
    // 0.019 SOL of platform SOL that never comes back (rent for the 1095-byte
    // account plus the economically-burned seed deposit), and anonymous
    // callers assigned every vault to the one shared "you" account: all 26
    // real rows on this deployment are owned by the demo user, which makes
    // ownership meaningless and breaks creator-fee attribution.
    let trader;
    try {
      ({ user: trader } = await requirePrivyUser(req));
    } catch {
      if (vaultMode === "real") {
        res.status(401).json({ error: "sign in to create a real vault", code: "auth_required" });
        return;
      }
      trader = await getDemoUser();
    }

    // Bound the spend independently of auth: Privy accounts are free to mint,
    // so a session is not a budget.
    if (vaultMode === "real") {
      const since = new Date(Date.now() - 24 * 3600 * 1000);
      const recent = await prisma.vault.count({
        where: { traderId: trader.id, mode: "real", createdAt: { gte: since } },
      });
      if (recent >= MAX_REAL_VAULTS_PER_DAY) {
        res.status(429).json({
          error: `you can create ${MAX_REAL_VAULTS_PER_DAY} real vaults per day; you have created ${recent}`,
          code: "rate_limited",
        });
        return;
      }
    }
    const created = await prisma.vault.create({
      data: {
        name: name.trim(),
        type,
        mode: vaultMode,
        status: "active",
        traderId: trader.id,
        leaderWallet: type === "mirror" ? leaderWallet : null,
        mirrorSizingMode: type === "mirror" ? (mirrorSizingMode ?? null) : null,
        mirrorFixedSol: type === "mirror" ? (mirrorFixedSol ?? null) : null,
        mirrorMaxSol: type === "mirror" ? (mirrorMaxSol ?? null) : null,
        tvlSol: 0,
        sharePriceSol: 1,
        totalShares: 0,
        managerStakeSol: 0,
        perfFeeBps: fee,
        redeemWindowHours: 24,
        solBufferSol: 0,
        thesis: thesis?.trim() || null,
      },
    });
    const t0 = nowSec();
    // equity curve is PER-SHARE value; a fresh vault starts at 1.0
    await prisma.equityPoint.upsert({
      where: { vaultId_t: { vaultId: created.id, t: t0 } },
      update: { v: 1 },
      create: { vaultId: created.id, t: t0, v: 1 },
    });

    // ── real vaults are created ON-CHAIN, not in this database ───────
    // The row above is an index entry; init_vault is what actually
    // creates the vault. The PDA seed is the row id, so the account is
    // re-derivable from the row alone.
    //
    // Failure policy: if the program rejects init_vault, the row is
    // DELETED and the request fails — a "real" vault with no on-chain
    // account would be a lie that the deposit path could not honour.
    // The one tolerated gap is a missing server keypair (prod has none
    // yet): the row survives, onchain stays null, and the response says
    // so out loud.
    let onchain: Record<string, unknown> | null = null;
    if (vaultMode === "real") {
      const key = tryGetServerKeypair();
      if ("error" in key) {
        onchain = { status: "skipped", reason: key.error };
        console.warn(`[api] vault ${created.id} created OFF-chain only: ${key.error}`);
      } else {
        try {
          const result = await initVaultOnChain({
            id: created.id,
            type,
            perfFeeBps: fee,
            redeemWindowHours: 24,
          });
          await prisma.vault.update({
            where: { id: created.id },
            data: {
              onchainVaultPda: result.vaultPda,
              onchainInitSig: result.signature || null,
            },
          });
          onchain = { status: result.signature ? "created" : "already_existed", ...result };
        } catch (err) {
          await prisma.vault.delete({ where: { id: created.id } }).catch(() => {});
          if (err instanceof OnChainError) {
            res.status(502).json({ error: "on-chain vault creation failed", ...err.toJson() });
            return;
          }
          res.status(502).json({
            error: `on-chain vault creation failed: ${(err as Error).message}`,
          });
          return;
        }
      }
    }

    const vault = await assembleVault(created.id);
    res.status(201).json({ vault, ...(onchain ? { onchain } : {}) });
  } catch (err) {
    next(err);
  }
});

// POST /api/vaults/:id/trade — DEMO trade execution at the LIVE oracle
// price. Body: { side: "buy"|"sell", mint, solAmount? (buy),
// sellFraction? 0-1 (sell) }. Responds with the shared TradeResult
// shape { trade, position, vault } (position null when the sell closed
// it). 422 when the oracle has no live mark — we never fabricate.
vaultsRouter.post("/:id/trade", async (req, res, next) => {
  try {
    // AUTH + OWNERSHIP. This route had neither, and it dispatches into
    // executeVaultSwap, which signs with the SERVER keypair. Anyone who could
    // reach the URL could move a real vault's SOL through Jupiter; the only
    // thing stopping it was that no real vault had a funded buffer yet.
    //
    // Only the vault's own trader may trade it. The demo-user fallback is kept
    // for PAPER vaults so local demo mode still works, and refused for real.
    const vaultRow = await prisma.vault.findUnique({
      where: { id: req.params.id },
      select: { id: true, mode: true, traderId: true },
    });
    if (!vaultRow) {
      res.status(404).json({ error: "vault not found" });
      return;
    }
    let caller;
    try {
      ({ user: caller } = await requirePrivyUser(req));
    } catch {
      if (vaultRow.mode === "real") {
        res.status(401).json({ error: "sign in to trade a real vault", code: "auth_required" });
        return;
      }
      caller = await getDemoUser();
    }
    if (caller.id !== vaultRow.traderId) {
      res.status(403).json({
        error: "only this vault's trader can place its trades",
        code: "not_the_trader",
      });
      return;
    }

    const body = (req.body ?? {}) as {
      side?: "buy" | "sell";
      mint?: string;
      solAmount?: number;
      sellFraction?: number;
    };
    const result = await executeTrade(req.params.id, {
      side: body.side as "buy" | "sell",
      mint: body.mint as string,
      solAmount: body.solAmount,
      sellFraction: body.sellFraction,
    });
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof TradeError) {
      // err.body carries exact wire shapes (e.g. the real-vault wall)
      res.status(err.status).json(err.body ?? { error: err.message });
      return;
    }
    next(err);
  }
});

// POST /api/vaults/:id/deposit { sol } — DEMO ledger operation: adjusts
// tvl/shares/buffer and records a Deposit row. No chain interaction.
vaultsRouter.post("/:id/deposit", async (req, res, next) => {
  try {
    const sol = Number((req.body ?? {}).sol);
    if (!Number.isFinite(sol) || sol <= 0) {
      res.status(400).json({ error: "sol must be a positive number" });
      return;
    }
    // 1e307 SOL made tokenAmount overflow to Infinity and 500 the trade
    if (sol > 1_000_000_000) {
      res.status(400).json({ error: "sol exceeds the maximum deposit (1e9)" });
      return;
    }
    const dbVault = await prisma.vault.findUnique({ where: { id: req.params.id } });
    if (!dbVault) {
      res.status(404).json({ error: "vault not found" });
      return;
    }
    if (dbVault.mode === "real") {
      // THE WALL: real-vault deposits are on-chain transfers, not ledger rows
      res.status(409).json(REAL_VAULT_WALL);
      return;
    }
    if (dbVault.status !== "active") {
      res.status(409).json({ error: `vault is ${dbVault.status}` });
      return;
    }
    const user = await getDemoUser();
    const sharePrice = dbVault.sharePriceSol > 0 ? dbVault.sharePriceSol : 1;
    const shares = sol / sharePrice;
    const [deposit] = await prisma.$transaction([
      prisma.deposit.create({
        data: { vaultId: dbVault.id, userId: user.id, shares, costSol: sol },
      }),
      // per-depositor ledger — the cost basis fees crystallize against
      prisma.vaultDepositor.upsert({
        where: { vaultId_userId: { vaultId: dbVault.id, userId: user.id } },
        update: { shares: { increment: shares }, costSol: { increment: sol } },
        create: { vaultId: dbVault.id, userId: user.id, shares, costSol: sol },
      }),
      prisma.vault.update({
        where: { id: dbVault.id },
        data: {
          tvlSol: { increment: sol },
          totalShares: { increment: shares },
          solBufferSol: { increment: sol },
        },
      }),
      // deposits mint at the current share price and do not move it —
      // record the unchanged per-share value
      prisma.equityPoint.upsert({
        where: { vaultId_t: { vaultId: dbVault.id, t: nowSec() } },
        update: { v: sharePrice },
        create: { vaultId: dbVault.id, t: nowSec(), v: sharePrice },
      }),
    ]);
    const vault = await assembleVault(dbVault.id);
    res.status(201).json({ deposit: { id: deposit.id, shares, costSol: sol }, vault });
  } catch (err) {
    next(err);
  }
});

// POST /api/vaults/:id/withdraw { shares } — DEMO ledger operation.
// Instant when the SOL buffer covers it, otherwise windowed by
// redeemWindowHours (request sits "pending" until executableAt).
vaultsRouter.post("/:id/withdraw", async (req, res, next) => {
  try {
    const shares = Number((req.body ?? {}).shares);
    if (!Number.isFinite(shares) || shares <= 0) {
      res.status(400).json({ error: "shares must be a positive number" });
      return;
    }
    const dbVault = await prisma.vault.findUnique({ where: { id: req.params.id } });
    if (!dbVault) {
      res.status(404).json({ error: "vault not found" });
      return;
    }
    if (dbVault.mode === "real") {
      // THE WALL: real-vault withdrawals (instant AND windowed) are on-chain
      res.status(409).json(REAL_VAULT_WALL);
      return;
    }
    const user = await getDemoUser();

    // held/basis come from the per-depositor ledger; pending (unexecuted)
    // requests still reserve their shares
    const [depositor, pendingReqs] = await Promise.all([
      prisma.vaultDepositor.findUnique({
        where: { vaultId_userId: { vaultId: dbVault.id, userId: user.id } },
      }),
      prisma.withdrawRequest.aggregate({
        where: {
          vaultId: dbVault.id,
          userId: user.id,
          status: { in: ["pending", "executable"] },
        },
        _sum: { shares: true },
      }),
    ]);
    const held = (depositor?.shares ?? 0) - (pendingReqs._sum.shares ?? 0);
    if (!depositor || shares > held + 1e-9) {
      res.status(400).json({ error: `insufficient shares (held: ${Math.max(0, held).toFixed(4)})` });
      return;
    }

    const valueSol = shares * dbVault.sharePriceSol;
    const instant = valueSol <= dbVault.solBufferSol;
    const now = nowSec();

    if (instant) {
      // crystallize the 70/30 split against this portion's cost basis
      const fees = crystallize({
        grossSol: valueSol,
        positionCostSol: depositor.costSol,
        shares,
        positionShares: depositor.shares,
        perfFeeBps: dbVault.perfFeeBps,
      });
      const unlocksAt = unlockAt(now);
      const request = await prisma.$transaction(async (tx) => {
        // CONDITIONAL, atomic debits. The held/buffer checks above are a
        // fast path only — concurrent withdrawals all read the same stale
        // snapshot, so unguarded decrements let 12 shares redeem against
        // 10 held and drove totalShares/tvl/buffer negative (audit),
        // which also made the holding vanish from the portfolio.
        const burned = await tx.vaultDepositor.updateMany({
          where: { id: depositor.id, shares: { gte: shares } },
          data: {
            shares: { decrement: shares },
            costSol: { decrement: fees.costBasisSol },
            cumulativeTraderFeeSol: { increment: fees.traderFeeSol },
          },
        });
        if (burned.count === 0) {
          throw new TradeError(400, "insufficient shares (concurrent withdrawal)");
        }
        const paid = await tx.vault.updateMany({
          where: {
            id: dbVault.id,
            totalShares: { gte: shares },
            solBufferSol: { gte: valueSol },
          },
          data: {
            // gross leaves depositor equity; fees move from the buffer
            // into the accrual buckets (owed, outside tvl). Only the
            // IMMEDIATE leg is credited as spendable trader fees — the
            // vested leg is tracked separately and locked (below).
            tvlSol: { decrement: valueSol },
            totalShares: { decrement: shares },
            solBufferSol: { decrement: valueSol },
            traderFeesAccruedSol: { increment: fees.traderFeeSol },
            vestedFeesAccruedSol: { increment: fees.traderVestedSol },
          },
        });
        if (paid.count === 0) {
          throw new TradeError(409, "vault buffer insufficient — try a windowed withdrawal");
        }
        // The escrowed third: one tranche per crystallization, locked
        // 60 days from this moment. Zero-profit exits create nothing.
        if (fees.traderVestedSol > 0) {
          await tx.vestedFee.create({
            data: {
              vaultId: dbVault.id,
              traderId: dbVault.traderId,
              amountSol: fees.traderVestedSol,
              crystallizedAt: now,
              unlocksAt,
              status: "locked",
              escrowWallet: env.feeEscrowWallet ?? null,
            },
          });
        }
        // a fair-priced withdrawal leaves per-share value unchanged
        await tx.equityPoint.upsert({
          where: { vaultId_t: { vaultId: dbVault.id, t: now } },
          update: { v: dbVault.sharePriceSol },
          create: { vaultId: dbVault.id, t: now, v: dbVault.sharePriceSol },
        });
        return tx.withdrawRequest.create({
          data: {
            vaultId: dbVault.id,
            userId: user.id,
            shares,
            valueAtRequestSol: valueSol,
            requestedAt: now,
            executableAt: now,
            status: "paid",
          },
        });
      });
      res.status(201).json({ mode: "instant", request: toWithdrawRequest(request), fees });
      return;
    }

    // Windowed: funds move — and fees crystallize — when the request
    // executes after the window (at worse-of pricing).
    const request = await prisma.withdrawRequest.create({
      data: {
        vaultId: dbVault.id,
        userId: user.id,
        shares,
        valueAtRequestSol: valueSol,
        requestedAt: now,
        executableAt: now + dbVault.redeemWindowHours * 3600,
        status: "pending",
      },
    });
    res.status(201).json({ mode: "windowed", request: toWithdrawRequest(request) });
  } catch (err) {
    if (err instanceof TradeError) {
      res.status(err.status).json(err.body ?? { error: err.message });
      return;
    }
    next(err);
  }
});

// ── EXPLICITLY ON-CHAIN ROUTES ──────────────────────────────────────
// The only routes a real vault may use. Everything else in this file
// keeps hitting THE WALL (REAL_VAULT_WALL) for real vaults — these do
// not weaken it, they are the other side of it: they never touch the
// demo ledger, they only build, sign and send program instructions and
// read the resulting account state back.

// GET /api/vaults/:id/onchain — decoded live program state for a real
// vault. `?authority=<base58>` also returns that key's VaultDepositor
// record (defaults to the server key, which is the depositor of record
// for server-signed devnet deposits).
vaultsRouter.get("/:id/onchain", async (req, res, next) => {
  try {
    const dbVault = await prisma.vault.findUnique({ where: { id: req.params.id } });
    if (!dbVault) {
      res.status(404).json({ error: "vault not found" });
      return;
    }
    if (dbVault.mode !== "real") {
      res.status(409).json({ error: "paper vaults have no on-chain state" });
      return;
    }
    if (!dbVault.onchainVaultPda) {
      res.status(409).json({ error: "vault has no on-chain account (init_vault never landed)" });
      return;
    }
    const authorityParam = req.query.authority;
    let authority: string | undefined;
    if (typeof authorityParam === "string" && authorityParam.length > 0) {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(authorityParam)) {
        res.status(400).json({ error: "authority must be a base58 pubkey" });
        return;
      }
      authority = authorityParam;
    } else {
      const key = tryGetServerKeypair();
      authority = "error" in key ? undefined : key.keypair.publicKey.toBase58();
    }
    let view;
    try {
      view = await readOnChainVault(dbVault.onchainVaultPda, authority);
    } catch (e) {
      // A vault written by the previous program layout cannot be decoded. That
      // is a known, operator-fixable state (scripts/migrate-vaults.mjs), not a
      // server fault, and 500ing on it took the whole vault page down with an
      // error nobody reading it could act on.
      if (e instanceof StaleVaultLayoutError) {
        res.status(409).json({
          error:
            "this vault is still on the previous on-chain layout and is being migrated",
          code: "legacy_vault_needs_migration",
          vaultPda: dbVault.onchainVaultPda,
        });
        return;
      }
      throw e;
    }
    if (!view) {
      res.status(502).json({
        error: "on-chain vault account not found",
        code: "vault_missing_onchain",
        vaultPda: dbVault.onchainVaultPda,
      });
      return;
    }
    res.json({ id: dbVault.id, initSig: dbVault.onchainInitSig, ...view });
  } catch (err) {
    next(err);
  }
});

// POST /api/vaults/:id/onchain/deposit — DELETED.
//
// It signed a REAL deposit with getServerKeypair(), had no authentication of
// any kind, bypassed the DEPOSITS_OPEN kill switch entirely, and accepted up
// to 1000 SOL per call. Its own docblock called it a "DEVNET PROOF PATH", but
// this deployment runs mainnet-beta, so the lamports were real, they came out
// of the platform hot wallet, and the shares minted to the platform key rather
// than to any user — so the SOL was not even recoverable through a withdrawal.
//
// It could not land only because no vault had a reachable on-chain account.
// Migrating the vaults would have turned it into an anonymous drain of the hot
// wallet, which is why it is gone rather than gated.
//
// The path that belongs on mainnet is the user-signed one:
//   POST /api/onchain/deposit/prepare  -> unsigned tx for the USER to sign
//   POST /api/onchain/deposit/confirm  -> verified on chain before recording
