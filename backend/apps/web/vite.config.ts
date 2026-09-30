import { defineConfig } from "vite";

export default defineConfig({
  // Node core modules (node:fs, node:child_process, ...) transitively pulled in by
  // @curtain/sdk's LocalNodeProverBackend/prover.ts must never end up in this bundle — this
  // app always configures CurtainWallet with a ProverAssistBackend (see main.ts), which is
  // pure browser-safe fetch + @noble/* crypto, and prover-backend.ts's lazy dynamic import
  // means the local-prover code is never even fetched by the browser. `buffer` (needed by
  // circomlibjs for Poseidon/BabyJub) IS polyfilled, but via a plain module import at the
  // top of main.ts (browser-polyfills.ts) rather than a plugin — see that file's header for
  // why ordering matters here and a plugin wasn't reliable in this workspace's node_modules
  // layout (vite-plugin-node-polyfills couldn't resolve its own shim from a sibling
  // workspace package's file location).
  build: {
    target: "es2022",
  },
  server: {
    port: 5173,
  },
});
