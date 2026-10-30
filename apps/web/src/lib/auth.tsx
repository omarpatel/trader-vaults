/**
 * Account creation, not wallet-connect.
 *
 * With VITE_PRIVY_APP_ID set, Privy handles email/Google/passkey signup and
 * silently provisions an embedded self-custodial Solana wallet (exportable
 * key — the Axiom/Photon trust pattern). Without it, a local demo user is
 * signed in so the whole UI works before any keys exist.
 *
 * The Privy tree lives in its own lazily-loaded chunk (PrivyAuth.tsx): it
 * drags in WalletConnect's Ethereum provider stack, which this Solana-only
 * platform must not make every visitor download.
 */
import { Suspense, lazy, useMemo, useState, type ReactNode } from "react";
import { AuthContext, type AuthState } from "./authContext";

export type { AuthUser, AuthState, WalletBridge } from "./authContext";
export { useAuth } from "./useAuth";

const PRIVY_APP_ID: string | undefined = import.meta.env.VITE_PRIVY_APP_ID;

const PrivyAuth = lazy(() => import("./PrivyAuth"));

function DemoAuth({ children }: { children: ReactNode }) {
  const [signedIn, setSignedIn] = useState(true);
  const value = useMemo<AuthState>(
    () => ({
      ready: true,
      demo: true,
      // no fake wallet address — a real one arrives with Privy
      user: signedIn ? { id: "demo-user", handle: "you" } : null,
      // no keys exist in demo mode, so there is nothing that can sign a
      // real deposit. Null, not a stub: the deposit UI must be able to
      // tell the difference and say so.
      wallet: null,
      login: () => setSignedIn(true),
      logout: () => setSignedIn(false),
    }),
    [signedIn],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  if (!PRIVY_APP_ID) return <DemoAuth>{children}</DemoAuth>;
  return (
    <Suspense fallback={<div className="empty">Connecting your account…</div>}>
      <PrivyAuth appId={PRIVY_APP_ID}>{children}</PrivyAuth>
    </Suspense>
  );
}
