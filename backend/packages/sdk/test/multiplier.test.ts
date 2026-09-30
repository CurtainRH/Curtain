import { describe, expect, it } from "bun:test";
import { computeDisplayBalance, fetchUiMultiplier } from "../src/pool-client";

const WAD = 1_000_000_000_000_000_000n;
const TOKEN = "0x000000000000000000000000000000000000FEeD" as const;

/** A minimal real HTTP server matching multiplier-view's actual response shape
 * (services/multiplier-view/src/server.ts), used to test fetchUiMultiplier's real fetch
 * logic against a real response, not a mocked function. */
function startFakeMultiplierView(multiplier: bigint | null) {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === `/multiplier/${TOKEN}`) {
        if (multiplier === null) return new Response("not found", { status: 404 });
        return Response.json({ address: TOKEN, symbol: "NVDA", is8056: true, multiplier: multiplier.toString(), nextMultiplier: null, effectiveAt: null });
      }
      return new Response("not found", { status: 404 });
    },
  });
}

describe("computeDisplayBalance", () => {
  it("applies a WAD-scaled multiplier to a raw amount", () => {
    expect(computeDisplayBalance(100n, WAD)).toBe(100n);
    expect(computeDisplayBalance(100n, WAD * 10n)).toBe(1000n); // 10-for-1 split
    expect(computeDisplayBalance(100n, WAD / 2n)).toBe(50n); // reverse split
  });
});

describe("fetchUiMultiplier", () => {
  it("returns the live multiplier from a running multiplier-view service", async () => {
    const server = startFakeMultiplierView(WAD * 10n);
    try {
      const multiplier = await fetchUiMultiplier(TOKEN, `http://127.0.0.1:${server.port}`);
      expect(multiplier).toBe(WAD * 10n);
    } finally {
      server.stop(true);
    }
  });

  it("falls back to 1.0x when the token isn't registered (404)", async () => {
    const server = startFakeMultiplierView(null);
    try {
      const multiplier = await fetchUiMultiplier(TOKEN, `http://127.0.0.1:${server.port}`);
      expect(multiplier).toBe(WAD);
    } finally {
      server.stop(true);
    }
  });

  it("falls back to 1.0x when the service is unreachable", async () => {
    // Nothing listening on this port — fetch should reject/refuse the connection.
    const multiplier = await fetchUiMultiplier(TOKEN, "http://127.0.0.1:1");
    expect(multiplier).toBe(WAD);
  });
});
