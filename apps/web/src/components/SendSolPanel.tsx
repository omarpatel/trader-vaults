/**
 * Send SOL out of the account wallet.
 *
 * The deposit modal has always shown an address and a QR, and there was no
 * way back out: SOL that landed in a Privy embedded wallet could be moved
 * into a vault or nowhere. That is not a wallet, it is a hole. This is the
 * exit.
 *
 * It is a plain SystemProgram.transfer, built in the browser, signed inside
 * Privy's iframe by the user's own key, and broadcast from here. No API
 * endpoint is involved and the server never sees a key or a destination —
 * there is nothing here for us to be trusted with, which is the point.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { api, type OnChainConfig } from "../lib/api";
import { useAuth } from "../lib/auth";
import {
  explorerTxUrl,
  isSolanaAddress,
  solanaConnection,
} from "../lib/onchain";

/**
 * Left behind on a "max" send to cover the signature fee.
 *
 * A base transfer costs 5,000 lamports. Sending the entire balance would
 * leave nothing to pay with and the transaction would simply fail, so "max"
 * means "everything minus enough to land".
 */
const FEE_RESERVE_SOL = 0.000_02;

type Step = "idle" | "signing" | "confirming" | "done";

/** Wait for a signature to reach `confirmed`, over HTTP only. */
async function pollConfirmed(connection: Connection, signature: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status?.err) {
      throw new Error(`transaction failed on chain: ${JSON.stringify(status.err)}`);
    }
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      return;
    }
    if (Date.now() > deadline) {
      // The signature is real and already shown; a slow cluster is not a
      // failed send, and saying otherwise would be the worse error.
      throw new Error(
        "still unconfirmed after 90s - check the signature on Solscan before retrying",
      );
    }
    await new Promise((r) => setTimeout(r, 1_500));
  }
}

export function SendSolPanel({ onSent }: { onSent?: () => void }) {
  const { wallet } = useAuth();

  const [config, setConfig] = useState<OnChainConfig | null>(null);
  const [balanceSol, setBalanceSol] = useState<number | null>(null);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [step, setStep] = useState<Step>("idle");
  const [signature, setSignature] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const address = wallet?.address ?? null;
  const cluster = config?.cluster ?? "mainnet-beta";

  useEffect(() => {
    let alive = true;
    api
      .onchainConfig()
      .then((c) => alive && setConfig(c))
      .catch((e: unknown) =>
        alive && setError(e instanceof Error ? e.message : "could not reach the API"),
      );
    return () => {
      alive = false;
    };
  }, []);

  // Read the balance straight from the chain rather than through our API:
  // this panel must keep working even when the backend does not, because
  // the money it moves is not ours.
  const loadBalance = useCallback(async () => {
    if (!config?.rpcUrl || !address) return;
    try {
      const conn = new Connection(config.rpcUrl, "confirmed");
      const lamports = await conn.getBalance(new PublicKey(address));
      setBalanceSol(lamports / 1e9);
    } catch {
      setBalanceSol(null);
    }
  }, [config?.rpcUrl, address]);
  useEffect(() => {
    void loadBalance();
  }, [loadBalance]);

  const num = Number.parseFloat(amount);
  const amountValid = Number.isFinite(num) && num > 0;
  const destValid = isSolanaAddress(to.trim());
  const sendingToSelf = destValid && to.trim() === address;
  const spendable =
    balanceSol === null ? null : Math.max(0, balanceSol - FEE_RESERVE_SOL);
  const tooMuch = amountValid && spendable !== null && num > spendable;
  const busy = step === "signing" || step === "confirming";
  const canSend =
    !!wallet && !!address && amountValid && destValid && !sendingToSelf && !tooMuch && !busy;

  function setMax() {
    if (spendable === null) return;
    setAmount(spendable.toFixed(9).replace(/0+$/, "").replace(/\.$/, ""));
  }

  async function send() {
    if (!wallet || !address || !config?.rpcUrl || !canSend) return;
    setError(null);
    setSignature(null);
    try {
      const connection = solanaConnection(config.rpcUrl);
      const from = new PublicKey(address);
      const dest = new PublicKey(to.trim());
      const lamports = BigInt(Math.round(num * 1e9));

      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: from,
          toPubkey: dest,
          lamports: Number(lamports),
        }),
      );
      // Privy signs whatever we hand it, so the blockhash and fee payer are
      // set here rather than left to a default.
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = from;

      setStep("signing");
      const sig = await wallet.sendTransaction(tx, connection);
      setSignature(sig);

      setStep("confirming");
      // Poll rather than `confirmTransaction`: that opens a websocket
      // subscription, and the browser's RPC is a same-origin HTTP proxy with
      // no websocket behind it. getSignatureStatuses is plain HTTP and says
      // the same thing.
      await pollConfirmed(connection, sig);
      setStep("done");
      setAmount("");
      void loadBalance();
      onSent?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("idle");
    }
  }

  if (!wallet || !address) {
    return (
      <div className="dimtx" style={{ fontSize: 12, textAlign: "center", padding: 12 }}>
        No wallet on this account yet — sign in to send.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%" }}>
      <div className="dimtx" style={{ fontSize: 11.5 }}>
        Balance{" "}
        <span className="mono" style={{ color: "var(--fg)" }}>
          {balanceSol === null ? "…" : `${balanceSol.toFixed(6)} SOL`}
        </span>
        {spendable !== null && (
          <>
            {" · "}
            sendable{" "}
            <span className="mono">{spendable.toFixed(6)}</span>{" "}
            <span title="left behind to pay the network fee">(fee reserve)</span>
          </>
        )}
      </div>

      <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <span className="dimtx" style={{ fontSize: 11 }}>
          Destination address
        </span>
        <input
          className="mono"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="Solana address"
          spellCheck={false}
          autoComplete="off"
          style={{ width: "100%", fontSize: 12 }}
        />
      </label>
      {to.trim() !== "" && !destValid && (
        <div className="dimtx" style={{ fontSize: 11, color: "var(--red)" }}>
          That is not a Solana address.
        </div>
      )}
      {sendingToSelf && (
        <div className="dimtx" style={{ fontSize: 11, color: "var(--red)" }}>
          That is this wallet's own address.
        </div>
      )}

      <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <span className="dimtx" style={{ fontSize: 11 }}>
          Amount (SOL)
        </span>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            className="mono"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.0"
            inputMode="decimal"
            style={{ flex: 1, fontSize: 12 }}
          />
          <button className="btn" onClick={setMax} disabled={spendable === null}>
            Max
          </button>
        </div>
      </label>
      {tooMuch && (
        <div className="dimtx" style={{ fontSize: 11, color: "var(--red)" }}>
          More than this wallet can send after the fee reserve.
        </div>
      )}

      <button className="btn primary" style={{ width: "100%" }} onClick={() => void send()} disabled={!canSend}>
        {step === "signing"
          ? "Confirm in Privy…"
          : step === "confirming"
            ? "Confirming…"
            : "Send"}
      </button>

      {error && (
        <div className="dimtx" style={{ fontSize: 11, color: "var(--red)", wordBreak: "break-word" }}>
          {error}
        </div>
      )}

      {signature && (
        <div className="dimtx" style={{ fontSize: 11.5, textAlign: "center" }}>
          {step === "done" ? "Sent. " : "Broadcast. "}
          <a href={explorerTxUrl(signature, cluster)} target="_blank" rel="noreferrer">
            View on Solscan
          </a>
        </div>
      )}

      <div className="dimtx" style={{ fontSize: 11, textAlign: "center" }}>
        Signed by your own key inside Privy. Trader Vaults never holds it and cannot
        move this balance.
      </div>
    </div>
  );
}
