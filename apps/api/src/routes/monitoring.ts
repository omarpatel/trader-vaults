// ── Simple Monitoring Router (TypeScript Fix) ───────────────────
import { Router } from 'express';

export const monitoringRouter = Router();

// GET /api/monitoring/health - Simple health check
monitoringRouter.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime())
  });
});

// GET /api/monitoring/metrics - Basic metrics
monitoringRouter.get('/metrics', (_req, res) => {
  res.json({
    timestamp: new Date().toISOString(),
    system: {
      uptime: Math.floor(process.uptime()),
      memory: process.memoryUsage(),
      cpu: process.cpuUsage()
    }
  });
});