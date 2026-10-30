/** Auth context split out so the Privy chunk and the app share one type. */
import { createContext } from "react";
import type { Connection, Transaction, VersionedTransaction } from "@solana/web3.js";

export interface AuthUser {
  id: string;
  handle: string;
  /** the user's own Solana wallet (Privy embedded), when provisioned */
  wallet?: string;
}

/**
 * The self-custody bridge.
 *
 * Everything the app needs to (a) prove to our API who the caller is and
 * (b) get a transaction signed — WITHOUT the app, or our server, ever
 * touching the key. `sendTransaction` hands the bytes to Privy, which
 * shows its own confirmation modal, signs inside its iframe and
 * broadcasts. We only ever see the resulting signature.
 *
 * null in demo mode (no VITE_PRIVY_APP_ID): there are no keys, so there
 * is nothing to sign with, and the real-deposit UI says so out loud
 * rather than pretending.
 */
export interface WalletBridge {
  /** true once Privy has finished loading the user's wallets */
  ready: boolean;
  /** base58 Solana address, or null while it is still being provisioned */
  address: string | null;
  /** short-lived Privy access token — sent as `Authorization: Bearer` */
  getAccessToken: () => Promise<string | null>;
  /** Privy identity token — sent as `privy-id-token`; proves the wallet */
  identityToken: string | null;
  /** sign + broadcast; resolves with the transaction signature */
  sendTransaction: (
    tx: VersionedTransaction | Transaction,
    connection: Connection,
  ) => Promise<string>;
  /** provision the embedded Solana wallet if login did not create one */
  createWallet: () => Promise<void>;
}

export interface AuthState {
  ready: boolean;
  user: AuthUser | null;
  demo: boolean;
  /** null in demo mode — see WalletBridge */
  wallet: WalletBridge | null;
  login: () => void;
  logout: () => void;
}

export const AuthContext = createContext<AuthState>({
  ready: false,
  user: null,
  demo: true,
  wallet: null,
  login: () => {},
  logout: () => {},
});
