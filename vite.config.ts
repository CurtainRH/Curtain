// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import type { ProxyOptions } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";

// Curtain media (images, films, fonts) is hosted by Lovable under /__l5e/. Lovable serves that
// path itself; everywhere else (local dev, preview) proxy it to the published Lovable site.
const operatorTarget =
  process.env["CURTAIN_API_URL"] ||
  process.env["CURTAIN_OPERATOR_URL"] ||
  process.env["OPERATOR_API_URL"] ||
  process.env["VITE_CURTAIN_API_URL"] ||
  "http://localhost:3100";

const devProxies: Record<string, ProxyOptions> = {
  "/__l5e": { target: "https://curtainlah.lovable.app", changeOrigin: true },
  "/api/curtain": {
    target: operatorTarget,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api\/curtain/, ""),
    configure: (proxy) => {
      proxy.on("error", (_err: Error, _req: IncomingMessage, res: unknown) => {
        const httpRes = res as ServerResponse | undefined;
        if (httpRes && typeof httpRes.writeHead === "function" && !httpRes.headersSent) {
          httpRes.writeHead(503, { "Content-Type": "application/json" });
          httpRes.end(
            JSON.stringify({
              error: "Curtain operator backend is offline or awaiting mainnet deployment.",
              status: "pending_deployment",
            }),
          );
        }
      });
    },
  },
};

export default defineConfig({
  vite: {
    server: { proxy: devProxies },
    preview: { proxy: devProxies },
  },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});
