import { useEffect, useState } from "react";
import { NavLink, Outlet, Link, useNavigate, useLocation } from "react-router-dom";
import { fmtUsd } from "@trader-vaults/shared";
import { useAuth } from "./lib/auth";
import { api } from "./lib/api";
import { useFlash, usePoll } from "./lib/hooks";
import { useWatchlist } from "./lib/watchlist";
import { ActivityWire } from "./components/ActivityWire";
import { DepositModal } from "./components/DepositModal";
import { TokenSearchBox } from "./components/TokenSearchBox";

const HOTKEYS: Record<string, string> = {
  e: "/explore",
  p: "/portfolio",
  d: "/pulse",
  t: "/terminal",
  v: "/dashboard",
  n: "/create",
  w: "/tracking",
  l: "/leaderboards",
  m: "/settings/profile",
  b: "/paper",
};

function Nav({ to, hotkey, label, end }: { to: string; hotkey: string; label: string; end?: boolean }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => `navlink ${isActive ? "active" : ""}`}>
      <span className="key">{hotkey.toUpperCase()}</span>
      <span className="lbl">{label}</span>
    </NavLink>
  );
}

/** Primary destinations as a thumb-reachable bar; CSS hides it ≥861px. */
const TABS: { to: string; label: string; ico: string }[] = [
  { to: "/explore", label: "Explore", ico: "▦" },
  { to: "/portfolio", label: "Portfolio", ico: "◧" },
  { to: "/terminal", label: "Terminal", ico: "▶" },
  { to: "/pulse", label: "Pulse", ico: "◈" },
  { to: "/dashboard", label: "Vault", ico: "▣" },
];

function TabBar() {
  return (
    <nav className="tabbar" aria-label="Primary">
      {TABS.map((t) => (
        <NavLink key={t.to} to={t.to} className={({ isActive }) => (isActive ? "active" : "")}>
          <span className="tico" aria-hidden="true">{t.ico}</span>
          <span>{t.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

const HOTKEY_HELP: { key: string; label: string }[] = [
  { key: "E", label: "Explore vaults" },
  { key: "P", label: "Portfolio" },
  { key: "D", label: "Pulse — live token lifecycle" },
  { key: "T", label: "Terminal (real SOL)" },
  { key: "B", label: "Paper trading sandbox" },
  { key: "V", label: "My vault dashboard" },
  { key: "N", label: "Create a vault" },
  { key: "M", label: "Edit my profile" },
  { key: "W", label: "Wallet tracking" },
  { key: "L", label: "Leaderboards" },
  { key: "?", label: "This cheat sheet" },
];

function HotkeyHelp({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" style={{ zIndex: 95 }} onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts">
        <div className="mono" style={{ padding: "12px 18px", borderBottom: "1px solid var(--line-2)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
          <span style={{ color: "var(--amber)", fontWeight: 700, letterSpacing: "0.1em" }}>// KEYBOARD</span>
          <button className="drawerclose" style={{ display: "grid" }} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div style={{ padding: 16 }}>
          {HOTKEY_HELP.map((h) => (
            <div key={h.key} className="kv" style={{ alignItems: "center" }}>
              <span className="k" style={{ textTransform: "none" }}>{h.label}</span>
              <span className="v">
                <span className="key" style={{ display: "inline-grid", placeItems: "center", width: 20, height: 20, border: "1px solid var(--line-bright)", fontSize: 11 }}>
                  {h.key}
                </span>
              </span>
            </div>
          ))}
          <p className="dimtx" style={{ fontSize: 11.5, marginBottom: 0 }}>
            Keys work anywhere outside a text field. Esc closes panels.
          </p>
        </div>
      </div>
    </div>
  );
}

/** Photon-style watch pill: up to 3 starred tokens as a glanceable mini-ticker. */
function WatchPill() {
  const { items } = useWatchlist();
  const shown = items.slice(0, 3);
  const { data: infos } = usePoll(
    async () => {
      if (shown.length === 0) return [];
      return Promise.all(shown.map((i) => api.token(i.mint).catch(() => null)));
    },
    30_000,
    [shown.map((i) => i.mint).join(",")],
  );
  const nav = useNavigate();
  if (shown.length === 0) return null;
  return (
    <div className="watchpill" style={{ display: "flex", gap: 6 }}>
      {shown.map((w, i) => {
        const info = infos?.[i] ?? null;
        const ch = info?.change24hPct;
        return (
          <button
            key={w.mint}
            className="poschip"
            onClick={() => nav(`/token/${w.mint}`)}
            title={`${w.symbol} — watched`}
          >
            <span style={{ color: "var(--amber)" }}>★</span>
            <span style={{ fontWeight: 700 }}>{w.symbol}</span>
            {ch !== undefined && (
              <span className={`num ${ch >= 0 ? "pos" : "neg"}`}>
                {ch >= 0 ? "+" : ""}
                {ch.toFixed(1)}%
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function SolPrice() {
  const { data: meta } = usePoll(() => api.meta(), 10_000, []);
  const flash = useFlash(meta?.solPriceUsd);
  if (!meta || meta.solPriceUsd <= 0) return null;
  return (
    <div className="statusdot sol" title="SOL price (live)">
      <span
        className={`num ${flash === "up" ? "flash-up pos" : flash === "down" ? "flash-down neg" : ""}`}
        style={{ color: flash ? undefined : "var(--amber)" }}
      >
        SOL {fmtUsd(meta.solPriceUsd)}
      </span>
    </div>
  );
}

export default function App() {
  const { user, demo, login, logout } = useAuth();
  const [apiUp, setApiUp] = useState<boolean | null>(null);
  // The chip used to read "devnet" unconditionally. It is a label on real
  // money now, so it comes from the API rather than from a literal.
  const [cluster, setCluster] = useState("mainnet-beta");
  const [depositOpen, setDepositOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const nav = useNavigate();
  const loc = useLocation();

  useEffect(() => {
    let alive = true;
    api
      .onchainConfig()
      .then((c) => alive && setCluster(c.cluster))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // a tap that navigates should also put the drawer away
  useEffect(() => setNavOpen(false), [loc.pathname]);
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setNavOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "?") {
        e.preventDefault();
        setHelpOpen((h) => !h);
        return;
      }
      const to = HOTKEYS[e.key.toLowerCase()];
      if (to) {
        e.preventDefault();
        nav(to);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nav]);

  useEffect(() => {
    let alive = true;
    const check = () =>
      api
        .health()
        .then(() => alive && setApiUp(true))
        .catch(() => alive && setApiUp(false));
    check();
    const iv = setInterval(check, 15000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);

  return (
    <div className="shell">
      {navOpen && <div className="navdrawer-backdrop" onClick={() => setNavOpen(false)} aria-hidden="true" />}
      <aside className={`sidebar ${navOpen ? "open" : ""}`}>
        <Link to="/" className="brand">
          <span className="mark">V</span>
          <span className="word">trader vaults</span>
          <span style={{ flex: 1 }} />
          <button className="drawerclose" onClick={(e) => { e.preventDefault(); setNavOpen(false); }} aria-label="Close menu">
            ✕
          </button>
        </Link>

        <div className="navsec">Invest</div>
        <Nav to="/explore" hotkey="e" label="Explore vaults" />
        <Nav to="/portfolio" hotkey="p" label="Portfolio" />

        <div className="navsec">Trade</div>
        <Nav to="/terminal" hotkey="t" label="Terminal" />
        <Nav to="/dashboard" hotkey="v" label="My vault" />

        <div className="navsec">Discover</div>
        <Nav to="/pulse" hotkey="d" label="Pulse" />
        <Nav to="/tracking" hotkey="w" label="Wallets" />
        <Nav to="/leaderboards" hotkey="l" label="Leaders" />

        <div className="navsec">Sandbox</div>
        <Nav to="/paper" hotkey="b" label="Paper trading" />

        <div className="spacer" />
        <div className="acctbox">
          <div className="avatar">{user ? user.handle.slice(0, 1).toUpperCase() : "·"}</div>
          <div className="who">
            <div className="h">{user ? `@${user.handle}` : "signed out"}</div>
            <div className="s">{demo ? "demo mode" : "privy"}</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, margin: "8px 10px 0" }}>
          <button className="btn primary sm" style={{ flex: 1 }} onClick={() => setDepositOpen(true)}>
            Deposit
          </button>
          <button className="btn ghost sm" onClick={user ? logout : login}>
            {user ? "Out" : "In"}
          </button>
        </div>
      </aside>
      {depositOpen && <DepositModal onClose={() => setDepositOpen(false)} />}
      {helpOpen && <HotkeyHelp onClose={() => setHelpOpen(false)} />}

      <div className="main">
        <div className="topbar">
          <button
            className="navtoggle"
            aria-label="Open navigation"
            aria-expanded={navOpen}
            onClick={() => setNavOpen((o) => !o)}
          >
            ☰
          </button>
          <TokenSearchBox onPick={(r) => nav(`/token/${r.mint}`)} />
          <WatchPill />
          <div className="spacer" />
          <SolPrice />
          <div className="statusdot api" title="API connection">
            <span className={`dot ${apiUp === false ? "down" : ""}`} />
            <span className="lbl">{apiUp === null ? "connecting" : apiUp ? "api live" : "api down"}</span>
          </div>
          <div className="statusdot net" title="Network">
            <span className="dot" />
            {cluster}
          </div>
          <button
            className="btn ghost sm helpbtn"
            style={{ padding: "3px 9px" }}
            title="Keyboard shortcuts"
            onClick={() => setHelpOpen(true)}
          >
            ?
          </button>
        </div>
        <div className="content">
          <div className="content-inner">
            <Outlet />
          </div>
        </div>
        <ActivityWire />
      </div>
      <TabBar />
    </div>
  );
}
