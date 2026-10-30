import { useEffect, useRef, useState } from "react";

/** Poll an async fn on an interval; pauses when the tab is hidden. */
export function usePoll<T>(fn: () => Promise<T>, ms: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let alive = true;
    const run = (force = false) => {
      // pause background ticks, but never skip the initial fetch —
      // a hidden pane must still hydrate so it's ready when shown
      if (document.hidden && !force) return;
      fnRef
        .current()
        .then((d) => {
          if (alive) {
            setData(d);
            setError(null);
          }
        })
        .catch((e) => alive && setError(e instanceof Error ? e.message : "failed"));
    };
    run(true);
    const iv = setInterval(() => run(), ms);
    const onVis = () => {
      if (!document.hidden) run();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, setData };
}

/** Animate a number from its previous value to the new one. */
export function useCountUp(target: number, durationMs = 700): number {
  const [value, setValue] = useState(target);
  const fromRef = useRef(target);
  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    if (reduced || fromRef.current === target) {
      fromRef.current = target;
      setValue(target);
      return;
    }
    const from = fromRef.current;
    fromRef.current = target;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(from + (target - from) * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // rAF never fires in hidden tabs — snap to the target so backgrounded
    // pages don't show stale zeros when revealed
    const settle = setTimeout(() => setValue(target), durationMs + 80);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(settle);
    };
  }, [target, durationMs, reduced]);

  return value;
}

/** Returns "up" | "down" | null for one animation frame window when v changes. */
export function useFlash(v: number | undefined): "up" | "down" | null {
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  const prev = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (v === undefined) return;
    if (prev.current !== undefined && v !== prev.current) {
      setFlash(v > prev.current ? "up" : "down");
      const t = setTimeout(() => setFlash(null), 700);
      prev.current = v;
      return () => clearTimeout(t);
    }
    prev.current = v;
  }, [v]);
  return flash;
}

export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} · Trader Vaults` : "Trader Vaults";
  }, [title]);
}
