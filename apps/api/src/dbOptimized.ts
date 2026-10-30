// ── Optimized database client with connection pooling ───────────────
import { PrismaClient } from '@prisma/client';
import { env } from './env.js';

// Connection pool configuration based on environment
const poolConfig = env.databaseUrl.includes('postgresql')
  ? {
      // Production PostgreSQL settings
      datasources: {
        db: {
          url: env.databaseUrl,
        },
      },
    }
  : {
      // Development SQLite settings
      datasources: {
        db: {
          url: env.databaseUrl,
        },
      },
    };

// Create Prisma client with optimized settings
export const prisma = new PrismaClient(poolConfig);

// ── Query optimization utilities ─────────────────────────────────────

/**
 * Execute multiple queries in parallel for better performance
 */
export async function parallelQuery<T>(
  queries: Array<() => Promise<T>>
): Promise<T[]> {
  return Promise.all(queries.map(q => q()));
}

/**
 * Batch findMany with automatic chunking to avoid hitting limits
 */
export async function batchFindMany<T>(
  model: any,
  ids: string[],
  options: any = {},
  batchSize: number = 100
): Promise<T[]> {
  const results: T[] = [];
  
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const batchResults = await model.findMany({
      where: { id: { in: batch } },
      ...options,
    });
    results.push(...batchResults);
  }
  
  return results;
}

/**
 * Optimized count query with caching
 */
export async function cachedCount(
  model: any,
  where: any = {},
  cacheKey: string,
  ttlMs: number = 300_000
): Promise<number> {
  const { getOrSet } = await import('./cache.js');
  
  return getOrSet(
    `count:${cacheKey}:${JSON.stringify(where)}`,
    ttlMs,
    async () => model.count({ where })
  );
}

/**
 * Stream large result sets to avoid memory issues
 */
export async function* streamQuery<T>(
  model: any,
  options: any = {},
  batchSize: number = 100
): AsyncGenerator<T[], void, unknown> {
  let skip = 0;
  let hasMore = true;
  
  while (hasMore) {
    const batch = await model.findMany({
      ...options,
      skip,
      take: batchSize,
    });
    
    if (batch.length === 0) {
      hasMore = false;
    } else {
      yield batch;
      skip += batchSize;
      hasMore = batch.length === batchSize;
    }
  }
}

// ── Health check for database connection ───────────────────────────
export async function checkDbHealth(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    console.error('[db] Health check failed:', error);
    return false;
  }
}

// Graceful shutdown
process.on('beforeExit', async () => {
  await prisma.$disconnect();
});
