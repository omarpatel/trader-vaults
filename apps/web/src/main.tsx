// MUST be the first import: it installs globalThis.Buffer before any
// @solana module body evaluates. See polyfills.ts for why the assignment
// cannot live in this file.
import "./polyfills";

import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import "./theme.css";
import "./styles/animations.css";
import App from "./App";
import { AuthProvider } from "./lib/auth";
import { ToastProvider } from "./lib/toast";
import { Landing } from "./pages/Landing";
import { Explore } from "./pages/Explore";
import { VaultPage } from "./pages/VaultPage";
import { Portfolio } from "./pages/Portfolio";
import { Terminal } from "./pages/Terminal";
import { Pulse } from "./pages/Pulse";
import { TraderDashboard } from "./pages/TraderDashboard";
import { Tracking } from "./pages/Tracking";
import { TokenPage } from "./pages/TokenPage";
import { CreateVault } from "./pages/CreateVault";
import { TraderPage } from "./pages/TraderPage";
import { Leaderboards } from "./pages/Leaderboards";
import { ProfileEditor } from "./pages/ProfileEditor";

function Crash() {
  return (
    <div style={{ padding: 40, textAlign: "center" }}>
      <h1 style={{ fontFamily: "var(--display)" }}>Something broke</h1>
      <p style={{ color: "var(--muted)" }}>
        The page hit an error. <a href="/explore">Back to the app</a>
      </p>
    </div>
  );
}

const router = createBrowserRouter([
  { path: "/", element: <Landing />, errorElement: <Crash /> },
  {
    path: "/",
    element: <App />,
    errorElement: <Crash />,
    children: [
      { path: "explore", element: <Explore /> },
      { path: "vault/:id", element: <VaultPage /> },
      { path: "portfolio", element: <Portfolio /> },
      { path: "terminal", element: <Terminal mode="real" /> },
      { path: "paper", element: <Terminal mode="paper" /> },
      { path: "pulse", element: <Pulse /> },
      { path: "dashboard", element: <TraderDashboard /> },
      { path: "tracking", element: <Tracking /> },
      { path: "token/:mint", element: <TokenPage /> },
      { path: "trader/:handle", element: <TraderPage /> },
      { path: "leaderboards", element: <Leaderboards /> },
      { path: "settings/profile", element: <ProfileEditor /> },
      { path: "create", element: <CreateVault /> },
      { path: "*", element: <Navigate to="/explore" replace /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthProvider>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </AuthProvider>
  </React.StrictMode>,
);
