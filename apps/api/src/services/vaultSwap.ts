// ── Real vault trading through Jupiter Router v6 ─────────────────────
// This service handles on-chain trading for real vaults by wrapping Jupiter
// Router v6 swaps in the vault program's execute_swap instruction.
//
// THE WALL (trading.ts): Real vaults execute on-chain only.
// This service is what the trading service calls when vault.mode === "real".

import {
  AddressLookupTableAccount,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
} from "@solana/spl-token";
import {
  buildExecuteSwapIx,
  buildUnwrapSolIx,
  buildWrapSolIx,
  fetchVaultAccount,
  vaultTokenAccount,
  VAULT_PROGRAM_ID,
  WSOL_MINT,
  JUPITER_ROUTER_V6,
} from "./program.js";
import { getConnection, tryGetServerKeypair } from "./signer.js";
import { getTokenInfo } from "./prices.js";
import { env } from "../env.js";
import { computeBudgetIxs } from "./priorityFee.js";

// ── constants ────────────────────────────────────────────────────────

// Jupiter v6 (quote-api.jup.ag) is decommissioned — it does not respond at
// all, so every swap attempt failed at the first call. The current API is
// swap/v1 on lite-api (keyless, rate-limited) or api.jup.ag (keyed).
//
// We ask for INSTRUCTIONS, not a prebuilt transaction. The swap has to run
// inside the vault program's execute_swap via CPI, and a prebuilt
// VersionedTransaction is signed for a different fee payer and hides its
// accounts behind address lookup tables we would have to reconstruct.
const JUPITER_BASE = process.env.JUPITER_API_BASE ?? "https://lite-api.jup.ag/swap/v1";
const JUPITER_QUOTE_API = `${JUPITER_BASE}/quote`;
const JUPITER_SWAP_IX_API = `${JUPITER_BASE}/swap-instructions`;

// ── types ─────────────────────────────────────────────────────────────

/**
 * v1 returns the quote object directly. The old code read `data[0]` off a
 * `{data: [...]}` envelope that no version of the API has returned for years,
 * so it threw "No route found" on every call even when a route existed.
 * The whole object is echoed back to /swap-instructions verbatim.
 */
interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string | number;
  routePlan: RouteStep[];
}

interface RouteStep {
  swapInfo: {
    ammKey: string;
    label: string;
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    feeAmount: string;
    feeMint: string;
  };
  percent: number;
}

/** One instruction as Jupiter serialises it. */
interface JupiterIx {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string; // base64
}

interface JupiterSwapInstructions {
  computeBudgetInstructions?: JupiterIx[];
  setupInstructions?: JupiterIx[];
  swapInstruction: JupiterIx;
  cleanupInstruction?: JupiterIx | null;
  /**
   * MUST be resolved and supplied when compiling a v0 message. The previous
   * implementation deserialised a prebuilt transaction and read
   * `staticAccountKeys`, which silently omits every account that lives in a
   * lookup table — Jupiter routes routinely put most of their accounts there,
   * so the resulting account list was incomplete.
   */
  addressLookupTableAddresses?: string[];
  prioritizationFeeLamports?: number;
  computeUnitLimit?: number;
  simulationError?: unknown;
}

export interface VaultSwapParams {
  vaultId: string;
  vaultPda: PublicKey;
  inputMint: PublicKey;
  outputMint: PublicKey;
  amountIn: bigint;
  maxPriceImpactBps?: number;
  slippageBps?: number;
}

export interface VaultSwapResult {
  signature: string;
  feeLamports: number | null;
  inputAmount: bigint;
  outputAmount: bigint;
  priceImpactPct: number;
}

// ── Jupiter API helpers ───────────────────────────────────────────────

async function getJupiterQuote(params: {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps?: number;
}) {
  const { inputMint, outputMint, amount, slippageBps = 100 } = params;

  const url = new URL(JUPITER_QUOTE_API);
  url.searchParams.set("inputMint", inputMint);
  url.searchParams.set("outputMint", outputMint);
  url.searchParams.set("amount", amount.toString());
  url.searchParams.set("slippageBps", slippageBps.toString());
  // onlyDirectRoutes was forced on, which rejects most real routes for no
  // stated reason. Leave routing to Jupiter and bound the risk with
  // slippage and the price-impact check instead.
  url.searchParams.set("asLegacyTransaction", "false");

  const response = await fetch(url.toString(), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Jupiter quote failed: ${response.status} ${response.statusText}`);
  }

  const quote = (await response.json()) as JupiterQuote;
  if (!quote?.outAmount) {
    throw new Error("No route found");
  }

  return {
    // the raw object, echoed verbatim into /swap-instructions
    raw: quote,
    inAmount: BigInt(quote.inAmount),
    outAmount: BigInt(quote.outAmount),
    // v1 sends priceImpactPct as a decimal STRING ("0.0034" = 0.34%), not a
    // number. Number() on it is fine; the old `|| 0` on a string was not.
    priceImpactPct: Number(quote.priceImpactPct) || 0,
    routePlan: quote.routePlan ?? [],
  };
}

/**
 * Ask Jupiter for the swap INSTRUCTIONS for a quote.
 *
 * This is a POST with the quote object in the body. The previous version sent
 * a GET with query parameters, which no version of this endpoint accepts.
 */
async function getJupiterSwapInstructions(params: {
  quote: JupiterQuote;
  userPublicKey: string;
  prioritizationFeeLamports?: number;
}): Promise<JupiterSwapInstructions> {
  const { quote, userPublicKey, prioritizationFeeLamports } = params;

  const response = await fetch(JUPITER_SWAP_IX_API, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey,
      // The vault PDA cannot create its own token accounts by signing, so
      // setup instructions must be surfaced rather than silently assumed.
      wrapAndUnwrapSol: true,
      ...(prioritizationFeeLamports !== undefined
        ? { prioritizationFeeLamports }
        : {}),
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Jupiter swap-instructions failed: ${response.status} ${response.statusText} ${body.slice(0, 200)}`,
    );
  }

  const data = (await response.json()) as JupiterSwapInstructions;
  if (!data?.swapInstruction?.programId) {
    throw new Error("Jupiter returned no swap instruction");
  }
  if (data.simulationError) {
    throw new Error(`Jupiter simulation failed: ${JSON.stringify(data.simulationError).slice(0, 200)}`);
  }
  return data;
}

export async function executeVaultSwap(params: VaultSwapParams): Promise<VaultSwapResult> {
  const { 
    vaultId, 
    vaultPda, 
    inputMint, 
    outputMint, 
    amountIn, 
    maxPriceImpactBps = 500,
    slippageBps = 100 
  } = params;

  // Jupiter does not index devnet. There are no devnet routes, no devnet
  // liquidity and no devnet pools behind this API, so a swap here cannot
  // succeed no matter how correct the code is. Fail with the reason rather
  // than with "No route found", which reads like a thin-liquidity problem
  // and sends whoever hits it looking in the wrong place.
  if (env.solanaCluster !== "mainnet-beta" && env.solanaCluster !== "mainnet") {
    throw new Error(
      `Real swaps require mainnet: Jupiter has no ${env.solanaCluster} coverage. ` +
        `Vault trading stays disabled until the program is deployed to mainnet.`,
    );
  }

  console.log(`[vault-swap] Starting swap for vault ${vaultId}: ${amountIn} ${inputMint.toBase58()} -> ${outputMint.toBase58()}`);

  // 1. Get quote to validate route and price impact
  const quote = await getJupiterQuote({
    inputMint: inputMint.toBase58(),
    outputMint: outputMint.toBase58(),
    amount: amountIn,
    slippageBps,
  });

  if (quote.priceImpactPct > maxPriceImpactBps / 100) {
    throw new Error(
      `Price impact ${quote.priceImpactPct}% exceeds max ${maxPriceImpactBps / 100}%`
    );
  }

  console.log(`[vault-swap] Quote: ${quote.inAmount} -> ${quote.outAmount} (${quote.priceImpactPct}% impact)`);

  // 2. Ask Jupiter for the swap INSTRUCTIONS (not a prebuilt transaction).
  const jupiterIxs = await getJupiterSwapInstructions({
    quote: quote.raw,
    userPublicKey: vaultPda.toBase58(),
  });

  // 3. Resolve the address lookup tables the route depends on.
  //
  // Jupiter puts most of a route's accounts in lookup tables. The previous
  // implementation deserialised a prebuilt transaction and used
  // `staticAccountKeys`, which contains only the handful of accounts NOT in a
  // table — so the account list handed to the vault program was missing most
  // of the route and the CPI could not have succeeded.
  const connection = getConnection();
  const altAddresses = jupiterIxs.addressLookupTableAddresses ?? [];
  const lookupTables: AddressLookupTableAccount[] = [];
  for (const addr of altAddresses) {
    const res = await connection.getAddressLookupTable(new PublicKey(addr));
    if (!res.value) {
      throw new Error(`Address lookup table ${addr} could not be fetched`);
    }
    lookupTables.push(res.value);
  }

  // 4. Resolve who signs, and prove they are allowed to.
  //
  // The previous code passed the VAULT PDA as `authority`. A PDA has no
  // private key, so the transaction could never be fully signed — and even
  // with a signature the program requires `vault.is_trade_authority(authority)`,
  // which the vault itself is not. The PDA is the CPI signer INSIDE the
  // program; the outer signer is the trader.
  const keyResult = tryGetServerKeypair();
  if ("error" in keyResult) {
    throw new Error(`Cannot sign transaction: ${keyResult.error}`);
  }
  const signer = keyResult.keypair;

  const vaultAccount = await fetchVaultAccount(connection, vaultPda);
  if (!vaultAccount) {
    throw new Error(`vault ${vaultPda.toBase58()} does not exist on-chain`);
  }
  const isTradeAuthority =
    vaultAccount.data.trader.equals(signer.publicKey) ||
    (!vaultAccount.data.operator.equals(PublicKey.default) &&
      vaultAccount.data.operator.equals(signer.publicKey));
  if (!isTradeAuthority) {
    throw new Error(
      `${signer.publicKey.toBase58()} is neither this vault's trader ` +
        `(${vaultAccount.data.trader.toBase58()}) nor its operator — the program ` +
        "would reject the swap Unauthorized",
    );
  }

  // 5. The two legs, as vault-owned token accounts.
  //
  // A buy spends the vault's wSOL float, so it must exist and hold enough.
  // Nothing created or funded it before — there was no wrap_sol builder at
  // all — which is why a vault could never have a source account to swap
  // from. The ATAs themselves are created permissionlessly through the
  // Associated Token program; the vault program never creates them.
  const sourceToken = vaultTokenAccount(vaultPda, inputMint);
  const destToken = vaultTokenAccount(vaultPda, outputMint);
  const setupIxs: TransactionInstruction[] = [];

  const buyingWithSol = inputMint.equals(WSOL_MINT);
  if (buyingWithSol) {
    setupIxs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        signer.publicKey,
        sourceToken,
        vaultPda,
        WSOL_MINT,
      ),
    );
    const wsolBalance = await connection
      .getTokenAccountBalance(sourceToken, "confirmed")
      .then((r) => BigInt(r.value.amount))
      .catch(() => 0n);
    if (wsolBalance < amountIn) {
      // wrap_sol moves vault SOL into the float. It is gated on the vault's
      // own free SOL, so this fails cleanly when the vault cannot afford it.
      setupIxs.push(
        buildWrapSolIx({
          authority: signer.publicKey,
          vault: vaultPda,
          amountLamports: amountIn - wsolBalance,
        }).ix,
        // wrap_sol moves the lamports; telling the Token program to notice is
        // a separate, permissionless act. See buildWrapSolIx.
        createSyncNativeInstruction(sourceToken),
      );
    }
  }
  // The receiving side must exist before the swap can pay into it.
  setupIxs.push(
    createAssociatedTokenAccountIdempotentInstruction(
      signer.publicKey,
      destToken,
      vaultPda,
      outputMint,
    ),
  );

  // 6. Build the vault program's execute_swap.
  const minAmountOut = (quote.outAmount * BigInt(10_000 - slippageBps)) / 10_000n;
  if (minAmountOut <= 0n) {
    throw new Error("quote produced a zero minimum output; refusing to build the swap");
  }

  const executeSwapIx = buildExecuteSwapIx({
    authority: signer.publicKey,
    vault: vaultPda,
    sourceToken,
    destToken,
    swapInstruction: jupiterIxs.swapInstruction,
    maxIn: amountIn,
    minOut: minAmountOut,
  });

  // 7. Compose, sign and SEND THE TRANSACTION WE BUILT.
  //
  // The previous code assembled a correct v0 message with the lookup tables
  // and compute budget, signed it — and then threw it away, handing a bare
  // re-wrapped instruction to sendAndConfirm, which builds its own message
  // with NEITHER. A Jupiter route without its lookup tables does not fit in a
  // transaction, and without the compute-unit bump it exhausts the default
  // 200k limit. Whatever was tested, it was not what got sent.
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  const budgetIxs = await computeBudgetIxs({
    accountKeys: jupiterIxs.swapInstruction.accounts.map((a) => a.pubkey),
    computeUnitLimit: jupiterIxs.computeUnitLimit ?? 400_000,
  });

  // Selling back into SOL leaves the proceeds sitting in the vault's wSOL
  // account, where they back NAV but cannot pay a withdrawal — every payout
  // path spends the vault PDA's own lamports. Closing the float in the same
  // transaction returns it. (settle_unwrap exists as the permissionless
  // backstop for when this did not happen; it should not be the normal path.)
  const teardownIxs: TransactionInstruction[] = [];
  if (outputMint.equals(WSOL_MINT)) {
    teardownIxs.push(
      buildUnwrapSolIx({ authority: signer.publicKey, vault: vaultPda }).ix,
    );
  }

  const message = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: blockhash,
    instructions: [...budgetIxs, ...setupIxs, executeSwapIx, ...teardownIxs],
  }).compileToV0Message(lookupTables);

  const tx = new VersionedTransaction(message);
  tx.sign([signer]);

  console.log(`[vault-swap] Sending transaction...`);
  const signature = await connection.sendTransaction(tx, {
    skipPreflight: false,
    maxRetries: 3,
  });
  const confirmation = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  if (confirmation.value.err) {
    throw new Error(
      `execute_swap failed on chain: ${JSON.stringify(confirmation.value.err)} (${signature})`,
    );
  }
  const txInfo = await connection
    .getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })
    .catch(() => null);
  const result = { signature, feeLamports: txInfo?.meta?.fee ?? null };

  console.log(`[vault-swap] Success: ${result.signature}`);

  return {
    signature: result.signature,
    feeLamports: result.feeLamports,
    inputAmount: amountIn,
    outputAmount: quote.outAmount,
    priceImpactPct: quote.priceImpactPct,
  };
}

// ── Validation helpers ───────────────────────────────────────────────

/**
 * Validate that a swap is acceptable for vault trading.
 * Checks: price impact, route complexity, mint allowlist, etc.
 */
export async function validateVaultSwap(params: {
  inputMint: PublicKey;
  outputMint: PublicKey;
  amountIn: bigint;
  maxPriceImpactBps?: number;
  vaultId: string;
}): Promise<{ valid: boolean; reason?: string; quote?: any }> {
  const { inputMint, outputMint, amountIn, maxPriceImpactBps = 500, vaultId } = params;

  try {
    // Get a quote first
    const quote = await getJupiterQuote({
      inputMint: inputMint.toBase58(),
      outputMint: outputMint.toBase58(),
      amount: amountIn,
      slippageBps: 100,
    });

    // Check price impact
    if (quote.priceImpactPct > maxPriceImpactBps / 100) {
      return {
        valid: false,
        reason: `Price impact ${quote.priceImpactPct}% exceeds max ${maxPriceImpactBps / 100}%`,
        quote,
      };
    }

    // Check route complexity
    if (quote.routePlan.length > 3) {
      return {
        valid: false,
        reason: `Route too complex (${quote.routePlan.length} hops)`,
        quote,
      };
    }

    // Validate tokens have live prices
    const [inputInfo, outputInfo] = await Promise.all([
      getTokenInfo(inputMint.toBase58()),
      getTokenInfo(outputMint.toBase58()),
    ]);

    if (inputInfo.source === "none" || outputInfo.source === "none") {
      return {
        valid: false,
        reason: "One or more tokens have no live price",
        quote,
      };
    }

    return { valid: true, quote };
  } catch (error) {
    return {
      valid: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
