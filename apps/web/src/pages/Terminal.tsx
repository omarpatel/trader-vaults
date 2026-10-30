import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { TokenSearchBox } from "../components/TokenSearchBox";
import {
  createChart,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import {
  fmtSol,
  fmtSubscriptPrice,
  fmtUsd,
  shortAddr,
  solscanTx,
  type Order,
  type OrderKind,
  type Position,
  type TokenInfo,
  type TokenPoolStats,
  type Trade,
  type Vault,
} from "@trader-vaults/shared";
import { api, type DcaOrder } from "../lib/api";
import { useFlash, usePageTitle, usePoll } from "../lib/hooks";
import { liveMark, useMarks } from "../lib/marks";
import { CHART_LAYERS, useChartLayers } from "../lib/chartLayers";
import { avgEntryUsd, buildMarkers } from "../lib/chartMarkers";
import { usePresets } from "../lib/presets";
import { useWatchlist } from "../lib/watchlist";
import { useToast } from "../lib/toast";
import { Skeleton } from "../components/bits";
import { TokenFacts } from "../components/TokenFacts";
import { RatioBar, TimeframeStrip } from "../components/market";

const TFS = ["1s", "15s", "30s", "1m", "5m", "15m", "1h"] as const;
type Tf = (typeof TFS)[number];

/**
 * Refetch a fraction of each bar's width — a 1m chart on a flat 30s timer
 * looked frozen. Matches the server's per-timeframe candle cache, so a
 * faster poll here never costs an extra upstream call.
 */
/** Bar width in seconds — used to bucket the forming candle. */
const TF_SECONDS: Record<Tf, number> = {
  "1s": 1,
  "15s": 15,
  "30s": 30,
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3_600,
};

/**
 * What each MEV mode costs you. A protection setting whose tradeoff is
 * unstated is worse than no setting — people pick "secure" and then blame
 * the terminal for being slow.
 */
function mevHint(mode: string): string {
  switch (mode) {
    case "off":
      return "off — broadcast normally. Fastest, and sandwichable.";
    case "reduced":
      return "reduced — some protection, small latency cost.";
    case "secure":
      return "secure — routed to protect against sandwiching. Slowest, and can miss fast moves.";
    default:
      return mode;
  }
}

const CANDLE_POLL_MS: Record<Tf, number> = {
  // Upstream sits 2-7s behind wall clock even on a busy token, so polling
  // a 1s chart faster than ~1.2s only spends rate limit.
  "1s": 1_200,
  "15s": 4_000,
  "30s": 8_000,
  "1m": 5_000,
  "5m": 10_000,
  "15m": 20_000,
  "1h": 45_000,
};

// pump.fun tokens only — default to a deep-liquidity graduated pump token;
// discovery (trending rail, search, Pulse) surfaces nothing else.
const DEFAULT_MINT = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump"; // Fartcoin

const ORDER_KINDS: { id: OrderKind; label: string; side: "sell" | "buy" }[] = [
  { id: "take_profit", label: "Take profit", side: "sell" },
  { id: "stop_loss", label: "Stop loss", side: "sell" },
  { id: "limit_buy_dip", label: "Buy the dip", side: "buy" },
  { id: "limit_buy_breakout", label: "Buy breakout", side: "buy" },
];

export function Terminal({ mode = "real" }: { mode?: "real" | "paper" }) {
  usePageTitle(mode === "paper" ? "Paper terminal" : "Terminal");
  const paper = mode === "paper";
  const toast = useToast();

  const [params] = useSearchParams();
  const paramMint = params.get("mint");
  const [mint, setMint] = useState(
    paramMint && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(paramMint) ? paramMint : DEFAULT_MINT,
  );
  // navigating here again with a different ?mint= swaps the chart
  useEffect(() => {
    if (paramMint && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(paramMint)) setMint(paramMint);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramMint]);
  // Chart state is deep-linkable: ?tf=1s&quote=SOL&denom=mcap. Sharing a
  // chart should share what you were actually looking at, not drop the
  // reader on the default.
  const paramTf = params.get("tf");
  const [tf, setTf] = useState<Tf>(
    TFS.includes(paramTf as Tf) ? (paramTf as Tf) : "5m",
  );
  const [rail, setRail] = useState<"trade" | "orders" | "dca">("trade");
  const [denom, setDenom] = useState<"usd" | "mcap">(
    params.get("denom") === "mcap" ? "mcap" : "usd",
  );
  const [supplyUi, setSupplyUi] = useState<number | null>(null);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("1");
  const [busy, setBusy] = useState(false);
  const [slippage, setSlippage] = useState("2");
  const [prio, setPrio] = useState("0.001");
  const [mev, setMev] = useState<"off" | "reduced" | "secure">("reduced");
  const { presets, active, setActive } = usePresets();
  const { toggle: toggleWatch, isWatched } = useWatchlist();

  function applyPreset(i: number) {
    setActive(i);
    const p = presets[i]!;
    setSide("buy");
    setAmount(String(p.buySol));
    setSlippage(String(p.slippagePct));
    setPrio(String(p.prioSol));
    setMev(p.mev);
  }

  // vault being traded
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [vaultId, setVaultId] = useState<string | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [vaultTrades, setVaultTrades] = useState<Trade[]>([]);

  // order form
  const [orderKind, setOrderKind] = useState<OrderKind>("take_profit");
  const [trigger, setTrigger] = useState("");
  const [orderAmt, setOrderAmt] = useState("1");

  // DCA form
  const [dcaAmt, setDcaAmt] = useState("0.5");
  const [dcaEveryMin, setDcaEveryMin] = useState("5");
  const [dcaLegs, setDcaLegs] = useState("6");
  const { data: dcas, setData: setDcas } = usePoll<DcaOrder[]>(
    () => (vaultId ? api.dcaList(vaultId) : Promise.resolve([])),
    15_000,
    [vaultId],
  );

  const { data: info } = usePoll<TokenInfo>(() => api.token(mint), 10_000, [mint]);
  const { data: poolStats } = usePoll<TokenPoolStats>(() => api.tokenStats(mint), 30_000, [mint]);

  const { data: trending } = usePoll(() => api.trending(), 120_000, []);
  const { data: poolTape } = usePoll(() => api.poolTrades(mint), 15_000, [mint]);
  const { data: orders, setData: setOrders } = usePoll<Order[]>(
    () => (vaultId ? api.orders(vaultId) : Promise.resolve([])),
    10_000,
    [vaultId],
  );

  // chart
  const chartRef = useRef<HTMLDivElement>(null);
  const chartApi = useRef<IChartApi | null>(null);
  const seriesApi = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const rawCandles = useRef<{ t: number; o: number; h: number; l: number; c: number }[]>([]);
  const [pool, setPool] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [candleState, setCandleState] = useState<"loading" | "live" | "stale" | "none">("loading");

  // supply powers the Price/MCap denomination toggle — memecoin traders think in mcap
  useEffect(() => {
    let alive = true;
    setSupplyUi(null);
    fetch(`/api/security/${mint}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((s: { supplyUi?: number | null } | null) => {
        if (alive) setSupplyUi(s?.supplyUi ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [mint]);

  useEffect(() => {
    api.vaults({ mode }).then((vs) => {
      setVaults(vs);
      if (vs.length > 0 && !vaultId) setVaultId(vs[0]!.id);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(() => {
    if (!vaultId) return;
    let alive = true;
    const load = () =>
      api.vault(vaultId).then((d) => {
        if (!alive) return;
        setPositions(d.positions);
        setVaultTrades(d.trades);
        setVaults((vs) => vs.map((v) => (v.id === d.vault.id ? d.vault : v)));
      }).catch(() => {});
    load();
    const iv = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [vaultId]);

  useEffect(() => {
    if (!chartRef.current) return;
    const chart = createChart(chartRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#9a968a",
        fontFamily: "IBM Plex Mono, Consolas, monospace",
        fontSize: 11,
      },
      grid: { vertLines: { color: "#1c1c18" }, horzLines: { color: "#1c1c18" } },
      rightPriceScale: { borderColor: "#38382f" },
      timeScale: { borderColor: "#38382f", timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { color: "#545447" }, horzLine: { color: "#545447" } },
      height: 420,
      autoSize: true,
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
    chartApi.current = chart;
    return () => {
      seriesApi.current = null;
      chartApi.current = null;
      chart.remove();
    };
  }, []);

  // one poller covers the charted token and every open position, so PnL
  // moves with the market instead of waiting on the server's revaluation
  const markMints = useMemo(
    () => [...new Set([mint, ...positions.map((p) => p.mint)])],
    [mint, positions],
  );
  const marks = useMarks(markMints);
  const livePriceUsd = marks.get(mint)?.priceUsd ?? info?.priceUsd;
  const priceFlash = useFlash(livePriceUsd);
  // SOL/USD straight from this token's own mark — priceUsd and priceSol
  // are two views of the same quote, so their ratio is the SOL price with
  // no extra request and no chance of the two drifting apart.
  const solUsd = (() => {
    const m = marks.get(mint);
    return m && m.priceSol > 0 ? m.priceUsd / m.priceSol : undefined;
  })();

  // ── chart overlay layers ─────────────────────────────────────────
  const { layers, toggle: toggleLayer } = useChartLayers();
  const [layerMenu, setLayerMenu] = useState(false);
  const activeLayerCount = CHART_LAYERS.filter((l) => layers[l.id]).length;
  // tracked wallets change rarely; this only decides marker colour
  const { data: tracked } = usePoll(() => api.trackedWallets(), 300_000, []);
  const trackedSet = useMemo(
    () => new Set((tracked ?? []).map((w) => w.address)),
    [tracked],
  );


  /** Below a minute the axis must print seconds or every bar reads the same. */
  useEffect(() => {
    chartApi.current?.applyOptions({
      timeScale: { timeVisible: true, secondsVisible: TF_SECONDS[tf] < 60 },
    });
  }, [tf]);

  /**
   * Chart quote currency. The vault holds SOL and its PnL is booked in SOL,
   * so on a USD chart a position can look green purely because SOL rallied.
   */
  const [quote, setQuote] = useState<"USD" | "SOL">(
    params.get("quote") === "SOL" ? "SOL" : "USD",
  );

  const [candleVer, setCandleVer] = useState(0);
  /** Chart subject last auto-framed — see the fit guard below. */
  const fitKey = useRef<string>("");
  /**
   * Newest bar time written to the series. lightweight-charts throws if
   * update() is handed a time older than the last one it saw, and the
   * candle feed can hand back a window that ends BEHIND a bar we already
   * drew — so every update() is gated on this rather than on our own clock.
   */
  const lastSeriesTime = useRef<number>(0);
  /** Average-entry line, redrawn whenever the position or scale changes. */
  const avgLine = useRef<ReturnType<ISeriesApi<"Candlestick">["createPriceLine"]> | null>(null);

  useEffect(() => {
    let alive = true;
    // token/timeframe changed — old candles must never bleed across
    rawCandles.current = [];
    setCandleVer((v) => v + 1);
    setCandleState("loading");
    const load = (force = false) => {
      // A backgrounded terminal on 1s would poll ~50x/min forever. Every
      // other poller in the app pauses when hidden; this one was a bare
      // setInterval and did not.
      if (document.hidden && !force) return;

      const held = rawCandles.current;
      // ask only for what we don't have — a full 1s window is ~85KB, the
      // delta is a couple hundred bytes
      const since = held.length > 0 ? held[held.length - 1]!.t : undefined;
      return api
        .ohlcv(mint, tf, since, quote)
        .then((r) => {
          if (!alive) return;
          setPool(r.pool);
          setSource(r.source ?? null);

          if (r.partial && r.gap) {
            // the server's window no longer reaches back to what we hold —
            // merging would splice an invisible hole into the series
            rawCandles.current = [];
            return;
          }

          if (r.candles.length > 0) {
            if (r.partial && held.length > 0) {
              // merge by timestamp: the newest held bar is usually still
              // forming and comes back with updated OHLC under the same t
              const byTs = new Map(held.map((c) => [c.t, c]));
              for (const c of r.candles) byTs.set(c.t, c);
              rawCandles.current = [...byTs.values()].sort((a, b) => a.t - b.t);
            } else {
              rawCandles.current = r.candles;
            }
            setCandleVer((v) => v + 1);
            setCandleState(r.stale ? "stale" : "live");
          } else if (r.partial && held.length > 0) {
            // nothing new since our newest bar — normal at 1s, not an error
            setCandleState(r.stale ? "stale" : "live");
          } else if (held.length > 0) {
            // failed refresh — keep what the user is looking at
            setCandleState("stale");
          } else {
            setCandleState("none");
          }
        })
        .catch(() => {
          if (!alive) return;
          setCandleState(rawCandles.current.length > 0 ? "stale" : "none");
        });
    };
    load(true);
    const iv = setInterval(() => load(), CANDLE_POLL_MS[tf]);
    const onVis = () => {
      if (!document.hidden) void load(true);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [mint, tf, quote]);

  // render pipeline: raw candles × denomination scale + vault trade markers
  useEffect(() => {
    const series = seriesApi.current;
    const chart = chartApi.current;
    if (!series || !chart) return;
    // MCap is supply x USD price. On a SOL-quoted chart that product is not
    // a market cap, so the denomination toggle only applies in USD.
    const mcapMode = denom === "mcap" && quote === "USD" && supplyUi !== null && supplyUi > 0;
    const scale = mcapMode ? supplyUi : 1;
    series.applyOptions({
      priceFormat: mcapMode
        ? { type: "volume" }
        : { type: "price", precision: 9, minMove: 0.000000001 },
    });
    // lightweight-charts requires STRICTLY ascending times — upstream
    // candles can carry duplicate buckets, so sort + dedupe (last wins)
    const clean = [...rawCandles.current]
      .sort((a, b) => a.t - b.t)
      .filter((c, i, arr) => i === arr.length - 1 || c.t !== arr[i + 1]!.t);
    series.setData(
      clean.map((c) => ({
        time: c.t as UTCTimestamp,
        open: c.o * scale,
        high: c.h * scale,
        low: c.l * scale,
        close: c.c * scale,
      })),
    );
    lastSeriesTime.current = clean[clean.length - 1]?.t ?? 0;

    // every enabled layer, merged into one strictly-ordered series
    const first = clean[0]?.t ?? 0;
    series.setMarkers(
      buildMarkers({
        mint,
        firstTs: first,
        layers,
        vaultTrades,
        poolTrades: poolTape ?? null,
        trackedWallets: trackedSet,
      }),
    );

    // Only frame the chart when its subject changes. Refitting on every
    // refresh would throw away the user's zoom and pan several times a
    // minute — the faster the poll, the worse it gets.
    const subject = `${mint}:${tf}:${denom}`;
    if (fitKey.current !== subject && clean.length > 0) {
      fitKey.current = subject;
      chart.timeScale().fitContent();
    }
  }, [candleVer, denom, quote, supplyUi, vaultTrades, mint, tf, layers, poolTape, trackedSet]);

  // detect order fills → toast
  const prevOrders = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (!orders) return;
    for (const o of orders) {
      const prev = prevOrders.current.get(o.id);
      if (prev === "open" && o.status === "filled") {
        toast("good", `${o.kind.replace(/_/g, " ")} filled: ${o.symbol}`);
      }
      if (prev === "open" && o.status === "failed") {
        toast("bad", `${o.kind.replace(/_/g, " ")} failed: ${o.failReason ?? o.symbol}`);
      }
      prevOrders.current.set(o.id, o.status);
    }
  }, [orders, toast]);

  const vault = vaults.find((v) => v.id === vaultId) ?? null;
  // ── average entry line ───────────────────────────────────────────
  // Where you're actually break-even, drawn on the same scale as the
  // candles. Without it you're reading PnL in a table and price on a
  // chart and doing the comparison in your head on every tick.
  useEffect(() => {
    const series = seriesApi.current;
    if (!series) return;
    if (avgLine.current) {
      series.removePriceLine(avgLine.current);
      avgLine.current = null;
    }
    const held = positions.find((p) => p.mint === mint) ?? null;
    if (!layers.avgEntry || !held) return;
    // avgEntryUsd is, as named, in USD. Drawing it on a SOL-quoted chart
    // would put the line about 500x off. Cost basis in SOL per token is
    // exactly costSol/amountTokens, so quote it directly instead.
    const entry =
      quote === "SOL"
        ? held.amountTokens > 0 && held.costSol > 0
          ? held.costSol / held.amountTokens
          : null
        : avgEntryUsd(held, solUsd);
    if (entry === null) return;
    const mcapMode = denom === "mcap" && supplyUi !== null && supplyUi > 0;
    const scale = mcapMode ? supplyUi : 1;
    const m = marks.get(mint);
    const live = quote === "SOL" ? m?.priceSol : m?.priceUsd;
    const pct = live && entry > 0 ? ((live - entry) / entry) * 100 : null;
    avgLine.current = series.createPriceLine({
      price: entry * scale,
      color: "#ffb000",
      lineWidth: 1,
      lineStyle: 2, // dashed
      axisLabelVisible: true,
      title: pct === null ? "avg entry" : `avg entry ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`,
    });
  }, [positions, mint, layers.avgEntry, denom, quote, supplyUi, marks, solUsd]);

  // ── the forming candle ───────────────────────────────────────────
  // Upstream only hands back whole bars, so between refreshes the right
  // edge of the chart sat still. Extend the current bucket from the live
  // mark instead — the same thing a real terminal does — and open a new
  // bar when the clock rolls into the next bucket. Incremental update()
  // only, so this never disturbs zoom, pan or markers.
  useEffect(() => {
    const series = seriesApi.current;
    const mark = marks.get(mint);
    if (!series || !mark || mark.priceUsd <= 0) return;
    const bars = rawCandles.current;
    const last = bars[bars.length - 1];
    if (!last) return; // nothing charted yet — wait for the first fetch
    // the mark used below is priceUsd; on a SOL chart it is the wrong unit
    if (quote !== "USD") return;

    const width = TF_SECONDS[tf];
    // Sub-minute charts do NOT get a synthetic bar.
    //
    // At a 1-minute width, extending the open bar from a live price mark is
    // fair: that minute is genuinely still forming and the price is real.
    // At a 1-second width it is not — pump.fun emits a 1s bar only for
    // seconds that actually traded, so appending one for the current second
    // would draw a print that never happened. The upstream is already ~2-3s
    // behind here and polled every 1.2s, so there is nothing to gain by
    // faking the gap.
    if (width < 60) return;
    const bucket = Math.floor(Date.now() / 1000 / width) * width;
    // a bucket behind the newest bar means upstream is ahead of us; leave it
    if (bucket < last.t) return;

    if (bucket > last.t) {
      bars.push({ t: bucket, o: mark.priceUsd, h: mark.priceUsd, l: mark.priceUsd, c: mark.priceUsd });
    } else {
      last.c = mark.priceUsd;
      if (mark.priceUsd > last.h) last.h = mark.priceUsd;
      if (mark.priceUsd < last.l) last.l = mark.priceUsd;
    }

    const bar = bars[bars.length - 1]!;
    if (bar.t < lastSeriesTime.current) return; // would throw
    lastSeriesTime.current = bar.t;
    const mcapMode = denom === "mcap" && supplyUi !== null && supplyUi > 0;
    const scale = mcapMode ? supplyUi : 1;
    series.update({
      time: bar.t as UTCTimestamp,
      open: bar.o * scale,
      high: bar.h * scale,
      low: bar.l * scale,
      close: bar.c * scale,
    });
  }, [marks, mint, tf, denom, quote, supplyUi]);

  // ── trade feed ───────────────────────────────────────────────────
  // One tape, three lenses. "You" is the honest one: paper fills are
  // ledger entries with no signature, so they say "ledger" instead of
  // linking to a transaction that does not exist.
  // Highest close on the candles currently loaded. Deliberately not called
  // an all-time high — it is only as deep as the window fetched.
  const periodHighUsd = useMemo(() => {
    const bars = rawCandles.current;
    if (bars.length === 0) return null;
    return bars.reduce((m, c) => (c.h > m ? c.h : m), 0) || null;
    // candleVer ticks on every refresh, which is exactly when this changes
  }, [candleVer]);

  const [tapeTab, setTapeTab] = useState<"all" | "tracked" | "mine">("all");

  const trackedLabels = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of tracked ?? []) m.set(w.address, w.label || shortAddr(w.address, 4));
    return m;
  }, [tracked]);

  interface TapeRow {
    key: string;
    ts: number;
    side: "buy" | "sell";
    amountUsd: number | null;
    priceUsd: number;
    wallet: string | null;
    txSig: string | null;
    mine: boolean;
    trackedLabel: string | null;
  }

  const poolRows = useMemo<TapeRow[]>(
    () =>
      (poolTape ?? []).map((t) => ({
        key: t.txSig,
        ts: t.ts,
        side: t.side,
        amountUsd: t.amountUsd,
        priceUsd: t.priceUsd,
        wallet: t.wallet,
        txSig: t.txSig,
        mine: false,
        trackedLabel: trackedLabels.get(t.wallet) ?? null,
      })),
    [poolTape, trackedLabels],
  );

  const myRows = useMemo<TapeRow[]>(
    () =>
      vaultTrades
        .filter((t) => t.mint === mint)
        .map((t) => ({
          key: t.id,
          ts: t.ts,
          side: t.side,
          amountUsd: solUsd ? t.solAmount * solUsd : null,
          priceUsd: solUsd ? t.priceSol * solUsd : 0,
          wallet: null,
          // paper fills carry a "demo-" sentinel, not a signature — linking
          // one to an explorer would be inventing a transaction
          txSig: t.txSig.startsWith("demo-") ? null : t.txSig,
          mine: true,
          trackedLabel: null,
        })),
    [vaultTrades, mint, solUsd],
  );

  const tapeCounts = useMemo(
    () => ({
      tracked: poolRows.filter((r) => r.trackedLabel).length,
      mine: myRows.length,
    }),
    [poolRows, myRows],
  );

  const tapeRows = useMemo(() => {
    const rows =
      tapeTab === "mine"
        ? myRows
        : tapeTab === "tracked"
          ? poolRows.filter((r) => r.trackedLabel)
          : // "All" interleaves your own fills so you can see them in context
            [...poolRows, ...myRows];
    return rows.sort((a, b) => b.ts - a.ts).slice(0, 12);
  }, [tapeTab, poolRows, myRows]);

  const heldPosition = positions.find((p) => p.mint === mint) ?? null;
  const amountNum = parseFloat(amount) || 0;

  async function executeTrade() {
    if (!vaultId || !info) return;
    setBusy(true);
    try {
      const r =
        side === "buy"
          ? await api.trade(vaultId, { side: "buy", mint, solAmount: amountNum })
          : await api.trade(vaultId, { side: "sell", mint, sellFraction: amountNum / 100 });
      toast(
        "good",
        side === "buy"
          ? `Bought ${info.symbol}: ${fmtSol(r.trade.solAmount)} ◎ @ ${fmtUsd(info.priceUsd)}`
          : `Sold ${(amountNum).toFixed(0)}% of ${info.symbol}: +${fmtSol(r.trade.solAmount)} ◎`,
      );
      setVaults((vs) => vs.map((v) => (v.id === r.vault.id ? r.vault : v)));
      setPositions((ps) => {
        const rest = ps.filter((p) => p.mint !== mint);
        return r.position ? [...rest, r.position] : rest;
      });
    } catch (e) {
      toast("bad", e instanceof Error ? e.message : "trade failed");
    } finally {
      setBusy(false);
    }
  }

  async function placeOrder() {
    if (!vaultId || !info) return;
    const t = parseFloat(trigger) || 0;
    if (t <= 0) return;
    const kindMeta = ORDER_KINDS.find((k) => k.id === orderKind)!;
    setBusy(true);
    try {
      const o = await api.placeOrder({
        vaultId,
        mint,
        kind: orderKind,
        triggerPriceUsd: t,
        ...(kindMeta.side === "buy"
          ? { amountSol: parseFloat(orderAmt) || 1 }
          : { sellFraction: (parseFloat(orderAmt) || 100) / 100 }),
      });
      setOrders((os) => [o, ...(os ?? [])]);
      toast("info", `${kindMeta.label} armed at ${fmtUsd(t)}`);
      setTrigger("");
    } catch (e) {
      toast("bad", e instanceof Error ? e.message : "order failed");
    } finally {
      setBusy(false);
    }
  }

  const openOrders = useMemo(() => (orders ?? []).filter((o) => o.status === "open"), [orders]);
  const kindMeta = ORDER_KINDS.find((k) => k.id === orderKind)!;

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>{paper ? "Paper terminal" : "Terminal"}</h1>
          <div className="sub">
            {paper
              ? "Sandbox — fills are ledger entries at live market prices, never on-chain. Records stay in the paper column, separate from real track records."
              : "Real SOL only. Charts and prices are live; execution unlocks with the on-chain program."}
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <div style={{ width: 300 }}>
            <TokenSearchBox
              onPick={(r) => setMint(r.mint)}
              placeholder="load a token into the chart…"
            />
          </div>
          {paper && <span className="pill paper" style={{ fontSize: 12, padding: "5px 12px" }}>PAPER SANDBOX</span>}
        </div>
      </div>

      {!paper && (
        <div className="callout" style={{ marginBottom: 14 }}>
          <strong>Real execution is not live yet.</strong> This terminal never simulates. The vault
          program is <strong>live on mainnet</strong>; buttons switch on once trades are signed
          as you (Privy) and the NAV keeper is funded.{" "}
          Want to practice meanwhile? The{" "}
          <Link to="/paper">paper terminal</Link> runs the full engine at live prices, clearly
          labeled.
        </div>
      )}

      {positions.length > 0 && (
        <div className="posbar">
          {positions.map((p) => {
            const m = liveMark(p, marks.get(p.mint));
            return (
              <button key={p.id} className={`poschip ${p.mint === mint ? "on" : ""}`} onClick={() => setMint(p.mint)}>
                <span style={{ fontWeight: 700 }}>{p.symbol}</span>
                <span className="num">{fmtSol(m.valueSol)}◎</span>
                <span className={`num ${m.pnlPct >= 0 ? "pos" : "neg"}`}>
                  {m.pnlPct >= 0 ? "+" : ""}
                  {m.pnlPct.toFixed(1)}%
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className="termgrid">
        {/* ── chart ── */}
        <div className="sg-head">
          <div className="panel panel-pad" style={{ marginBottom: 14 }}>
            <div className="tokhead" style={{ marginBottom: 10 }}>
              {info ? (
                <>
                  <button
                    onClick={() => toggleWatch(mint, info.symbol)}
                    title={isWatched(mint) ? "Unwatch" : "Watch — pins to the topbar"}
                    style={{
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      fontSize: 16,
                      color: isWatched(mint) ? "var(--amber)" : "var(--dim)",
                    }}
                  >
                    ★
                  </button>
                  <span className="mono" style={{ fontSize: 18, fontWeight: 700 }}>{info.symbol}</span>
                  <span
                    className={`price ${priceFlash === "up" ? "flash-up" : priceFlash === "down" ? "flash-down" : ""}`}
                  >
                    {fmtSubscriptPrice(livePriceUsd ?? info.priceUsd)}
                  </span>
                  {info.change24hPct !== undefined && (
                    <span className={`num ${(info.change24hPct ?? 0) >= 0 ? "pos" : "neg"}`}>
                      {(info.change24hPct ?? 0) >= 0 ? "+" : ""}
                      {(info.change24hPct ?? 0).toFixed(1)}%
                    </span>
                  )}
                  <span className="mono dimtx" style={{ fontSize: 11 }}>
                    {info.mcapUsd ? `mcap ${fmtUsd(info.mcapUsd)}` : ""}
                    {info.liquidityUsd ? ` · liq ${fmtUsd(info.liquidityUsd)}` : ""}
                    {` · src ${info.source}`}
                  </span>
                </>
              ) : (
                <Skeleton h={26} w={280} />
              )}
              <span style={{ flex: 1 }} />
              <div className="viewtoggle" title={supplyUi ? "Chart denomination" : "MCap needs supply — loading"}>
                <button className={denom === "usd" ? "on" : ""} onClick={() => setDenom("usd")}>
                  Price
                </button>
                <button
                  className={denom === "mcap" ? "on" : ""}
                  disabled={!supplyUi}
                  onClick={() => setDenom("mcap")}
                >
                  MCap
                </button>
              </div>
              <div className="viewtoggle" title="Chart quote currency">
                <button className={quote === "USD" ? "on" : ""} onClick={() => setQuote("USD")}>
                  USD
                </button>
                <button
                  className={quote === "SOL" ? "on" : ""}
                  title="The vault books PnL in SOL — a USD chart moves when SOL moves"
                  onClick={() => setQuote("SOL")}
                >
                  SOL
                </button>
              </div>
              <div className="chipsrow">
                {TFS.map((t) => (
                  <button key={t} className={`chip ${tf === t ? "on" : ""}`} onClick={() => setTf(t)}>
                    {t}
                  </button>
                ))}
              </div>
              <div className="layermenu">
                <button
                  className={`chip ${layerMenu ? "on" : ""}`}
                  onClick={() => setLayerMenu((v) => !v)}
                  title="What the chart draws on top of the candles"
                >
                  Display {activeLayerCount > 0 && <span className="num">{activeLayerCount}</span>} ▾
                </button>
                {layerMenu && (
                  <>
                    {/* click-away catcher — a menu that only closes via its own
                        button is the classic way to trap someone mid-trade */}
                    <div className="layerscrim" onClick={() => setLayerMenu(false)} />
                    <div className="layerpop">
                      {CHART_LAYERS.map((l) => (
                        <button
                          key={l.id}
                          className={`layeropt ${layers[l.id] ? "on" : ""}`}
                          onClick={() => toggleLayer(l.id)}
                        >
                          <span className="box">{layers[l.id] ? "✓" : ""}</span>
                          <span>
                            <span className="lbl">{l.label}</span>
                            <span className="hint">{l.hint}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
            <div style={{ display: "flex", gap: 12, alignItems: "stretch", marginBottom: 10, flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 280px" }}>
                <TimeframeStrip stats={poolStats ?? null} />
              </div>
              {poolStats?.txns.h24 && (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="dimtx mono" style={{ fontSize: 9.5, letterSpacing: "0.14em" }}>TXNS 24H</span>
                  <RatioBar a={poolStats.txns.h24.buys} b={poolStats.txns.h24.sells} width={120} />
                </div>
              )}
            </div>
            <div style={{ position: "relative" }}>
              <div ref={chartRef} style={{ width: "100%" }} />
              {candleState === "loading" && (
                <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
                  <span className="mono dimtx">loading candles…</span>
                </div>
              )}
              {candleState === "none" && (
                <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
                  <span className="mono dimtx">no pool candles yet — new tokens chart once they trade on a pool</span>
                </div>
              )}
              {candleState === "stale" && (
                <span
                  className="pill stale"
                  style={{ position: "absolute", top: 8, left: 8 }}
                  title="Data source is rate-limited — showing the last good chart, retrying every 30s"
                >
                  stale — retrying
                </span>
              )}
            </div>
            {(source || pool) && (
              <div className="mono dimtx" style={{ fontSize: 10.5, marginTop: 6 }}>
                candles: {source === "pumpfun" ? "pump.fun" : source === "geckoterminal" ? "GeckoTerminal" : "—"}
                {pool ? ` · pool ${pool.slice(0, 10)}…` : ""}
                {` · refreshes ${CANDLE_POLL_MS[tf] / 1000}s`}
                {source === "geckoterminal" && TF_SECONDS[tf] < 60 && (
                  // GeckoTerminal has no sub-minute granularity — say so
                  // rather than letting a 1m chart pass as a 1s one
                  <span className="neg"> · 1m bars (source has no sub-minute)</span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── positions, tape, orders ── */}
        <div className="sg-body">
          <div className="sectiontitle" style={{ marginTop: 0 }}>
            {vault ? `${vault.name} — open positions` : "Open positions"}
          </div>
          <div className="panel" style={{ marginBottom: 14 }}>
            {positions.length === 0 ? (
              <div className="empty">No open positions — vault is all SOL</div>
            ) : (
              <div className="tablewrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Token</th>
                      <th className="r">Value</th>
                      <th className="r">PnL</th>
                      <th className="r">Quick sell</th>
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map((p) => {
                      const m = liveMark(p, marks.get(p.mint));
                      return (
                      <tr key={p.id}>
                        <td>
                          <button
                            className="chip"
                            style={{ border: "none", padding: "2px 6px" }}
                            onClick={() => setMint(p.mint)}
                          >
                            {p.symbol}
                          </button>
                          {p.markStale && <span className="pill stale" style={{ marginLeft: 6 }}>stale</span>}
                        </td>
                        <td className="r num">{fmtSol(m.valueSol)} ◎</td>
                        <td className="r num">
                          <span className={m.pnlSol >= 0 ? "pos" : "neg"}>
                            {m.pnlSol >= 0 ? "+" : ""}
                            {fmtSol(m.pnlSol)} ◎
                          </span>
                        </td>
                        <td className="r">
                          <button
                            className="btn ghost sm"
                            title="Sell exactly your initial cost — keep the rest as a free ride"
                            disabled={!paper || busy || !vaultId || m.valueSol <= p.costSol}
                            onClick={() => {
                              void (async () => {
                                if (!vaultId) return;
                                const frac = Math.min(0.999, p.costSol / m.valueSol);
                                setBusy(true);
                                try {
                                  const r = await api.trade(vaultId, { side: "sell", mint: p.mint, sellFraction: frac });
                                  toast("good", `${p.symbol}: initials out (+${fmtSol(r.trade.solAmount)} ◎) — free bag riding`);
                                  setVaults((vs) => vs.map((v) => (v.id === r.vault.id ? r.vault : v)));
                                  setPositions((ps) => {
                                    const rest = ps.filter((x) => x.mint !== p.mint);
                                    return r.position ? [...rest, r.position] : rest;
                                  });
                                } catch (e) {
                                  toast("bad", e instanceof Error ? e.message : "sell failed");
                                } finally {
                                  setBusy(false);
                                }
                              })();
                            }}
                          >
                            init
                          </button>
                          {[25, 50, 100].map((pct) => (
                            <button
                              key={pct}
                              className="btn ghost sm"
                              style={{ marginLeft: 4 }}
                              disabled={!paper || busy || !vaultId}
                              onClick={() => {
                                setMint(p.mint);
                                void (async () => {
                                  if (!vaultId) return;
                                  setBusy(true);
                                  try {
                                    const r = await api.trade(vaultId, {
                                      side: "sell",
                                      mint: p.mint,
                                      sellFraction: pct / 100,
                                    });
                                    toast("good", `Sold ${pct}% of ${p.symbol}: +${fmtSol(r.trade.solAmount)} ◎`);
                                    setVaults((vs) => vs.map((v) => (v.id === r.vault.id ? r.vault : v)));
                                    setPositions((ps) => {
                                      const rest = ps.filter((x) => x.mint !== p.mint);
                                      return r.position ? [...rest, r.position] : rest;
                                    });
                                  } catch (e) {
                                    toast("bad", e instanceof Error ? e.message : "sell failed");
                                  } finally {
                                    setBusy(false);
                                  }
                                })();
                              }}
                            >
                              {pct}%
                            </button>
                          ))}
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="sectiontitle tapehead">
            <span>Trade feed</span>
            <div className="chipsrow">
              {(["all", "tracked", "mine"] as const).map((t) => (
                <button
                  key={t}
                  className={`chip ${tapeTab === t ? "on" : ""}`}
                  onClick={() => setTapeTab(t)}
                >
                  {t === "all" ? "All" : t === "tracked" ? "Tracked" : "You"}
                  {t !== "all" && tapeCounts[t] > 0 && <span className="num"> {tapeCounts[t]}</span>}
                </button>
              ))}
            </div>
          </div>
          <div className="panel" style={{ marginBottom: 14 }}>
            {tapeRows.length === 0 ? (
              <div className="empty">
                {tapeTab === "mine"
                  ? "No fills from this vault on this token yet"
                  : tapeTab === "tracked"
                    ? "None of the wallets you track have touched this token"
                    : "No recent pool trades surfaced"}
              </div>
            ) : (
              <div className="tablewrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Age</th>
                      <th>Side</th>
                      <th className="r">USD</th>
                      <th className="r">Price</th>
                      <th className="r">Wallet</th>
                      <th className="r">Tx</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tapeRows.map((t) => {
                      const age = Math.max(1, Math.floor(Date.now() / 1000 - t.ts));
                      const ageStr = age < 60 ? `${age}s` : age < 3600 ? `${Math.floor(age / 60)}m` : `${Math.floor(age / 3600)}h`;
                      return (
                        <tr key={t.key} className={t.mine ? "rowmine" : t.trackedLabel ? "rowtracked" : undefined}>
                          <td className="num dimtx">{ageStr}</td>
                          <td>
                            <span className={`num ${t.side === "buy" ? "pos" : "neg"}`}>
                              {t.side.toUpperCase()}
                            </span>
                          </td>
                          <td className="r num">{t.amountUsd === null ? "—" : fmtUsd(t.amountUsd)}</td>
                          <td className="r num dimtx">{fmtUsd(t.priceUsd)}</td>
                          <td className="r num">
                            {t.mine ? (
                              <span className="pill you">you</span>
                            ) : t.trackedLabel ? (
                              <span className="pill tracked" title={t.wallet ?? ""}>{t.trackedLabel}</span>
                            ) : (
                              <span className="dimtx">{t.wallet ? shortAddr(t.wallet, 4) : "—"}</span>
                            )}
                          </td>
                          <td className="r">
                            {t.txSig ? (
                              <a className="num dimtx" href={solscanTx(t.txSig)} target="_blank" rel="noreferrer">
                                {shortAddr(t.txSig, 4)}
                              </a>
                            ) : (
                              <span className="dimtx" title="Paper fill — a ledger entry, never on chain">ledger</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="sectiontitle">Orders</div>
          <div className="panel">
            {(orders ?? []).length === 0 ? (
              <div className="empty">No orders yet — arm a TP/SL or limit buy on the right</div>
            ) : (
              <div className="tablewrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Kind</th>
                      <th>Token</th>
                      <th className="r">Trigger</th>
                      <th className="r">Size</th>
                      <th className="r">Status</th>
                      <th className="r"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {(orders ?? []).slice(0, 12).map((o) => (
                      <tr key={o.id}>
                        <td className="mono" style={{ fontSize: 12 }}>{o.kind.replace(/_/g, " ")}</td>
                        <td className="mono">{o.symbol}</td>
                        <td className="r num">{fmtUsd(o.triggerPriceUsd)}</td>
                        <td className="r num">
                          {o.amountSol !== undefined && o.amountSol !== null
                            ? `${fmtSol(o.amountSol)} ◎`
                            : o.sellFraction !== undefined && o.sellFraction !== null
                              ? `${Math.round(o.sellFraction * 100)}%`
                              : "—"}
                        </td>
                        <td className="r"><span className={`pill ${o.status}`}>{o.status}</span></td>
                        <td className="r">
                          {o.status === "open" && (
                            <button
                              className="btn ghost sm"
                              onClick={() => {
                                void api.cancelOrder(o.id).then((upd) => {
                                  setOrders((os) => (os ?? []).map((x) => (x.id === upd.id ? upd : x)));
                                });
                              }}
                            >
                              cancel
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* ── ticket rail: the right column on desktop; grid-template-areas
             lifts it directly under the chart on narrow screens ── */}
        <div className="sg-side" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="panel panel-pad">
            <div className="field" style={{ marginBottom: 8 }}>
              <label>Trading vault</label>
              <select value={vaultId ?? ""} onChange={(e) => setVaultId(e.target.value)}>
                {vaults.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} · {fmtSol(v.solBufferSol)} ◎ free
                  </option>
                ))}
              </select>
            </div>
            {vault && (
              <div className="kv">
                <span className="k">SOL buffer</span>
                <span className="v">{fmtSol(vault.solBufferSol)} ◎ of {fmtSol(vault.tvlSol, 0)} ◎</span>
              </div>
            )}
          </div>

          <div className="viewtoggle" style={{ alignSelf: "stretch", display: "grid", gridTemplateColumns: "1fr 1fr 1fr" }}>
            {(["trade", "orders", "dca"] as const).map((r) => (
              <button key={r} className={rail === r ? "on" : ""} onClick={() => setRail(r)}>
                {r === "trade" ? "Trade" : r === "orders" ? "Orders" : "DCA"}
              </button>
            ))}
          </div>

          <div className="panel panel-pad" style={{ display: rail === "trade" ? undefined : "none" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <span className="dimtx mono" style={{ fontSize: 9.5, letterSpacing: "0.16em" }}>PRESETS</span>
              <div className="viewtoggle">
                {presets.map((p, i) => (
                  <button key={p.label} className={active === i ? "on" : ""} onClick={() => applyPreset(i)} title={`${p.buySol}◎ · slip ${p.slippagePct}% · prio ${p.prioSol} · ${p.mev}`}>
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="tradetabs">
              <button className={`buy ${side === "buy" ? "on" : ""}`} onClick={() => { setSide("buy"); setAmount("1"); }}>
                Buy
              </button>
              <button className={`sell ${side === "sell" ? "on" : ""}`} onClick={() => { setSide("sell"); setAmount("50"); }}>
                Sell
              </button>
            </div>

            <div className="field">
              <label>{side === "buy" ? "Spend (SOL)" : "Sell (% of position)"}</label>
              <input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="presetrow" style={{ marginBottom: 12 }}>
              {(side === "buy" ? ["0.5", "1", "2", "5"] : ["25", "50", "75", "100"]).map((v) => (
                <button key={v} className={`chip ${amount === v ? "on" : ""}`} onClick={() => setAmount(v)}>
                  {v}{side === "buy" ? "◎" : "%"}
                </button>
              ))}
            </div>

            {side === "sell" && !heldPosition && (
              <div className="callout" style={{ marginBottom: 10 }}>
                No {info?.symbol ?? "token"} position in this vault yet.
              </div>
            )}

            <button
              className={`btn ${side}`}
              style={{ width: "100%" }}
              disabled={
                !paper ||
                busy ||
                !vaultId ||
                !info ||
                info.source === "none" ||
                amountNum <= 0 ||
                (side === "sell" && !heldPosition) ||
                (side === "buy" && vault !== null && amountNum > vault.solBufferSol)
              }
              title={paper ? undefined : "Real execution unlocks with the on-chain program"}
              onClick={() => void executeTrade()}
            >
              {busy ? "…" : side === "buy" ? `Buy ${info?.symbol ?? ""}` : `Sell ${info?.symbol ?? ""}`}
              {paper ? " (paper)" : ""}
            </button>
            {side === "buy" && vault && amountNum > vault.solBufferSol && (
              <div className="dimtx" style={{ fontSize: 11.5, marginTop: 6 }}>
                Exceeds the vault's free SOL ({fmtSol(vault.solBufferSol)} ◎).
              </div>
            )}
            <div className="gasline" aria-label="Execution settings">
              <span title="Priority fee">⛽ {prio}</span>
              <span title="Slippage">〜 {slippage}%</span>
              <span title={mevHint(mev)}>🛡 {mev}</span>
              {/* These are stored, not applied. The trade service takes only
                  {side, mint, solAmount, sellFraction} — nothing in the fill
                  path reads slippage, priority or MEV mode. Saying otherwise
                  dresses a mock up as a ticket. */}
              <span className="neg" title="Saved for when real execution lands. The paper fill path does not read them.">
                not applied
              </span>
              <span
                title="Change via presets"
                onClick={() => applyPreset(active)}
                style={{ cursor: "pointer", color: "var(--amber)" }}
              >
                edit
              </span>
            </div>
          </div>

          <div className="panel panel-pad" style={{ display: rail === "orders" ? undefined : "none" }}>
            <div className="sectiontitle" style={{ marginTop: 0 }}>Arm an order</div>
            <div className="field">
              <label>Type</label>
              <select value={orderKind} onChange={(e) => setOrderKind(e.target.value as OrderKind)}>
                {ORDER_KINDS.map((k) => (
                  <option key={k.id} value={k.id}>{k.label}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Trigger price (USD) — now {info ? fmtUsd(info.priceUsd) : "…"}</label>
              <input
                type="number"
                min="0"
                step="any"
                placeholder={info ? String(info.priceUsd) : "0"}
                value={trigger}
                onChange={(e) => setTrigger(e.target.value)}
              />
            </div>
            <div className="field">
              <label>{kindMeta.side === "buy" ? "Spend (SOL)" : "Sell (% of position)"}</label>
              <input type="number" min="0" value={orderAmt} onChange={(e) => setOrderAmt(e.target.value)} />
            </div>
            <button
              className="btn"
              style={{ width: "100%" }}
              disabled={
                !paper || busy || !vaultId || !info || (parseFloat(trigger) || 0) <= 0 ||
                (kindMeta.side === "sell" && !heldPosition)
              }
              onClick={() => void placeOrder()}
            >
              Arm {kindMeta.label.toLowerCase()} · {openOrders.length} open
            </button>
            <p className="dimtx" style={{ fontSize: 11.5, marginBottom: 0 }}>
              The engine checks triggers against live prices every 15s and fires through the same
              trade path.
            </p>
          </div>

          <div className="panel panel-pad" style={{ display: rail === "dca" ? undefined : "none" }}>
            <div className="sectiontitle" style={{ marginTop: 0 }}>DCA — spread the entry</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              <div className="field" style={{ marginBottom: 8 }}>
                <label>◎ / leg</label>
                <input type="number" min="0" step="0.1" value={dcaAmt} onChange={(e) => setDcaAmt(e.target.value)} />
              </div>
              <div className="field" style={{ marginBottom: 8 }}>
                <label>Every (min)</label>
                <input type="number" min="1" step="1" value={dcaEveryMin} onChange={(e) => setDcaEveryMin(e.target.value)} />
              </div>
              <div className="field" style={{ marginBottom: 8 }}>
                <label>Legs</label>
                <input type="number" min="1" max="96" step="1" value={dcaLegs} onChange={(e) => setDcaLegs(e.target.value)} />
              </div>
            </div>
            <button
              className="btn"
              style={{ width: "100%" }}
              disabled={
                !paper || busy || !vaultId || !info || info.source === "none" ||
                (parseFloat(dcaAmt) || 0) <= 0 || (parseInt(dcaLegs) || 0) < 1
              }
              onClick={() => {
                void (async () => {
                  if (!vaultId) return;
                  setBusy(true);
                  try {
                    const dca = await api.dcaCreate({
                      vaultId,
                      mint,
                      amountSolPerLeg: parseFloat(dcaAmt) || 0.5,
                      intervalSec: Math.max(60, (parseInt(dcaEveryMin) || 5) * 60),
                      legsTotal: Math.min(96, Math.max(1, parseInt(dcaLegs) || 6)),
                    });
                    setDcas((ds) => [dca, ...(ds ?? [])]);
                    toast("good", `DCA armed: ${dca.legsTotal}×${fmtSol(dca.amountSolPerLeg)} ◎ ${info?.symbol ?? ""} — leg 1 filled now`);
                  } catch (e) {
                    toast("bad", e instanceof Error ? e.message : "DCA failed");
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              Start DCA · leg 1 fires now
            </button>
            {(dcas ?? []).filter((d) => d.status === "active").length + (dcas ?? []).filter((d) => d.status !== "active").slice(0, 2).length > 0 && (
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                {(dcas ?? []).slice(0, 5).map((d) => {
                  const nextIn = Math.max(0, d.nextLegAt - Math.floor(Date.now() / 1000));
                  return (
                    <div key={d.id} className="kv" style={{ alignItems: "center" }}>
                      <span className="k" style={{ textTransform: "none" }}>
                        {d.symbol} {d.legsDone}/{d.legsTotal} · {fmtSol(d.amountSolPerLeg)}◎
                        {d.status === "active" ? ` · next ${Math.floor(nextIn / 60)}m${nextIn % 60}s` : ""}
                      </span>
                      <span className="v" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <span className={`pill ${d.status === "active" ? "open" : d.status === "done" ? "filled" : d.status}`}>
                          {d.status}
                        </span>
                        {d.status === "active" && (
                          <button
                            className="btn ghost sm"
                            onClick={() => {
                              void api.dcaCancel(d.id).then((upd) => {
                                setDcas((ds) => (ds ?? []).map((x) => (x.id === upd.id ? upd : x)));
                              });
                            }}
                          >
                            ×
                          </button>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="panel panel-pad">
            <div className="sectiontitle" style={{ marginTop: 0 }}>Trending on Solana</div>
            {!trending ? (
              <>
                <Skeleton h={30} style={{ marginBottom: 8 }} />
                <Skeleton h={30} style={{ marginBottom: 8 }} />
                <Skeleton h={30} />
              </>
            ) : (
              trending.slice(0, 8).map((t) => (
                <button key={t.mint} className="trendrow" onClick={() => setMint(t.mint)}>
                  {t.imageUrl ? <img src={t.imageUrl} alt="" /> : <span style={{ width: 22 }} />}
                  <span className="mono" style={{ fontWeight: 600 }}>{t.symbol}</span>
                  <span style={{ flex: 1 }} />
                  <span className="num mutedtx">{fmtUsd(t.priceUsd)}</span>
                  {t.change24hPct !== undefined && (
                    <span className={`num ${t.change24hPct >= 0 ? "pos" : "neg"}`} style={{ width: 58, textAlign: "right" }}>
                      {t.change24hPct >= 0 ? "+" : ""}
                      {t.change24hPct.toFixed(1)}%
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
          <TokenFacts
            mint={mint}
            info={info ?? null}
            stats={poolStats ?? null}
            supplyUi={supplyUi}
            athUsd={periodHighUsd}
          />
        </div>
      </div>
    </>
  );
}
