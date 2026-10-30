/**
 * Withdrawing from a REAL vault.
 *
 * This did not exist. Real vaults rendered RealDepositPanel and nothing else,
 * so a depositor could put mainnet SOL into a vault and had no way in the
 * product to take it out.
 *
 * The design rule here is that a depositor should never learn about a gate by
 * having a signed transaction revert. `/onchain/withdraw/quote` returns every
 * blocker on every path, computed from live chain state, and this panel shows
 * them as plain sentences next to the disabled button rather than surfacing an
 * Anchor error code after the fact.
 *
 * Four ways out, in the order a normal user should reach for them:
 *   instant    — free SOL covers it and the mark is fresh; one transaction
 *   request    — start the redeem window; execute when it matures
 *   cancel     — take back a request; never NAV-gated, so never a trap
 *   emergency  — permissionless hatch when nothing else works, at a haircut
 */
import { useCallback, useEffect, useState } from "react";
import {
  api,
  ApiError,
  type ConfirmedWithdraw,
  type WithdrawAction,
  type WithdrawQuote,
} from "../lib/api";
import { useAuth } from "../lib/auth";
import { explorerTxUrl, formatShares, lamportsToSol, solanaConnection } from "../lib/onchain";
import type { Vault } from "@trader-vaults/shared";

type Step = "idle" | "preparing" | "signing" | "confirming" | "done";

function fmtDuration(seconds: number): string {
  if (seconds <= 0) return "now";
  if (seconds < 90) return `${seconds}s`;
  const m = Math.ceil(seconds / 60);
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function RealWithdrawPanel({
  vault,
  onChanged,
}: {
  vault: Vault;
  onChanged: () => void;
}) {
  const { wallet, login, ready } = useAuth();

  const [quote, setQuote] = useState<WithdrawQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [cluster, setCluster] = useState("mainnet-beta");
  const [pct, setPct] = useState(100);
  const [step, setStep] = useState<Step>("idle");
  const [busyAction, setBusyAction] = useState<WithdrawAction | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [result, setResult] = useState<ConfirmedWithdraw | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tokens = useCallback(async () => {
    if (!wallet) throw new Error("no wallet bridge");
    const accessToken = await wallet.getAccessToken();
    return { accessToken, identityToken: wallet.identityToken };
  }, [wallet]);

  const loadQuote = useCallback(async () => {
    if (!wallet?.address) return;
    try {
      const q = await api.withdrawQuote(await tokens(), vault.id);
      setQuote(q);
      setQuoteError(null);
    } catch (e) {
      setQuote(null);
      // A depositor with no position gets a clean empty state, not an error.
      const code = e instanceof ApiError ? (e.body?.code as string | undefined) : undefined;
      if (code === "no_depositor_account") setQuoteError(null);
      else setQuoteError(e instanceof Error ? e.message : String(e));
    }
  }, [wallet?.address, tokens, vault.id]);

  useEffect(() => {
    void loadQuote();
  }, [loadQuote]);

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

  // The pending request matures on a clock, so the panel has to tick or the
  // "ends in 4 min" line silently becomes a lie.
  useEffect(() => {
    if (!quote?.pendingRequest) return;
    const t = setInterval(() => void loadQuote(), 20_000);
    return () => clearInterval(t);
  }, [quote?.pendingRequest, loadQuote]);

  const held = quote ? BigInt(quote.shares) : 0n;
  const sharesForPct =
    pct >= 100 ? held : (held * BigInt(Math.max(1, Math.round(pct)))) / 100n;
  const valueLamports = quote ? BigInt(quote.currentValueLamports) : 0n;
  const valueForPct =
    held > 0n ? (valueLamports * sharesForPct) / held : 0n;

  async function run(action: WithdrawAction) {
    if (!wallet) return;
    setError(null);
    setResult(null);
    setSignature(null);
    setBusyAction(action);
    try {
      setStep("preparing");
      const auth = await tokens();
      const needsShares = action === "request" || action === "instant" || action === "emergency";
      const prepared = await api.prepareOnchainWithdraw(
        auth,
        vault.id,
        action,
        needsShares ? (pct >= 100 ? "max" : sharesForPct.toString()) : undefined,
      );

      setStep("signing");
      const bytes = Uint8Array.from(atob(prepared.transaction), (c) => c.charCodeAt(0));
      const { VersionedTransaction } = await import("@solana/web3.js");
      const tx = VersionedTransaction.deserialize(bytes);
      const config = await api.onchainConfig();
      const connection = solanaConnection(config.rpcUrl);
      const sig = await wallet.sendTransaction(tx, connection);
      setSignature(sig);

      setStep("confirming");
      const confirmed = await api.confirmOnchainWithdraw(auth, vault.id, sig);
      setResult(confirmed);
      setStep("done");
      void loadQuote();
      onChanged();
    } catch (e) {
      // The API's refusals carry a human sentence in `error`; surface that
      // rather than the HTTP status.
      const msg =
        e instanceof ApiError
          ? String(e.body?.error ?? e.message)
          : e instanceof Error
            ? e.message
            : String(e);
      setError(msg);
      setStep("idle");
    } finally {
      setBusyAction(null);
    }
  }

  const busy = step === "preparing" || step === "signing" || step === "confirming";

  if (!ready) return <div className="empty">…</div>;

  if (!wallet) {
    return (
      <div className="dimtx" style={{ fontSize: 12, textAlign: "center", padding: 14 }}>
        Sign in to withdraw from this vault.
        <div style={{ marginTop: 10 }}>
          <button className="btn primary" onClick={login}>
            Sign in
          </button>
        </div>
      </div>
    );
  }

  if (quoteError) {
    return (
      <div className="dimtx" style={{ fontSize: 12, padding: 12, color: "var(--red)" }}>
        {quoteError}
      </div>
    );
  }

  if (!quote || held === 0n) {
    return (
      <div className="dimtx" style={{ fontSize: 12, textAlign: "center", padding: 14 }}>
        You hold no shares in this vault.
      </div>
    );
  }

  const a = quote.actions;
  const pending = quote.pendingRequest;

  const Blockers = ({ list }: { list: string[] }) =>
    list.length === 0 ? null : (
      <ul
        className="dimtx"
        style={{ fontSize: 11, margin: "4px 0 0", paddingLeft: 16, lineHeight: 1.5 }}
      >
        {list.map((b) => (
          <li key={b}>{b}</li>
        ))}
      </ul>
    );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="kv">
        <span className="k">Your position</span>
        <span className="v mono">
          {formatShares(quote.shares)} shares · {lamportsToSol(quote.currentValueLamports).toFixed(6)} ◎
        </span>
      </div>
      <div className="kv">
        <span className="k">Fees on exit</span>
        <span className="v dimtx">
          trader {(quote.perfFeeBps / 100).toFixed(0)}% of profit · platform 0%
        </span>
      </div>

      {pending ? (
        <div className="panel panel-pad" style={{ padding: 12 }}>
          <div className="sectiontitle" style={{ marginTop: 0 }}>
            Pending request
          </div>
          <div className="kv">
            <span className="k">Shares</span>
            <span className="v mono">{formatShares(pending.shares)}</span>
          </div>
          <div className="kv">
            <span className="k">Executable</span>
            <span className="v mono">{fmtDuration(pending.executableIn)}</span>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button
              className="btn primary"
              style={{ flex: 1 }}
              disabled={!a.execute.available || busy}
              onClick={() => void run("execute")}
            >
              {busyAction === "execute" ? "…" : "Withdraw now"}
            </button>
            <button
              className="btn"
              disabled={!a.cancel.available || busy}
              onClick={() => void run("cancel")}
            >
              {busyAction === "cancel" ? "…" : "Cancel"}
            </button>
          </div>
          <Blockers list={a.execute.blockers} />
          <p className="dimtx" style={{ fontSize: 11, margin: "8px 0 0" }}>
            Cancelling releases the reservation and returns your shares to you. It is
            never blocked by the vault's mark, so a request can never trap you.
          </p>
        </div>
      ) : (
        <>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="dimtx" style={{ fontSize: 11 }}>
              Amount — {pct}% ({lamportsToSol(valueForPct.toString()).toFixed(6)} ◎)
            </span>
            <input
              type="range"
              min={1}
              max={100}
              value={pct}
              onChange={(e) => setPct(Number(e.target.value))}
              disabled={busy}
            />
            <div style={{ display: "flex", gap: 6 }}>
              {[25, 50, 75, 100].map((p) => (
                <button
                  key={p}
                  className={`btn${pct === p ? " primary" : ""}`}
                  style={{ flex: 1, fontSize: 11, padding: "4px 0" }}
                  onClick={() => setPct(p)}
                  disabled={busy}
                >
                  {p === 100 ? "Max" : `${p}%`}
                </button>
              ))}
            </div>
          </label>

          <div>
            <button
              className="btn primary"
              style={{ width: "100%" }}
              disabled={!a.instant.available || busy}
              onClick={() => void run("instant")}
            >
              {busyAction === "instant" ? "…" : "Withdraw instantly"}
            </button>
            <Blockers list={a.instant.blockers} />
          </div>

          <div>
            <button
              className="btn"
              style={{ width: "100%" }}
              disabled={!a.request.available || busy}
              onClick={() => void run("request")}
            >
              {busyAction === "request" ? "…" : "Request withdrawal"}
            </button>
            <div className="dimtx" style={{ fontSize: 11, marginTop: 4 }}>
              Settles after the vault's {fmtDuration(quote.vault.redeemWindowSeconds)} redeem
              window. Priced when you execute, capped at today's value if the vault gains
              in between.
            </div>
            <Blockers list={a.request.blockers} />
          </div>
        </>
      )}

      {/* The escape hatch is deliberately always visible, even when shut: a
          depositor should be able to see that it exists and what opens it,
          not discover it in a support thread. */}
      <details style={{ borderTop: "1px solid var(--line-2)", paddingTop: 10 }}>
        <summary className="dimtx" style={{ fontSize: 11, cursor: "pointer" }}>
          Emergency exit {a.emergency.available ? "· available now" : "· not open"}
        </summary>
        <p className="dimtx" style={{ fontSize: 11, margin: "8px 0" }}>
          Needs no keeper, no admin and no trader. It opens once the vault's mark has
          been unrefreshed for 7 days, or once your own matured request has been
          unsettleable for its window plus 14 days. It pays{" "}
          {(100 - (a.emergency.haircutBps ?? 500) / 100).toFixed(0)}% of the stale mark —
          the haircut is what stops it being farmed against a stale-high price, and it
          stays in the vault backing everyone who remains.
        </p>
        <button
          className="btn"
          style={{ width: "100%" }}
          disabled={!a.emergency.available || busy}
          onClick={() => void run("emergency")}
        >
          {busyAction === "emergency" ? "…" : "Emergency withdraw"}
        </button>
        <Blockers list={a.emergency.blockers} />
      </details>

      {error && (
        <div
          className="dimtx"
          style={{ fontSize: 11.5, color: "var(--red)", wordBreak: "break-word" }}
        >
          {error}
        </div>
      )}

      {signature && (
        <div className="dimtx" style={{ fontSize: 11.5, textAlign: "center" }}>
          {step === "done" ? "Done. " : "Broadcast. "}
          <a href={explorerTxUrl(signature, cluster)} target="_blank" rel="noreferrer">
            View on Solscan
          </a>
          {result && (
            <div style={{ marginTop: 4 }}>
              {formatShares(result.position.shares)} shares remaining
            </div>
          )}
        </div>
      )}
    </div>
  );
}
