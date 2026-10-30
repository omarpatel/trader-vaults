/** Reusable candlestick chart — the Terminal's lightweight-charts v4
 *  pattern extracted: create chart + series ONCE, setData on mint/tf
 *  change, refresh every 30s. Enhanced with professional animations and
 *  modern styling.
 */
import { useEffect, useRef, useState } from "react";
import {
  createChart,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { api } from "../lib/api";
import { Skeleton } from "./AnimatedComponents";

export const CANDLE_TFS = ["1m", "5m", "15m", "1h"] as const;
export type CandleTf = (typeof CANDLE_TFS)[number];

export function CandleChart({
  mint,
  tf,
  height = 420,
}: {
  mint: string;
  tf: CandleTf;
  height?: number;
}) {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartApi = useRef<IChartApi | null>(null);
  const seriesApi = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const hasData = useRef(false);
  const [pool, setPool] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [candleState, setCandleState] = useState<"loading" | "live" | "stale" | "none">("loading");
  const [isInteracting, setIsInteracting] = useState(false);

  useEffect(() => {
    if (!chartRef.current) return;
    
    const chart = createChart(chartRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#9a968a",
        fontFamily: "IBM Plex Mono, Consolas, monospace",
        fontSize: 11,
      },
      grid: { 
        vertLines: { 
          color: "rgba(26, 26, 24, 0.5)", 
          style: 1, // dashed
          visible: true,
        }, 
        horzLines: { 
          color: "rgba(26, 26, 24, 0.5)", 
          style: 1, // dashed
          visible: true,
        } 
      },
      rightPriceScale: { 
        borderColor: "#38382f",
        scaleMargins: {
          top: 0.1,
          bottom: 0.2,
        },
      },
      // scaleMargins is a price-scale option; it was set on timeScale,
      // where it is silently meaningless.
      timeScale: {
        borderColor: "#38382f",
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: { 
        vertLine: { 
          color: "#ffb000",
          width: 1,
          style: 2, // dashed
          labelBackgroundColor: "#ffb000",
        }, 
        horzLine: { 
          color: "#ffb000",
          width: 1,
          style: 2, // dashed
          labelBackgroundColor: "#ffb000",
        } 
      },
      height,
      autoSize: true,
      handleScale: true,
      handleScroll: true,
    });
    
    seriesApi.current = chart.addCandlestickSeries({
      upColor: "#2fd980",
      downColor: "#ff4f58",
      borderUpColor: "#2fd980",
      borderDownColor: "#ff4f58",
      wickUpColor: "#2fd980",
      wickDownColor: "#ff4f58",
      priceFormat: { type: "price", precision: 9, minMove: 0.000000001 },
    });

    // Add interaction tracking
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      setIsInteracting(true);
    });

    chartApi.current = chart;
    
    return () => {
      seriesApi.current = null;
      chartApi.current = null;
      chart.remove();
    };
  }, [height]);

  useEffect(() => {
    let alive = true;
    // token/timeframe change: clear the old series so nothing bleeds across
    hasData.current = false;
    seriesApi.current?.setData([]);
    setCandleState("loading");
    
    const load = () =>
      api
        .ohlcv(mint, tf)
        .then((r) => {
          if (!alive || !seriesApi.current || !chartApi.current) return;
          setPool(r.pool);
          setSource(r.source ?? null);
          
          if (r.candles.length === 0) {
            // failed refresh keeps the drawn chart — stale beats blank
            setCandleState(hasData.current ? "stale" : "none");
            return;
          }
          
          // strictly-ascending unique timestamps or lightweight-charts throws
          const clean = [...r.candles]
            .sort((a, b) => a.t - b.t)
            .filter((c, i, arr) => i === arr.length - 1 || c.t !== arr[i + 1]!.t);
          
          seriesApi.current.setData(
            clean.map((c) => ({
              time: c.t as UTCTimestamp,
              open: c.o,
              high: c.h,
              low: c.l,
              close: c.c,
            })),
          );
          
          // Smooth animation to fit content
          chartApi.current.timeScale().fitContent();
          hasData.current = true;
          setCandleState(r.stale ? "stale" : "live");
        })
        .catch(() => alive && setCandleState(hasData.current ? "stale" : "none"));
    
    load();
    const iv = setInterval(load, 30_000);
    
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [mint, tf]);

  // Reset interaction state after user stops interacting
  useEffect(() => {
    const timer = setTimeout(() => {
      setIsInteracting(false);
    }, 1000);
    return () => clearTimeout(timer);
  }, [isInteracting]);

  return (
    <>
      <div style={{ position: "relative" }}>
        <div 
          ref={chartRef} 
          style={{ 
            width: "100%",
            transition: "opacity 0.3s ease-in-out",
            opacity: candleState === "loading" ? 0.3 : 1,
          }} 
        />
        
        {/* Loading overlay with animation */}
        {candleState === "loading" && (
          <div 
            style={{ 
              position: "absolute", 
              inset: 0, 
              display: "grid", 
              placeItems: "center",
              background: "rgba(14, 14, 12, 0.8)",
              backdropFilter: "blur(4px)",
              zIndex: 10,
            }}
          >
            <div className="flex flex-col items-center gap-3 animate-in fade-in duration-300">
              <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <span className="mono dimtx text-sm">loading candles…</span>
            </div>
          </div>
        )}
        
        {/* Empty state */}
        {candleState === "none" && (
          <div 
            style={{ 
              position: "absolute", 
              inset: 0, 
              display: "grid", 
              placeItems: "center",
              background: "rgba(14, 14, 12, 0.6)",
            }}
          >
            <div className="text-center max-w-md px-6 animate-in fade-in duration-300">
              <div className="text-4xl mb-3">📊</div>
              <span className="mono dimtx text-sm">
                no pool candles yet — new tokens chart once they trade on a pool
              </span>
            </div>
          </div>
        )}
        
        {/* Stale data indicator with animation */}
        {candleState === "stale" && (
          <div className="animate-in fade-in slide-in-from-left-2 duration-300">
            <span
              className="pill stale"
              style={{ 
                position: "absolute", 
                top: 8, 
                left: 8,
                animation: "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
              }}
              title="Data source is rate-limited — showing the last good chart, retrying every 30s"
            >
              <span className="flex items-center gap-2">
                <span className="w-2 h-2 bg-amber-500 rounded-full animate-pulse" />
                stale — retrying
              </span>
            </span>
          </div>
        )}

        {/* Live indicator */}
        {candleState === "live" && !isInteracting && (
          <div className="animate-in fade-in slide-in-from-left-2 duration-300">
            <span
              className="pill live"
              style={{ 
                position: "absolute", 
                top: 8, 
                left: 8,
              }}
            >
              <span className="flex items-center gap-2">
                <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                live
              </span>
            </span>
          </div>
        )}
      </div>
      
      {/* Chart metadata with animation */}
      {(source || pool) && (
        <div 
          className="mono dimtx flex items-center justify-between"
          style={{ 
            fontSize: 10.5, 
            marginTop: 6,
            padding: "6px 10px",
            background: "rgba(14, 14, 12, 0.5)",
            borderRadius: "4px",
            border: "1px solid rgba(56, 56, 47, 0.5)",
          }}
        >
          <span className="flex items-center gap-2">
            <span className="text-gray-500">candles:</span>
            <span className="text-amber-400">
              {source === "pumpfun" ? "pump.fun" : source === "geckoterminal" ? "GeckoTerminal" : "—"}
            </span>
            {pool && (
              <span className="text-gray-500">
                · pool <span className="text-blue-400">{pool.slice(0, 10)}…</span>
              </span>
            )}
          </span>
          <span className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />
            <span>refreshes 30s</span>
          </span>
        </div>
      )}
    </>
  );
}

// ── Skeleton Loading State ──────────────────────────────────────────
export function CandleChartSkeleton({ height = 420 }: { height?: number }) {
  return (
    <div style={{ position: "relative", height }}>
      <Skeleton width="100%" height={height} variant="rectangular" />
      <div 
        style={{ 
          position: "absolute", 
          inset: 0, 
          display: "grid", 
          placeItems: "center",
        }}
      >
        <div className="flex flex-col items-center gap-3">
          <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <span className="mono dimtx text-sm">loading chart…</span>
        </div>
      </div>
    </div>
  );
}
