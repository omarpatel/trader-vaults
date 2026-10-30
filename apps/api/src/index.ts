// ── Trader Vaults API server ──────────────────────────────────────────────
import "./env.js"; // load .env files before anything reads process.env
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { env } from "./env.js";
import { requestTiming } from "./performance.js";
import { activityRouter } from "./routes/activity.js";
import { dcaRouter } from "./routes/dca.js";
import { healthRouter } from "./routes/health.js";
import { marksRouter } from "./routes/marks.js";
import { metaRouter } from "./routes/meta.js";
import { ohlcvRouter } from "./routes/ohlcv.js";
import { onchainRouter } from "./routes/onchain.js";
import { onchainWithdrawRouter } from "./routes/onchainWithdraw.js";
import { ordersRouter } from "./routes/orders.js";
import { poolTradesRouter } from "./routes/pooltrades.js";
import { portfolioRouter } from "./routes/portfolio.js";
import { pulseRouter } from "./routes/pulse.js";
import { securityRouter } from "./routes/security.js";
import { tokensRouter } from "./routes/tokens.js";
import { tokenStatsRouter } from "./routes/tokenstats.js";
import { tradersRouter } from "./routes/traders.js";
import { vaultsRouter } from "./routes/vaults.js";
import { vestedRouter } from "./routes/vested.js";
import { walletsRouter } from "./routes/wallets.js";
import { withdrawalsRouter } from "./routes/withdrawals.js";
import { leaderboardsRouter } from "./routes/leaderboards.js";
import { xOAuthRouter } from "./routes/xOAuth.js";
import { monitoringRouter } from "./routes/monitoring.js";
import { startMirrorEngine, stopMirrorEngine } from "./services/mirrorEngine.js";
import { startNavKeeper, stopNavKeeper } from "./services/navKeeper.js";
import { startOrderEngine, stopOrderEngine } from "./services/orderEngine.js";

const app = express();
app.use(requestTiming); // Track slow requests
app.use(cors());
app.use(express.json({ limit: "256kb" }));

app.use("/api/health", healthRouter);
app.use("/api/monitoring", monitoringRouter);
app.use("/api/vaults", vaultsRouter);
app.use("/api/tokens", tokensRouter);
app.use("/api/tokenstats", tokenStatsRouter);
app.use("/api/marks", marksRouter);
app.use("/api/traders", tradersRouter);
app.use("/api/pulse", pulseRouter);
app.use("/api/security", securityRouter);
app.use("/api/ohlcv", ohlcvRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/dca", dcaRouter);
app.use("/api/portfolio", portfolioRouter);
app.use("/api/wallets", walletsRouter);
app.use("/api/activity", activityRouter);
app.use("/api/pooltrades", poolTradesRouter);
app.use("/api/withdrawals", withdrawalsRouter);
app.use("/api/vested", vestedRouter);
app.use("/api/meta", metaRouter);
// Withdrawals are their own router so nothing in the deposit router's
// kill-switch path can ever be applied to an exit by accident.
app.use("/api/onchain/withdraw", onchainWithdrawRouter);
// Mounted AFTER the withdraw router: /api/onchain would otherwise match
// first and only fall through by accident.
app.use("/api/onchain", onchainRouter);
app.use("/api/leaderboards", leaderboardsRouter);
app.use("/api/auth", xOAuthRouter);

// ── production: this process also serves the built web app ─────────
// Railway runs Trader Vaults as ONE service — the API and the Vite build come
// off the same origin, so no CORS, no second deploy, no /api rewrite.
// Off in dev (env.serveStatic is false), where the Vite dev server owns
// the front end and proxies /api here: dev behaviour is unchanged.
//
// Mounted *after* every /api router and *before* the JSON 404, so the
// API surface is untouched and unknown /api paths still get JSON.
if (env.serveStatic) {
  const WEB_DIST = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  const INDEX_HTML = join(WEB_DIST, "index.html");

  if (existsSync(INDEX_HTML)) {
    // Vite emits content-hashed asset filenames → cache them hard.
    // index.html is the one file that must never be cached: it names the
    // hashed bundles, so a stale copy pins the browser to a dead deploy.
    app.use(
      express.static(WEB_DIST, {
        index: false,
        maxAge: "1y",
        setHeaders(res, filePath) {
          if (filePath.endsWith("index.html")) {
            res.setHeader("Cache-Control", "no-cache");
          }
        },
      }),
    );

    // SPA catch-all: every non-/api GET is a client-side route
    // (/explore, /vault/:id, /portfolio …). Hand back index.html so a
    // refresh or a pasted deep link renders instead of 404ing.
    // /api/* is excluded and falls through to the JSON 404 below.
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      if (req.path === "/api" || req.path.startsWith("/api/")) return next();
      // /assets/* is build output, never a client route. A missing file
      // there must 404 loudly — handing back index.html would surface as
      // a baffling "MIME type text/html" script error in the browser.
      if (req.path.startsWith("/assets/")) return next();
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(INDEX_HTML, (err) => {
        if (err) next(err);
      });
    });
    console.log(`[api] serving web build from ${WEB_DIST}`);
  } else {
    console.warn(
      `[api] SERVE_STATIC/production is on but no web build at ${WEB_DIST} — ` +
        "run `npm run build` at the repo root. Serving API only.",
    );
  }
}

// 404 — JSON, always
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "not found" });
});

// Error middleware — JSON errors, stack stays server-side. Client input
// errors (malformed JSON = 400, oversized body = 413 — body-parser sets
// err.status) must not be reported as server faults.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status =
    (err as { status?: number; statusCode?: number }).status ??
    (err as { statusCode?: number }).statusCode ??
    500;
  if (status >= 500) console.error("[api] unhandled error:", err);
  const message =
    status < 500
      ? status === 413
        ? "request body too large"
        : "malformed request body"
      : "internal error";
  res.status(status).json({ error: message });
});

const ROUTES: Array<[string, string]> = [
  ["GET ", "/api/health"],
  ["GET ", "/api/vaults?sort=&type=&mode="],
  ["GET ", "/api/vaults/:id"],
  ["GET ", "/api/vaults/:id/mirror"],
  ["POST", "/api/vaults"],
  ["GET ", "/api/vaults/:id/onchain?authority="],
  ["POST", "/api/vaults/:id/onchain/deposit"],
  ["POST", "/api/vaults/:id/deposit"],
  ["POST", "/api/vaults/:id/withdraw"],
  ["POST", "/api/vaults/:id/trade"],
  ["GET ", "/api/tokens?ids=a,b,c"],
  ["GET ", "/api/tokens/search?q="],
  ["GET ", "/api/tokens/trending"],
  ["GET ", "/api/tokens/:mint"],
  ["GET ", "/api/tokenstats/:mint"],
  ["GET ", "/api/traders/:handle"],
  ["GET ", "/api/pulse"],
  ["GET ", "/api/ohlcv/:mint?tf=1m|5m|15m|1h"],
  ["POST", "/api/orders"],
  ["GET ", "/api/orders?vaultId=&status="],
  ["POST", "/api/orders/:id/cancel"],
  ["*   ", "/api/dca (POST · GET ?vaultId= · POST /:id/cancel)"],
  ["GET ", "/api/portfolio"],
  ["GET ", "/api/wallets/tracked"],
  ["POST", "/api/wallets/tracked"],
  ["POST", "/api/wallets/tracked/:address/scan?force=1"],
  ["GET ", "/api/activity?limit=30&mode="],
  ["GET ", "/api/pooltrades/:mint"],
  ["POST", "/api/withdrawals/:id/execute"],
  ["GET ", "/api/vested?traderId=me"],
  ["POST", "/api/vested/:id/claim"],
  ["GET ", "/api/meta"],
  ["GET ", "/api/onchain/config · /api/onchain/me · /api/onchain/deposits"],
  ["POST", "/api/onchain/deposit/prepare  (unsigned tx for the USER to sign)"],
  ["POST", "/api/onchain/deposit/confirm  (verifies the signature on chain)"],
  ["GET ", "/api/security/:mint"],
];

// Bind 0.0.0.0 (env.host): a container listening on 127.0.0.1 is
// invisible to Railway's router and fails the /api/health check.
const server = app.listen(env.port, env.host, () => {
  console.log(`[api] trader-vaults api listening on http://${env.host}:${env.port}`);
  console.log(`[api] db: ${env.databaseUrl}`);
  for (const [method, path] of ROUTES) console.log(`  ${method} ${path}`);
  // Trigger engine + live revaluation + mirror sync only run alongside
  // the server — never during seed (seed.ts doesn't import this module).
  startOrderEngine();
  startMirrorEngine();
  // Real vaults revert deposits with NavStale an hour after their last
  // mark — this is the only thing that keeps them usable.
  startNavKeeper();
});

function shutdown(): void {
  stopOrderEngine();
  stopMirrorEngine();
  stopNavKeeper();
  server.close(() => process.exit(0));
  // failsafe if a keep-alive socket stalls close()
  setTimeout(() => process.exit(0), 3_000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
