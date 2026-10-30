import { useState } from "react";
import { fmtSol, splitPerfFeeBps, VEST_LOCK_DAYS, type Vault } from "@trader-vaults/shared";
import { api } from "../lib/api";
import { RealDepositPanel } from "./RealDepositPanel";
import { RealWithdrawPanel } from "./RealWithdrawPanel";

/**
 * Deposit / withdraw panel.
 *
 * Two completely separate worlds, and the split is deliberate:
 *   · mode "real"  → RealDepositPanel / RealWithdrawPanel, both signed by
 *                    the user's own Privy wallet. Nothing below this line
 *                    runs for it — the demo ledger never sees real money
 *                    (the API 409s those routes for real vaults anyway).
 *                    The withdraw half is not optional: for a while this
 *                    branch rendered the deposit panel alone, which meant
 *                    real SOL could go in and nothing in the product could
 *                    take it out.
 *   · mode "paper" → the ledger sandbox that follows.
 */
export function DepositPanel({ vault, onChanged }: { vault: Vault; onChanged: () => void }) {
  const [tab, setTab] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "green" | "red" | ""; text: string } | null>(null);

  const { immediateBps, vestedBps } = splitPerfFeeBps(vault.perfFeeBps);
  const num = parseFloat(amount) || 0;
  const sharesOut = vault.sharePriceSol > 0 ? num / vault.sharePriceSol : 0;
  const instantOk = tab === "withdraw" && num <= vault.solBufferSol;

  async function submit() {
    if (num <= 0) return;
    setBusy(true);
    setMsg(null);
    try {
      if (tab === "deposit") {
        const r = await api.deposit(vault.id, num);
        setMsg({ tone: "green", text: `Deposited ${fmtSol(num)} SOL → ${fmtSol(r.shares)} shares` });
      } else {
        const shares = vault.sharePriceSol > 0 ? num / vault.sharePriceSol : 0;
        const r = await api.withdraw(vault.id, shares);
        setMsg(
          r.instant
            ? {
                tone: "green",
                text: r.fees
                  ? r.fees.profitSol > 0
                    ? `Paid ${fmtSol(r.fees.paidSol)} ◎ — profit ${fmtSol(r.fees.profitSol)}, performance fee ${fmtSol(r.fees.perfFeeSol)} (trader gets ${fmtSol(r.fees.traderFeeSol)} now, ${fmtSol(r.fees.traderVestedSol)} vests in ${VEST_LOCK_DAYS} days)`
                    : `Paid ${fmtSol(r.fees.paidSol)} ◎ — no profit above your cost basis, so zero fees`
                  : `Instant withdrawal paid from SOL buffer`,
              }
            : {
                tone: "",
                text: `Withdrawal requested — executes after the ${vault.redeemWindowHours}h window at worse-of pricing; the 70/30 split applies to profit at execution`,
              },
        );
      }
      setAmount("");
      onChanged();
    } catch (e) {
      setMsg({ tone: "red", text: e instanceof Error ? e.message : "Failed" });
    } finally {
      setBusy(false);
    }
  }

  if (vault.mode === "real") {
    return (
      <div className="panel panel-pad">
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button
            className={`buy ${tab === "deposit" ? "on" : ""}`}
            onClick={() => setTab("deposit")}
          >
            Deposit
          </button>
          <button
            className={`sell ${tab === "withdraw" ? "on" : ""}`}
            onClick={() => setTab("withdraw")}
          >
            Withdraw
          </button>
        </div>
        {tab === "deposit" ? (
          <RealDepositPanel vault={vault} onChanged={onChanged} />
        ) : (
          <RealWithdrawPanel vault={vault} onChanged={onChanged} />
        )}
      </div>
    );
  }

  return (
    <div className="panel panel-pad">
      <div className="sectiontitle" style={{ marginTop: 0 }}>
        Deposit <span className="pill paper" style={{ marginLeft: 6 }}>paper</span>
      </div>
      <div className="tradetabs">
        <button className={`buy ${tab === "deposit" ? "on" : ""}`} onClick={() => setTab("deposit")}>
          Deposit
        </button>
        <button className={`sell ${tab === "withdraw" ? "on" : ""}`} onClick={() => setTab("withdraw")}>
          Withdraw
        </button>
      </div>

      <div className="field">
        <label>{tab === "deposit" ? "Amount (SOL)" : "Amount (SOL value)"}</label>
        <input
          type="number"
          min="0"
          step="0.1"
          placeholder="0.0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </div>
      <div className="presetrow" style={{ marginBottom: 12 }}>
        {[0.5, 1, 5, 10].map((v) => (
          <button key={v} className="chip" onClick={() => setAmount(String(v))}>
            {v}◎
          </button>
        ))}
      </div>

      <div style={{ marginBottom: 12 }}>
        <div className="kv">
          <span className="k">Share price</span>
          <span className="v">{vault.sharePriceSol.toFixed(4)} ◎</span>
        </div>
        {tab === "deposit" ? (
          <div className="kv">
            <span className="k">You receive</span>
            <span className="v">{fmtSol(sharesOut)} shares</span>
          </div>
        ) : (
          <>
            <div className="kv">
              <span className="k">SOL buffer</span>
              <span className="v">{fmtSol(vault.solBufferSol)} ◎</span>
            </div>
            <div className="kv">
              <span className="k">Route</span>
              <span className="v">{instantOk ? "instant" : `request · ${vault.redeemWindowHours}h window`}</span>
            </div>
          </>
        )}
        <div className="kv">
          <span className="k">Performance fee</span>
          <span className="v" title={`${(immediateBps / 100).toFixed(0)}% paid to the trader at once, ${(vestedBps / 100).toFixed(0)}% held in escrow for ${VEST_LOCK_DAYS} days`}>
            {(vault.perfFeeBps / 100).toFixed(0)}% of profit
          </span>
        </div>
      </div>

      <button className={`btn ${tab === "deposit" ? "buy" : "sell"}`} style={{ width: "100%" }} disabled={busy || num <= 0} onClick={() => void submit()}>
        {busy ? "…" : tab === "deposit" ? "Deposit" : instantOk ? "Withdraw instantly" : "Request withdrawal"}
      </button>

      {msg && <div className={`callout ${msg.tone}`} style={{ marginTop: 12 }}>{msg.text}</div>}

      <p className="dimtx" style={{ fontSize: 12, marginBottom: 0 }}>
        Small exits pay instantly from the vault's cash. Big exits wait up to{" "}
        {vault.redeemWindowHours}h and pay whichever value is lower — when you asked or when it
        pays — so nobody games the queue at other depositors' expense. The trader can trade this
        money but can never take it. You pay {(vault.perfFeeBps / 100).toFixed(0)}% of profit and
        nothing else — a third of that fee is locked in escrow for {VEST_LOCK_DAYS} days, so a
        trader who blows up can't walk off with all of it the same day.
      </p>
    </div>
  );
}
