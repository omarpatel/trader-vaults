// ── Performance optimizations ─────────────────────────────────────────
// Centralized performance middleware and utilities for the API

import { Request, Response, NextFunction } from 'express';
import { getOrSet, cacheGet } from './cache.js';

// ── Response compression middleware ──────────────────────────────────
// Compresses JSON responses to reduce bandwidth
export function compressionMiddleware(req: Request, res: Response, next: NextFunction) {
  // Check if client accepts compression
  const acceptEncoding = req.headers['accept-encoding'] || '';
  
  if (acceptEncoding.includes('gzip')) {
    res.setHeader('Content-Encoding', 'gzip');
  } else if (acceptEncoding.includes('deflate')) {
    res.setHeader('Content-Encoding', 'deflate');
  }
  
  next();
}

// ── Cache control middleware ────────────────────────────────────────
// Sets appropriate cache headers for different types of responses
export function cacheControl(maxAge: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET') {
      res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
    }
    next();
  };
}

// ── Request timing middleware ───────────────────────────────────────
// Logs slow requests for monitoring
export function requestTiming(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (duration > 1000) {
      console.warn(`[perf] Slow request: ${req.method} ${req.path} took ${duration}ms`);
    }
  });
  
  next();
}

// ── Cached route wrapper ───────────────────────────────────────────
// Wraps route handlers with automatic caching
export function cachedRoute<T>(
  keyPrefix: string,
  ttlMs: number,
  handler: (req: Request) => Promise<T>
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Generate cache key from URL and relevant query params
      const cacheKey = `${keyPrefix}:${req.path}:${JSON.stringify(req.query)}`;
      
      // Try to get from cache
      const cached = cacheGet<T>(cacheKey);
      if (cached !== undefined) {
        res.setHeader('X-Cache', 'HIT');
        return res.json(cached);
      }
      
      // Execute handler and cache result
      const result = await handler(req);
      await getOrSet(cacheKey, ttlMs, async () => result);
      
      res.setHeader('X-Cache', 'MISS');
      res.json(result);
    } catch (error) {
      next(error);
    }
  };
}

// ── Database query optimization hints ───────────────────────────────
// Constants for query optimization
export const QUERY_OPTS = {
  // Standard select with minimal fields
  LIGHT_SELECT: {
    select: {
      id: true,
      name: true,
      tvlSol: true,
      sharePriceSol: true,
      type: true,
      mode: true,
      status: true,
      traderId: true,
      createdAt: true,
    },
  },
  
  // Pagination defaults
  DEFAULT_PAGINATION: {
    take: 50,
    skip: 0,
  },
  
  // Cache TTLs (in milliseconds)
  CACHE_TTL: {
    SHORT: 30_000,      // 30 seconds - volatile data
    MEDIUM: 300_000,    // 5 minutes - semi-volatile
    LONG: 3_600_000,    // 1 hour - stable data
    VERY_LONG: 86_400_000, // 24 hours - very stable
  },
} as const;

// ── Batch processing utilities ───────────────────────────────────────
// Process items in batches to avoid memory issues
export async function processBatch<T, R>(
  items: T[],
  batchSize: number,
  processor: (batch: T[]) => Promise<R[]>
): Promise<R[]> {
  const results: R[] = [];
  
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await processor(batch);
    results.push(...batchResults);
  }
  
  return results;
}

// ── Memory usage monitoring ─────────────────────────────────────────
export function getMemoryUsage() {
  const usage = process.memoryUsage();
  return {
    heapUsed: `${Math.round(usage.heapUsed / 1024 / 1024)}MB`,
    heapTotal: `${Math.round(usage.heapTotal / 1024 / 1024)}MB`,
    external: `${Math.round(usage.external / 1024 / 1024)}MB`,
  };
}

// Log memory usage periodically (every 5 minutes)
if (process.env.NODE_ENV === 'production') {
  setInterval(() => {
    const mem = getMemoryUsage();
    console.log(`[perf] Memory: heap=${mem.heapUsed}/${mem.heapTotal}, external=${mem.external}`);
  }, 300_000);
}
