import { useState, useEffect, useCallback, useRef } from 'react';

// ── Performance-optimized data fetching hook ─────────────────────────
interface FetchOptions<T> {
  fetcher: () => Promise<T>;
  deps?: any[];
  /** State is `T | null` until the first fetch lands, so this admits null. */
  initialData?: T | null;
  cacheKey?: string;
  cacheTTL?: number;
  onSuccess?: (data: T) => void;
  onError?: (error: Error) => void;
}

interface FetchState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

// Simple in-memory cache
const fetchCache = new Map<string, { data: any; timestamp: number; ttl: number }>();

function getCached<T>(key: string): T | null {
  const cached = fetchCache.get(key);
  if (!cached) return null;
  
  const now = Date.now();
  if (now - cached.timestamp > cached.ttl) {
    fetchCache.delete(key);
    return null;
  }
  
  return cached.data as T;
}

function setCached<T>(key: string, data: T, ttl: number): void {
  fetchCache.set(key, {
    data,
    timestamp: Date.now(),
    ttl,
  });
}

export function useOptimizedFetch<T>({
  fetcher,
  deps = [],
  initialData = null,
  cacheKey,
  cacheTTL = 5 * 60 * 1000, // 5 minutes default
  onSuccess,
  onError,
}: FetchOptions<T>): FetchState<T> {
  const [data, setData] = useState<T | null>(initialData);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);
  
  const mountedRef = useRef(true);
  const abortControllerRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async () => {
    // Cancel previous request if still pending
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Check cache first
    if (cacheKey) {
      const cached = getCached<T>(cacheKey);
      if (cached !== null) {
        setData(cached);
        return;
      }
    }

    setLoading(true);
    setError(null);
    abortControllerRef.current = new AbortController();

    try {
      const result = await fetcher();
      
      if (!mountedRef.current) return;
      
      setData(result);
      
      // Cache the result
      if (cacheKey) {
        setCached(cacheKey, result, cacheTTL);
      }
      
      onSuccess?.(result);
    } catch (err) {
      if (!mountedRef.current) return;
      
      const error = err instanceof Error ? err : new Error('Unknown error');
      setError(error);
      onError?.(error);
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
      abortControllerRef.current = null;
    }
  }, [fetcher, cacheKey, cacheTTL, onSuccess, onError]);

  useEffect(() => {
    fetchData();

    return () => {
      mountedRef.current = false;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, deps);

  return {
    data,
    loading,
    error,
    refetch: fetchData,
  };
}

// ── Optimized polling hook ──────────────────────────────────────────
interface PollOptions<T> extends FetchOptions<T> {
  interval: number;
  enabled?: boolean;
}

export function useOptimizedPoll<T>(options: PollOptions<T>): FetchState<T> {
  const { interval, enabled = true, ...fetchOptions } = options;
  const { data, loading, error, refetch } = useOptimizedFetch({
    ...fetchOptions,
    deps: [...(fetchOptions.deps || []), enabled],
  });

  useEffect(() => {
    if (!enabled) return;

    const pollInterval = setInterval(() => {
      refetch();
    }, interval);

    return () => clearInterval(pollInterval);
  }, [interval, enabled, refetch]);

  return { data, loading, error, refetch };
}

// ── Optimized batch fetch hook ──────────────────────────────────────
interface BatchFetchOptions<T> {
  fetchers: Array<() => Promise<T>>;
  cacheKeys?: string[];
  cacheTTL?: number;
}

export function useOptimizedBatchFetch<T>({
  fetchers,
  cacheKeys,
  cacheTTL = 5 * 60 * 1000,
}: BatchFetchOptions<T>) {
  const [results, setResults] = useState<(T | null)[]>(new Array(fetchers.length).fill(null));
  const [loading, setLoading] = useState<boolean>(true);
  const [errors, setErrors] = useState<(Error | null)[]>(new Array(fetchers.length).fill(null));

  useEffect(() => {
    let mounted = true;

    const fetchAll = async () => {
      setLoading(true);
      const promises = fetchers.map(async (fetcher, index) => {
        try {
          // Check cache first
          if (cacheKeys?.[index]) {
            const cached = getCached<T>(cacheKeys[index]);
            if (cached !== null) {
              return cached;
            }
          }

          const result = await fetcher();
          
          // Cache the result
          if (cacheKeys?.[index]) {
            setCached(cacheKeys[index], result, cacheTTL);
          }
          
          return result;
        } catch (err) {
          return null;
        }
      });

      const fetchResults = await Promise.allSettled(promises);
      
      if (!mounted) return;

      const newResults: (T | null)[] = [];
      const newErrors: (Error | null)[] = [];

      fetchResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          newResults[index] = result.value;
          newErrors[index] = null;
        } else {
          newResults[index] = null;
          newErrors[index] = result.reason instanceof Error ? result.reason : new Error('Unknown error');
        }
      });

      setResults(newResults);
      setErrors(newErrors);
      setLoading(false);
    };

    fetchAll();

    return () => {
      mounted = false;
    };
  }, [fetchers.length, ...cacheKeys || []]);

  return { results, loading, errors };
}

// ── Cache management utilities ─────────────────────────────────────
export function clearFetchCache(pattern?: string): void {
  if (!pattern) {
    fetchCache.clear();
    return;
  }
  
  for (const key of fetchCache.keys()) {
    if (key.includes(pattern)) {
      fetchCache.delete(key);
    }
  }
}

export function getFetchCacheSize(): number {
  return fetchCache.size;
}
