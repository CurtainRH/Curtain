import { beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { migrate, type Db } from "@curtain/db";
import { pgliteDb } from "@curtain/db/pglite";
import { createApp } from "../src/app";

setDefaultTimeout(30_000); // PGlite's WASM start-up

const NOW = new Date("2026-09-30T12:00:00Z");
let db: Db;
let app: (req: Request) => Promise<Response>;
const get = async (path: string) => {
  const res = await app(new Request(`http://localhost${path}`));
  return { status: res.status, body: (await res.json()) as any };
};

beforeAll(async () => {
  db = await pgliteDb();
  await migrate(db);
  app = createApp(db, () => NOW);
  await db.exec(`
    INSERT INTO tokens (addr, symbol, is8056, multiplier, tvl) VALUES ('0xaa', 'USDG', false, 1000000000000000000, 500);
    INSERT INTO commitments (leaf_index, commit, block, shielded_at, standby_until, cleared, flagged) VALUES
      (0, '0x${"01".repeat(32)}', 1, '2026-09-30T11:50:00Z', '2026-09-30T12:05:00Z', false, false),
      (1, '0x${"02".repeat(32)}', 1, '2026-09-30T11:00:00Z', '2026-09-30T11:15:00Z', false, false),
      (2, '0x${"03".repeat(32)}', 1, '2026-09-30T11:50:00Z', '2026-09-30T12:05:00Z', true, false),
      (3, '0x${"04".repeat(32)}', 1, '2026-09-30T11:50:00Z', '2026-09-30T12:05:00Z', false, true);
    INSERT INTO providers (id, name, root, updated_at, active) VALUES
      (0, 'ofac', '0x01', '2026-09-30T10:00:00Z', true),
      (1, 'scam', '0x02', '2026-09-28T10:00:00Z', true),
      (2, 'asp',  '0x03', '2026-09-30T10:00:00Z', false);
    INSERT INTO solvency (epoch, ts, token, pool_balance, live_notes) VALUES
      (1, '2026-09-30T10:00:00Z', '0xaa', 500, 400), (2, '2026-09-30T11:00:00Z', '0xaa', 500, 490);
  `);
});

describe("GET /health", () => {
  it("returns ok with an ISO timestamp", async () => {
    const { status, body } = await get("/health");
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
    expect(body.version).toBe("0.0.1");
  });

  it("404s unknown routes", async () => {
    expect((await get("/nope")).status).toBe(404);
  });
});

describe("read endpoints", () => {
  it("/ppoi/status reports standby, spendable, cleared and flagged", async () => {
    expect((await get(`/ppoi/status/0x${"01".repeat(32)}`)).body.status).toBe("standby");
    expect((await get(`/ppoi/status/0x${"02".repeat(32)}`)).body.status).toBe("spendable");
    expect((await get(`/ppoi/status/0x${"03".repeat(32)}`)).body.status).toBe("cleared");
    expect((await get(`/ppoi/status/0x${"04".repeat(32)}`)).body.status).toBe("flagged");
    expect((await get(`/ppoi/status/0x${"05".repeat(32)}`)).status).toBe(404);
  });

  it("/providers marks stale and removed providers and derives the standby window", async () => {
    const { body } = await get("/providers");
    expect(body.providers.map((p: any) => p.stale)).toEqual([false, true, true]);
    expect(body.freshCount).toBe(1);
    expect(body.standbyMinutes).toBe(60);
  });

  it("/tokens and /solvency/latest return aggregates only", async () => {
    expect((await get("/tokens")).body[0]).toMatchObject({ symbol: "USDG", tvl: "500" });
    const latest = (await get("/solvency/latest")).body;
    expect(latest.length).toBe(1);
    expect(latest[0]).toMatchObject({ epoch: "2", ok: true });
  });
});
