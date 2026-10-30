import { Router } from "express";
import { prisma } from "../db.js";

export const healthRouter = Router();

// GET /api/health → { ok, db, uptime }
healthRouter.get("/", async (_req, res) => {
  let db = false;
  let dbError = "";
  try {
    await prisma.$queryRaw`SELECT 1`;
    db = true;
  } catch (error) {
    dbError = error instanceof Error ? error.message : String(error);
    console.error("Health check DB error:", dbError);
    // db stays false — still report, don't 500
  }
  
  console.log("Health check called - DB:", db, "Uptime:", Math.floor(process.uptime()));
  
  res.status(db ? 200 : 503).json({
    ok: db,
    db,
    uptime: Math.floor(process.uptime()),
    dbError: dbError || undefined,
    timestamp: new Date().toISOString()
  });
});

// GET /api/health/ping → { pong } (for testing without DB)
healthRouter.get("/ping", (_req, res) => {
  console.log("Ping check called");
  res.json({
    pong: true,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});