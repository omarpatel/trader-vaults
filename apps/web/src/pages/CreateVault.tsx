import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  PERF_FEE_DEFAULT_BPS,
  PERF_FEE_MAX_BPS,
  PERF_FEE_MIN_BPS,
  splitPerfFeeBps,
  VEST_LOCK_DAYS,
} from "@trader-vaults/shared";
import { api } from "../lib/api";
import { usePageTitle } from "../lib/hooks";
import { useAuth } from "../lib/useAuth";

export function CreateVault() {
  usePageTitle("Create vault");
  const { wallet } = useAuth();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [type, setType] = useState<"managed" | "mirror">(params.get("leader") ? "mirror" : "managed");
  const [mode, setMode] = useState<"real" | "paper">("real");
  const [name, setName] = useState("");
  const [perfFee, setPerfFee] = useState(PERF_FEE_DEFAULT_BPS / 100);
  const [thesis, setThesis] = useState("");
  const [leader, setLeader] = useState(params.get("leader") ?? "");
  const [sizingMode, setSizingMode] = useState<"fixed" | "proportional">("fixed");
  const [fixedSol, setFixedSol] = useState("0.25");
  const [maxSol, setMaxSol] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const feeSplit = splitPerfFeeBps(Math.round(perfFee * 100));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Sign the request so the vault belongs to whoever created it.
      const tokens = wallet
        ? { accessToken: await wallet.getAccessToken(), identityToken: wallet.identityToken }
        : undefined;
      const v = await api.createVault({
        name: name.trim(),
        type,
        mode,
        perfFeeBps: Math.round(perfFee * 100),
        thesis: thesis.trim() || undefined,
        leaderWallet: type === "mirror" ? leader.trim() : undefined,
        ...(type === "mirror"
          ? {
              mirrorSizingMode: sizingMode,
              mirrorFixedSol: parseFloat(fixedSol) || 0.25,
              mirrorMaxSol: parseFloat(maxSol) || 1,
            }
          : {}),
      }, tokens);
      nav(`/vault/${v.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Create a vault</h1>
          <div className="sub">Zero SOL required — investors fund it, you trade it, the program keeps custody.</div>
        </div>
      </div>

      <div className="grid2">
        <form onSubmit={(e) => void submit(e)} className="panel panel-pad">
          <div className="field">
            <label>Money</label>
            <div className="chipsrow">
              <button type="button" className={`chip ${mode === "real" ? "on" : ""}`} onClick={() => setMode("real")}>
                on-chain SOL
              </button>
              <button type="button" className={`chip ${mode === "paper" ? "on" : ""}`} onClick={() => setMode("paper")}>
                paper — sandbox
              </button>
            </div>
            <div className="hint">
              {mode === "real"
                ? "A real program-owned vault on Solana DEVNET. Devnet SOL, not mainnet SOL — the program is not deployed to mainnet yet, so this cannot hold real value. Never simulated, but not real money either."
                : "Trades instantly at live prices — ledger entries, clearly labeled, kept out of real records."}
            </div>
          </div>

          <div className="field">
            <label>Vault type</label>
            <div className="chipsrow">
              <button type="button" className={`chip ${type === "managed" ? "on" : ""}`} onClick={() => setType("managed")}>
                managed — I trade in the terminal
              </button>
              <button type="button" className={`chip ${type === "mirror" ? "on" : ""}`} onClick={() => setType("mirror")}>
                mirror — copy a wallet
              </button>
            </div>
          </div>

          <div className="field">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Runner Season" maxLength={40} required />
          </div>

          {type === "mirror" && (
            <>
              <div className="field">
                <label>Leader wallet</label>
                <input value={leader} onChange={(e) => setLeader(e.target.value)} placeholder="wallet to copy-trade" spellCheck={false} required />
                <div className="hint">The engine mirrors this wallet's trades from attach time forward — history is never replayed. Copy lag is published on the vault page.</div>
              </div>
              <div className="field">
                <label>Copy sizing</label>
                <div className="chipsrow">
                  <button type="button" className={`chip ${sizingMode === "fixed" ? "on" : ""}`} onClick={() => setSizingMode("fixed")}>
                    fixed SOL per copy
                  </button>
                  <button type="button" className={`chip ${sizingMode === "proportional" ? "on" : ""}`} onClick={() => setSizingMode("proportional")}>
                    proportional to leader
                  </button>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div className="field">
                  <label>{sizingMode === "fixed" ? "SOL per copied buy" : "Base size (◎)"}</label>
                  <input type="number" min="0.01" max="100" step="0.05" value={fixedSol} onChange={(e) => setFixedSol(e.target.value)} />
                </div>
                <div className="field">
                  <label>Max per copy (◎)</label>
                  <input type="number" min="0.01" step="0.1" value={maxSol} onChange={(e) => setMaxSol(e.target.value)} />
                </div>
              </div>
            </>
          )}

          <div className="field">
            <label>Performance fee — {perfFee.toFixed(0)}% of profit</label>
            <input
              type="range"
              min={PERF_FEE_MIN_BPS / 100}
              max={PERF_FEE_MAX_BPS / 100}
              step={1}
              value={perfFee}
              onChange={(e) => setPerfFee(Number(e.target.value))}
            />
            <div className="hint">
              You take {(feeSplit.immediateBps / 100).toFixed(1)}% on exit and{" "}
              {(feeSplit.vestedBps / 100).toFixed(1)}% goes to escrow for {VEST_LOCK_DAYS} days —
              one third of every fee vests. Charged per-depositor above their high-water mark, only
              when profit is realized. Changeable later — downward only.
            </div>
          </div>

          <div className="field">
            <label>Thesis</label>
            <textarea rows={3} value={thesis} onChange={(e) => setThesis(e.target.value)} placeholder="What's the strategy? Depositors read this." />
          </div>

          {error && <div className="callout red" style={{ marginBottom: 12 }}>{error}</div>}
          <button className="btn primary" disabled={busy || !name.trim()}>
            {busy ? "…" : "Create vault"}
          </button>
        </form>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="panel panel-pad">
            <div className="sectiontitle" style={{ marginTop: 0 }}>What you get</div>
            <ul style={{ margin: 0, paddingLeft: 18, color: "var(--muted)", fontSize: 13.5 }}>
              <li>A program-owned vault — depositors' SOL, your trading.</li>
              <li>
                70 / 30 split: depositors keep 70% of profit, you earn {perfFee.toFixed(0)}%. The
                platform takes no cut.
              </li>
              <li>
                Of your fee, {(feeSplit.immediateBps / 100).toFixed(1)}% is paid on exit and{" "}
                {(feeSplit.vestedBps / 100).toFixed(1)}% is held in escrow for {VEST_LOCK_DAYS}{" "}
                days before you can claim it — vesting is what makes depositors trust a new trader.
              </li>
              <li>Public track record page computed from chain data.</li>
              <li>Optional: link X, import paper-trading stats.</li>
            </ul>
          </div>
          <div className="callout">
            What you can't do: withdraw depositor funds, raise fees, or block withdrawals. That's the
            product — say it loudly on your vault page.
          </div>
          {mode === "real" && (
            <div className="callout red">
              Real vaults today: the split above is what the program enforces — depositors
              keep {(100 - perfFee).toFixed(0)}% of profit, you take {perfFee.toFixed(0)}%,
              the platform takes nothing. What is NOT live is the escrow: the deployed
              bytecode pays your whole fee on exit rather than vesting a third of it, so the
              vesting terms apply to paper vaults only until that ships.
            </div>
          )}
        </div>
      </div>
    </>
  );
}
