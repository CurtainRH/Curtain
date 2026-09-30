import { describe, expect, it } from "bun:test";
import { createMultiplierViewServer } from "../src/server";
import { MultiplierStore, WAD } from "../src/store";

const ADMIN_TOKEN = "test-admin-token";
const TOKEN_ADDR = "0x000000000000000000000000000000000000FEeD";

function startServer() {
  const { server, store } = createMultiplierViewServer(0, ADMIN_TOKEN);
  return { server, store, base: `http://127.0.0.1:${server.port}` };
}

describe("multiplier-view server", () => {
  it("returns 404 for an unregistered token", async () => {
    const { server, base } = startServer();
    try {
      const res = await fetch(`${base}/multiplier/${TOKEN_ADDR}`);
      expect(res.status).toBe(404);
    } finally {
      server.stop(true);
    }
  });

  it("register (authorized) then GET returns a 1.0x default multiplier", async () => {
    const { server, base } = startServer();
    try {
      const registerRes = await fetch(`${base}/register`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ address: TOKEN_ADDR, symbol: "NVDA", is8056: true }),
      });
      expect(registerRes.status).toBe(200);

      const res = await fetch(`${base}/multiplier/${TOKEN_ADDR}`);
      const body = (await res.json()) as { multiplier: string; symbol: string };
      expect(res.status).toBe(200);
      expect(body.multiplier).toBe(WAD.toString());
      expect(body.symbol).toBe("NVDA");
    } finally {
      server.stop(true);
    }
  });

  it("register without the admin token is rejected", async () => {
    const { server, base } = startServer();
    try {
      const res = await fetch(`${base}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: TOKEN_ADDR, symbol: "NVDA", is8056: true }),
      });
      expect(res.status).toBe(401);
    } finally {
      server.stop(true);
    }
  });

  it("setMultiplier (authorized) immediately changes the current multiplier", async () => {
    const { server, base, store } = startServer();
    try {
      store.register(TOKEN_ADDR, "TSLA", true);
      // 10-for-1 split: each raw unit now displays as 10x.
      const newMultiplier = WAD * 10n;
      const res = await fetch(`${base}/multiplier/${TOKEN_ADDR}`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ multiplier: newMultiplier.toString() }),
      });
      const body = (await res.json()) as { multiplier: string };
      expect(res.status).toBe(200);
      expect(body.multiplier).toBe(newMultiplier.toString());
    } finally {
      server.stop(true);
    }
  });

  it("scheduling a future multiplier does not change the current one until effectiveAt passes", async () => {
    const store = new MultiplierStore();
    store.register(TOKEN_ADDR, "SPY", true);
    const future = Math.floor(Date.now() / 1000) + 3600;
    store.scheduleMultiplier(TOKEN_ADDR, WAD * 2n, future);

    const before = store.get(TOKEN_ADDR)!;
    expect(before.multiplier).toBe(WAD); // unchanged — raw notes never move on schedule alone
    expect(before.nextMultiplier).toBe(WAD * 2n);
    expect(before.effectiveAt).toBe(future);
  });

  it("promotes a scheduled multiplier to current once effectiveAt has passed", async () => {
    const store = new MultiplierStore();
    store.register(TOKEN_ADDR, "QQQ", true);
    const past = Math.floor(Date.now() / 1000) - 1;
    store.scheduleMultiplier(TOKEN_ADDR, WAD * 2n, past);

    const after = store.get(TOKEN_ADDR)!;
    expect(after.multiplier).toBe(WAD * 2n);
    expect(after.nextMultiplier).toBeNull();
    expect(after.effectiveAt).toBeNull();
  });

  it("scheduling then setting immediately clears the pending schedule", () => {
    const store = new MultiplierStore();
    store.register(TOKEN_ADDR, "HOOD", true);
    store.scheduleMultiplier(TOKEN_ADDR, WAD * 3n, Math.floor(Date.now() / 1000) + 3600);
    store.setMultiplier(TOKEN_ADDR, WAD * 5n);

    const record = store.get(TOKEN_ADDR)!;
    expect(record.multiplier).toBe(WAD * 5n);
    expect(record.nextMultiplier).toBeNull();
  });

  it("rejects scheduling a non-positive multiplier", () => {
    const store = new MultiplierStore();
    store.register(TOKEN_ADDR, "NVDA", true);
    expect(() => store.scheduleMultiplier(TOKEN_ADDR, 0n, Math.floor(Date.now() / 1000) + 60)).toThrow();
  });

  it("GET /multiplier lists every registered token", async () => {
    const store = new MultiplierStore();
    store.register("0x0000000000000000000000000000000000AAAA", "AAA", false);
    store.register("0x0000000000000000000000000000000000BBBB", "BBB", true);
    const { server } = createMultiplierViewServer(0, ADMIN_TOKEN, store);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/multiplier`);
      const body = (await res.json()) as { symbol: string }[];
      expect(body).toHaveLength(2);
      expect(body.map((r) => r.symbol).sort()).toEqual(["AAA", "BBB"]);
    } finally {
      server.stop(true);
    }
  });
});
