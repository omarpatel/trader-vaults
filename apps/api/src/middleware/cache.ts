// ── API Response Caching Layer ─────────────────────────────────────
import { Request, Response, NextFunction } from 'express';

interface CacheEntry {
  data: any;
  timestamp: number;
  headers: any;
}

const cache = new Map<string, CacheEntry>();
const DEFAULT_TTL = 5 * 60 * 1000; // 5 minutes

export function cacheMiddleware(ttl: number = DEFAULT_TTL) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${req.method}:${req.originalUrl}`;
    
    // Check cache for GET requests
    if (req.method === 'GET') {
      const cached = cache.get(key);
      if (cached && Date.now() - cached.timestamp < ttl) {
        res.set('X-Cache', 'HIT');
        res.set('X-Cache-Age', `${Math.floor((Date.now() - cached.timestamp) / 1000)}s`);
        return res.json(cached.data);
      }
    }
    
    // Cache the response
    const originalJson = res.json;
    res.json = function(data: any) {
      if (req.method === 'GET' && res.statusCode < 400) {
        cache.set(key, {
          data,
          timestamp: Date.now(),
          headers: res.getHeaders()
        });
        res.set('X-Cache', 'MISS');
      }
      return originalJson.call(this, data);
    };
    
    next();
  };
}

// Cache invalidation
export function invalidateCache(pattern: string) {
  const regex = new RegExp(pattern);
  for (const key of cache.keys()) {
    if (regex.test(key)) {
      cache.delete(key);
    }
  }
}

// Warm up cache with frequently accessed data
export async function warmupCache(fetchFn: () => Promise<any>, key: string) {
  try {
    const data = await fetchFn();
    cache.set(key, {
      data,
      timestamp: Date.now(),
      headers: {}
    });
  } catch (error) {
    console.error(`Cache warmup failed for ${key}:`, error);
  }
}

// Cache statistics
export function getCacheStats() {
  const now = Date.now();
  let hits = 0;
  let misses = 0;
  let stale = 0;
  
  for (const [key, entry] of cache.entries()) {
    const age = now - entry.timestamp;
    if (age < DEFAULT_TTL) {
      // Would be a hit if requested
      hits++;
    } else {
      stale++;
    }
  }
  
  return {
    size: cache.size,
    hits,
    misses,
    stale,
    hitRate: hits / (hits + misses + 1)
  };
}