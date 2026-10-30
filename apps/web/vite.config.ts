import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // one .env at the monorepo root serves web + api. Without this Vite
  // would only read apps/web/.env and VITE_PRIVY_APP_ID would silently
  // never load.
  envDir: "../../",
  build: {
    // Enable minification
    minify: "terser",
    terserOptions: {
      compress: {
        drop_console: true,
        drop_debugger: true,
      },
    },
    rollupOptions: {
      output: {
        // No manual chunking.
        //
        // A hand-written manualChunks splitter lived here and took the site
        // down: it grouped node_modules by substring, which produced seven
        // circular chunk graphs (rollup warned "vendor -> react -> solana ->
        // vendor" and friends). Cycles make cross-chunk evaluation order
        // undefined, so `buffer` ran before base64-js/ieee754 it depends on
        // and died with "Cannot set properties of undefined (setting
        // 'byteLength')" — a blank page, every route, in production only.
        //
        // Rollup's default chunking derives order from the real dependency
        // graph and cannot produce these cycles. Caching gains are not worth
        // a class of bug that only appears in a built bundle.
        // Chunk file naming with content hash for long-term caching
        chunkFileNames: "assets/js/[name]-[hash].js",
        entryFileNames: "assets/js/[name]-[hash].js",
        assetFileNames: "assets/[ext]/[name]-[hash].[ext]",
      },
    },
    // Optimize chunk size warnings
    chunkSizeWarningLimit: 1000,
    // Target modern browsers
    target: "esnext",
  },
  // Optimize dependencies
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react-router-dom",
    ],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
  // Development server performance
  esbuild: {
    logOverride: { "this-is-undefined-in-esm": "silent" },
  },
});
