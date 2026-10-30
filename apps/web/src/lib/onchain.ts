// ── user-signed on-chain transactions ───────────────────────────────
// Deposits into a REAL vault are signed by the depositor, not by us:
// the API builds an unsigned transaction (it knows the PDAs, the program
// layout and a fresh blockhash), the user's Privy embedded wallet signs
// and broadcasts it, and we hand the signature back so the API can
// record it against the vault.
//
// The server never holds the user's key — that is the whole point of the
// custody story, and it is why deposits cannot be a server-side call.

import { Connection, VersionedTransaction, Transaction } from "@solana/web3.js";

/** Cluster the app trades against, mirrored from the API's /api/meta. */
export function solanaConnection(rpcUrl: string): Connection {
  return new Connection(rpcUrl, "confirmed");
}

/**
 * Decode a base64 transaction from the API. Handles both v0 (versioned)
 * and legacy encodings so the API can switch without breaking the client.
 */
export function decodeTransaction(base64: string): VersionedTransaction | Transaction {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  try {
    return VersionedTransaction.deserialize(bytes);
  } catch {
    return Transaction.from(bytes);
  }
}

/** True when the wallet address looks like a real Solana pubkey. */
export function isSolanaAddress(v: string | undefined): v is string {
  return typeof v === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
}

// ── display helpers ─────────────────────────────────────────────────
// The shared solscan* helpers assume mainnet. Real vaults run on devnet
// today, and a devnet signature opened without ?cluster resolves to
// nothing — which reads as "the transaction never happened". These
// carry the cluster through so a proof link always proves something.

/** Solscan needs an explicit cluster for anything but mainnet-beta. */
function clusterQuery(cluster: string): string {
  return cluster === "mainnet-beta" || cluster === "mainnet" ? "" : `?cluster=${cluster}`;
}

export function explorerTxUrl(signature: string, cluster: string): string {
  return `https://solscan.io/tx/${signature}${clusterQuery(cluster)}`;
}

export function explorerAddressUrl(address: string, cluster: string): string {
  return `https://solscan.io/account/${address}${clusterQuery(cluster)}`;
}

/** Lamports (u64, arrives as a decimal string) → SOL. */
export function lamportsToSol(lamports: string | number | bigint): number {
  return Number(BigInt(lamports)) / 1e9;
}

/**
 * Shares are stored on-chain as u128 in units of 1e12 per SOL, so they
 * arrive as decimal strings that overflow a Number. Convert with BigInt
 * first, then format — parsing the string as a float directly loses
 * precision on any realistic balance.
 */
const SHARE_UNITS_PER_SOL = 1_000_000_000_000n;

export function formatShares(raw: string | bigint, decimals = 4): string {
  const units = BigInt(raw);
  const whole = units / SHARE_UNITS_PER_SOL;
  const frac = units % SHARE_UNITS_PER_SOL;
  const fracStr = frac.toString().padStart(12, "0").slice(0, decimals);
  return decimals > 0 ? `${whole}.${fracStr}` : whole.toString();
}
