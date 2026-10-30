/**
 * REAL deposits — signed by the depositor, never by us.
 *
 * The flow this component drives is the whole custody argument:
 *
 *   prepare  → the API builds an UNSIGNED transaction whose authority and
 *              fee payer are THIS user's wallet, and returns it as base64
 *   sign     → Privy shows its own confirmation modal, signs inside its
 *              iframe and broadcasts. The key never touches this page,
 *              and never touches our server
 *   confirm  → the API fetches the signature from the cluster and checks
 *              it really ran our program against this vault before it
 *              records anything
 *
 * Nothing here is simulated and nothing is optimistic: every number shown
 * after a deposit comes back from the chain.
 */
import { useCallback, useEffect, useState } from "react";
import { fmtSol, type Vault } from "@trader-vaults/shared";
import {
  ApiError,
  api,
  type ConfirmedDeposit,
  type OnChainConfig,
  type OnChainMe,
  type OnChainVaultView,
} from "../lib/api";
import { useAuth } from "../lib/useAuth";
import {
  decodeTransaction,
  explorerAddressUrl,
  explorerTxUrl,
  formatShares,
  lamportsToSol,
  solanaConnection,
} from "../lib/onchain";

const PRESETS = [0.01, 0.05, 0.1, 0.5];

/** Fee headroom mirrored from the API so the warning matches its 400. */
const FEE_HEADROOM_SOL = 0.000025;

type Step = "idle" | "preparing" | "signing" | "confirming" | "done";

const STEP_LABEL: Record<Exclude<Step, "idle" | "done">, string> = {
  preparing: "Building your transaction…",
  signing: "Waiting for your wallet…",
  confirming: "Verifying on-chain…",
};

function shortAddr(a: string): string {
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

export function RealDepositPanel({ vault, onChanged }: { vault: Vault; onChanged: () => void }) {
  const { user, wallet, login, ready, demo } = useAuth();

  const [config, setConfig] = useState<OnChainConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [me, setMe] = useState<OnChainMe | null>(null);
  const [meError, setMeError] = useState<ApiError | null>(null);
  const [chainError, setChainError] = useState<ApiError | Error | null>(null);
  const [chain, setChain] = useState<OnChainVaultView | null>(null);

  const [amount, setAmount] = useState("0.05");
  const [step, setStep] = useState<Step>("idle");
  const [signature, setSignature] = useState<string | null>(null);
  const [result, setResult] = useState<ConfirmedDeposit | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);

  // Read from the API rather than assumed: the panel used to default to
  // "devnet" and print it in a pill next to a mainnet deposit form.
  const cluster = config?.cluster ?? "mainnet-beta";
  const address = wallet?.address ?? null;

  // ── cluster + program facts (public, no auth) ─────────────────────
  useEffect(() => {
    let alive = true;
    api
      .onchainConfig()
      .then((c) => alive && setConfig(c))
      .catch((e: unknown) => alive && setConfigError(e instanceof Error ? e.message : "failed"));
    return () => {
      alive = false;
    };
  }, []);

  // ── live program state for this vault (+ this wallet's position) ──
  const loadChain = useCallback(() => {
    let alive = true;
    api
      .vaultOnchain(vault.id, address ?? undefined)
      .then((v) => {
        if (!alive) return;
        setChain(v);
        setChainError(null);
      })
      // The rejection used to be swallowed and `chain` set to null, which is
      // the SAME state as "still loading" — so a vault whose on-chain account
      // could not be read rendered the deposit form with the stale-NAV guard
      // silently disabled and the button enabled. Failing to read the chain is
      // exactly when a deposit form should not be offered.
      .catch((e: unknown) => {
        if (!alive) return;
        setChain(null);
        setChainError(e instanceof ApiError ? e : new Error(String(e)));
      });
    return () => {
      alive = false;
    };
  }, [vault.id, address]);
  useEffect(() => loadChain(), [loadChain]);

  // ── who am I, and what does my wallet hold? ───────────────────────
  const tokens = useCallback(async () => {
    if (!wallet) throw new Error("no wallet bridge");
    return { accessToken: await wallet.getAccessToken(), identityToken: wallet.identityToken };
  }, [wallet]);

  const loadMe = useCallback(async () => {
    if (!wallet || !user || !address) return;
    try {
      setMe(await api.onchainMe(await tokens()));
      setMeError(null);
    } catch (e) {
      setMe(null);
      setMeError(e instanceof ApiError ? e : new ApiError(0, {}, String(e)));
    }
  }, [wallet, user, address, tokens]);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  // ── amounts ──────────────────────────────────────────────────────
  const num = Number.parseFloat(amount);
  const amountOk = Number.isFinite(num) && num > 0 && num <= (config?.maxDepositSol ?? 1000);
  const rentSol = config?.depositorRentLamports
    ? lamportsToSol(config.depositorRentLamports)
    : 0.00207;
  const hasDepositorAccount = (chain?.depositor?.shares ?? null) !== null;
  const estimatedTotal =
    (Number.isFinite(num) ? num : 0) + (hasDepositorAccount ? 0 : rentSol) + FEE_HEADROOM_SOL;
  const balanceSol = me ? me.balanceSol : null;
  const shortfall = balanceSol === null ? 0 : estimatedTotal - balanceSol;
  const tooPoor = amountOk && balanceSol !== null && shortfall > 0;

  const busy = step !== "idle" && step !== "done";

  async function submit() {
    if (!wallet || !amountOk) return;
    setError(null);
    setResult(null);
    setSignature(null);
    try {
      setStep("preparing");
      const auth = await tokens();
      const prepared = await api.prepareOnchainDeposit(auth, vault.id, num);

      // Sign + broadcast with the USER's wallet. This is the only step
      // that touches a key, and it happens inside Privy, not here.
      setStep("signing");
      const tx = decodeTransaction(prepared.transaction);
      const connection = solanaConnection(prepared.rpcUrl);
      const sig = await wallet.sendTransaction(tx, connection);
      setSignature(sig);

      setStep("confirming");
      const confirmed = await api.confirmOnchainDeposit(auth, vault.id, sig);
      setResult(confirmed);
      setStep("done");
      loadChain();
      void loadMe();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
      setStep("idle");
    }
  }

  // ── shells ───────────────────────────────────────────────────────

  const header = (
    <div className="sectiontitle" style={{ marginTop: 0 }}>
      Deposit{" "}
      <span className="pill real" style={{ marginLeft: 6 }}>
        on-chain
      </span>
      {config && (
        <span className="pill" style={{ marginLeft: 6 }}>
          {cluster}
        </span>
      )}
    </div>
  );

  function shell(children: React.ReactNode) {
    return (
      <div className="panel panel-pad">
        {header}
        {children}
      </div>
    );
  }

  if (configError) {
    return shell(<div className="callout red">Couldn't reach the chain config: {configError}</div>);
  }
  if (!config) {
    return shell(<div className="empty">Reading chain config…</div>);
  }
  if (config.mainnetRefused) {
    return shell(
      <div className="callout red">
        This build refuses real deposits on <strong>{cluster}</strong>.
      </div>,
    );
  }
  if (!config.privyConfigured || demo || !wallet) {
    return shell(
      <div className="callout">
        Accounts are not switched on in this environment, so there is no wallet that could sign a
        deposit. Nothing here is simulated — set <span className="mono">VITE_PRIVY_APP_ID</span> and
        real deposits open.
      </div>,
    );
  }
  if (!ready || !wallet.ready) {
    return shell(<div className="empty">Loading your account…</div>);
  }
  if (!user) {
    return shell(
      <>
        <div className="callout" style={{ marginBottom: 12 }}>
          Deposits are signed by <strong>your own wallet</strong>, not by us. Create an account (or
          sign in) and one is provisioned for you — the key stays yours and is exportable.
        </div>
        <button className="btn buy" style={{ width: "100%" }} onClick={login}>
          Sign in to deposit
        </button>
      </>,
    );
  }
  if (!address) {
    return shell(
      <>
        <div className="callout" style={{ marginBottom: 12 }}>
          You're signed in, but no Solana wallet has been provisioned on this account yet.
        </div>
        <button
          className="btn"
          style={{ width: "100%" }}
          onClick={() => void wallet.createWallet().then(() => void loadMe())}
        >
          Create my wallet
        </button>
      </>,
    );
  }
  if (chainError) {
    const code = chainError instanceof ApiError ? (chainError.body?.code as string | undefined) : undefined;
    return shell(
      <div className="callout red">
        {code === "legacy_vault_needs_migration" ? (
          <>
            This vault is still on the previous on-chain layout and is being migrated.
            Deposits into it are unavailable until that finishes. Nothing is at risk —
            it holds no depositor funds.
          </>
        ) : (
          <>
            Couldn't read this vault's on-chain state:{" "}
            {chainError instanceof ApiError
              ? String(chainError.body?.error ?? chainError.message)
              : chainError.message}
            . The deposit form is hidden rather than shown against numbers we cannot
            verify.
          </>
        )}
      </div>,
    );
  }

  if (meError) {
    return shell(
      <div className="callout red">
        Couldn't verify your account with the API: {meError.message}
        {meError.code ? ` (${meError.code})` : ""}
      </div>,
    );
  }

  // ── the real form ────────────────────────────────────────────────

  const navAgeSec = chain ? Math.floor(Date.now() / 1000) - chain.vault.navPostedAt : null;
  const navStale =
    chain !== null && navAgeSec !== null && navAgeSec > chain.vault.navStalenessSeconds;

  return (
    <div className="panel panel-pad">
      {header}

      <div className="callout" style={{ marginBottom: 12 }}>
        You sign this deposit yourself. The server builds the transaction, your wallet approves and
        broadcasts it, and your shares are held by a program account only your key controls.
      </div>

      {/* ── wallet ── */}
      <div style={{ marginBottom: 12 }}>
        <div className="kv">
          <span className="k">Your wallet</span>
          <span className="v mono">
            <a href={explorerAddressUrl(address, cluster)} target="_blank" rel="noreferrer">
              {shortAddr(address)}
            </a>
          </span>
        </div>
        <div className="kv">
          <span className="k">Balance</span>
          <span className="v">{balanceSol === null ? "…" : `${balanceSol.toFixed(6)} ◎`}</span>
        </div>
        {chain?.depositor && (
          <div className="kv">
            <span className="k">Your shares</span>
            <span className="v mono">{formatShares(chain.depositor.shares)}</span>
          </div>
        )}
        <div className="kv">
          <span className="k">Vault account</span>
          <span className="v mono">
            {chain ? (
              <a href={explorerAddressUrl(chain.vaultPda, cluster)} target="_blank" rel="noreferrer">
                {shortAddr(chain.vaultPda)}
              </a>
            ) : (
              "…"
            )}
          </span>
        </div>
      </div>

      {navStale && (
        <div className="callout red" style={{ marginBottom: 12 }}>
          This vault's NAV mark is {navAgeSec}s old (limit {chain?.vault.navStalenessSeconds}s). The
          program refuses deposits against a stale mark — try again once the keeper posts.
        </div>
      )}

      {/* ── amount ── */}
      <div className="field">
        <label>Amount (SOL)</label>
        <input
          type="number"
          min="0"
          step="0.01"
          placeholder="0.0"
          value={amount}
          disabled={busy}
          onChange={(e) => setAmount(e.target.value)}
        />
      </div>
      <div className="presetrow" style={{ marginBottom: 12 }}>
        {PRESETS.map((v) => (
          <button key={v} className="chip" disabled={busy} onClick={() => setAmount(String(v))}>
            {v}◎
          </button>
        ))}
      </div>

      {/* ── what it costs ── */}
      <div style={{ marginBottom: 12 }}>
        <div className="kv">
          <span className="k">Deposit</span>
          <span className="v">{Number.isFinite(num) ? num.toFixed(6) : "0.000000"} ◎</span>
        </div>
        {!hasDepositorAccount && (
          <div className="kv">
            <span className="k">Your depositor account (rent, one time)</span>
            <span className="v">{rentSol.toFixed(6)} ◎</span>
          </div>
        )}
        <div className="kv">
          <span className="k">Network fee (est.)</span>
          <span className="v">{FEE_HEADROOM_SOL.toFixed(6)} ◎</span>
        </div>
        <div className="kv">
          <span className="k">Total from your wallet</span>
          <span className="v">{estimatedTotal.toFixed(6)} ◎</span>
        </div>
        <div className="kv">
          <span className="k">Performance fee</span>
          <span className="v">{(vault.perfFeeBps / 100).toFixed(0)}% of profit</span>
        </div>
      </div>

      {tooPoor && (
        <div className="callout red" style={{ marginBottom: 12 }}>
          Your wallet holds {balanceSol?.toFixed(6)} ◎ but this deposit needs about{" "}
          {estimatedTotal.toFixed(6)} ◎ — {shortfall.toFixed(6)} ◎ short.
          {!hasDepositorAccount && (
            <>
              {" "}
              Your first deposit also pays {rentSol.toFixed(6)} ◎ of rent for your own depositor
              account, which is why a brand-new wallet can't deposit its entire balance.
            </>
          )}{" "}
          {cluster === "devnet" && (
            <>
              Fund it from a devnet faucet (
              <a href="https://faucet.solana.com" target="_blank" rel="noreferrer">
                faucet.solana.com
              </a>
              ) and try again.
            </>
          )}
        </div>
      )}

      <button
        className="btn buy"
        style={{ width: "100%" }}
        disabled={busy || !amountOk || tooPoor || navStale}
        onClick={() => void submit()}
      >
        {busy ? "…" : `Deposit ${Number.isFinite(num) ? num : 0} ◎`}
      </button>

      {busy && (
        <div className="callout" style={{ marginTop: 12 }}>
          {STEP_LABEL[step as Exclude<Step, "idle" | "done">]}
          {step === "signing" && (
            <>
              {" "}
              Approve it in the wallet dialog — that signature is what makes the shares yours.
            </>
          )}
        </div>
      )}

      {error && (
        <div className="callout red" style={{ marginTop: 12 }}>
          <strong>{depositErrorHeadline(error)}</strong>
          <div style={{ marginTop: 4 }}>{error.message}</div>
          {signature && (
            <div style={{ marginTop: 6 }}>
              Your transaction was broadcast:{" "}
              <a href={explorerTxUrl(signature, cluster)} target="_blank" rel="noreferrer">
                <span className="mono">{shortAddr(signature)}</span>
              </a>{" "}
              — check the explorer before retrying so you don't deposit twice.
            </div>
          )}
        </div>
      )}

      {result && step === "done" && (
        <div className="callout green" style={{ marginTop: 12 }}>
          <strong>
            Deposited {fmtSol(result.deposit.amountSol)} ◎ — real SOL, on {cluster}.
          </strong>
          <div className="kv" style={{ marginTop: 6 }}>
            <span className="k">Shares minted</span>
            <span className="v mono">{formatShares(result.deposit.sharesMinted)}</span>
          </div>
          <div className="kv">
            <span className="k">Your total shares</span>
            <span className="v mono">{formatShares(result.deposit.sharesAfter)}</span>
          </div>
          <div className="kv">
            <span className="k">Transaction</span>
            <span className="v mono">
              <a
                href={explorerTxUrl(result.deposit.signature, cluster)}
                target="_blank"
                rel="noreferrer"
              >
                {shortAddr(result.deposit.signature)}
              </a>
            </span>
          </div>
          <div className="kv">
            <span className="k">Your depositor account</span>
            <span className="v mono">
              <a
                href={explorerAddressUrl(result.deposit.depositorPda, cluster)}
                target="_blank"
                rel="noreferrer"
              >
                {shortAddr(result.deposit.depositorPda)}
              </a>
            </span>
          </div>
        </div>
      )}

      <p className="dimtx" style={{ fontSize: 12, marginBottom: 0, marginTop: 12 }}>
        The trader can trade this money but can never withdraw it. Your shares live in a program
        account whose authority is your key — not ours, and withdrawals are on-chain too: the
        Withdraw tab above signs them with the same key. The program has NOT been independently
        audited, so deposit only what you are willing to lose.
      </p>
    </div>
  );
}

/** Turn the API's `code` into a one-line headline the user can act on. */
function depositErrorHeadline(error: ApiError | Error): string {
  if (!(error instanceof ApiError)) {
    return /reject|denied|cancel/i.test(error.message)
      ? "You cancelled the signature"
      : "Deposit failed";
  }
  switch (error.code) {
    case "insufficient_balance":
      return "Not enough SOL in your wallet";
    case "nav_stale":
      return "The vault's price mark is stale";
    case "vault_not_active":
      return "This vault is not accepting deposits";
    case "withdraw_request_pending":
      return "You have a pending withdrawal";
    case "mainnet_refused":
      return "Real deposits are refused on this cluster";
    case "missing_token":
    case "invalid_token":
    case "wallet_unverified":
      return "We couldn't verify your account";
    case "tx_failed":
      return "The transaction landed but failed on-chain";
    case "tx_not_found":
      return "That transaction isn't on the cluster yet";
    default:
      return "Deposit failed";
  }
}
