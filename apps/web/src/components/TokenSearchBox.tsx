/** Reusable token search: topbar navigates, terminal swaps the chart. */
import { useEffect, useRef, useState } from "react";
import type { TokenSearchResult } from "@trader-vaults/shared";
import { fmtUsd } from "@trader-vaults/shared";
import { api } from "../lib/api";

export function TokenSearchBox({
  onPick,
  placeholder = "search pump.fun tokens or paste a mint…",
  autoFocus = false,
}: {
  onPick: (r: TokenSearchResult) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<TokenSearchResult[] | null>(null);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) {
      setResults(null);
      setOpen(false);
      return;
    }
    const id = ++seq.current;
    const timer = setTimeout(() => {
      api
        .searchTokens(t)
        .then((r) => {
          if (seq.current === id) {
            setResults(r);
            setOpen(true);
            setHi(0);
          }
        })
        .catch(() => seq.current === id && setResults([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function pick(r: TokenSearchResult) {
    setOpen(false);
    setQ("");
    onPick(r);
  }

  function onKey(e: React.KeyboardEvent) {
    if (!open || !results || results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi((h) => Math.min(results.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((h) => Math.max(0, h - 1));
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="searchwrap" ref={boxRef}>
      <form
        className="search"
        onSubmit={(e) => {
          e.preventDefault();
          const v = q.trim();
          if (results && results[hi]) pick(results[hi]!);
          else if (v.length >= 32 && v.length <= 44)
            pick({ mint: v, symbol: v.slice(0, 4), name: v, priceUsd: 0 });
        }}
      >
        <span>⌕</span>
        <input
          placeholder={placeholder}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => results && setOpen(true)}
          onKeyDown={onKey}
          spellCheck={false}
          autoFocus={autoFocus}
        />
        <span className="key-hint">↵</span>
      </form>
      {open && results && (
        <div className="searchdrop">
          {results.length === 0 && (
            <div className="row" style={{ cursor: "default", color: "var(--dim)" }}>
              no pump.fun tokens found
            </div>
          )}
          {results.slice(0, 8).map((r, i) => (
            <button
              key={r.mint}
              type="button"
              className="row"
              style={i === hi ? { background: "var(--amber-dim)" } : undefined}
              onMouseEnter={() => setHi(i)}
              onClick={() => pick(r)}
            >
              {r.imageUrl ? <img src={r.imageUrl} alt="" /> : <span style={{ width: 18 }} />}
              <span className="mono" style={{ fontWeight: 600 }}>{r.symbol}</span>
              <span className="dimtx" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.name}
              </span>
              <span className="num mutedtx">{r.priceUsd > 0 ? fmtUsd(r.priceUsd) : ""}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
