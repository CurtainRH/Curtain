// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// Curtain media (images, films, fonts) is hosted by Lovable under /__l5e/. Lovable serves that
// path itself; everywhere else (local dev, preview) proxy it to the published Lovable site.
const lovableAssets = {
  "/__l5e": { target: "https://curtainlah.lovable.app", changeOrigin: true },
};

export default defineConfig({
  vite: {
    server: { proxy: lovableAssets },
    preview: { proxy: lovableAssets },
  },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});
