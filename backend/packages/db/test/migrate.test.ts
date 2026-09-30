import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/index";
import { pgliteDb } from "../src/pglite";

setDefaultTimeout(30_000); // PGlite's WASM start-up can exceed the 5s default on a cold run

describe("migrate", () => {
  it("applies the repo's migrations once, in order", async () => {
    const db = await pgliteDb();
    const first = await migrate(db);
    expect(first[0]).toBe("001_initial.sql");
    expect(await migrate(db)).toEqual([]);
    const tables = (await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    )).map((r) => r.table_name);
    for (const t of ["tokens", "commitments", "providers", "broadcasters", "recipes", "solvency", "schema_migrations"]) {
      expect(tables).toContain(t);
    }
  });

  it("rolls back a failing migration and records nothing for it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    writeFileSync(join(dir, "001_ok.sql"), "CREATE TABLE a (x int);");
    writeFileSync(join(dir, "002_bad.sql"), "CREATE TABLE b (x int); SELECT * FROM does_not_exist;");
    const db = await pgliteDb();
    await expect(migrate(db, dir)).rejects.toThrow();
    const done = (await db.query<{ filename: string }>("SELECT filename FROM schema_migrations")).map((r) => r.filename);
    expect(done).toEqual(["001_ok.sql"]);
    const b = await db.query("SELECT to_regclass('public.b') AS t");
    expect(b[0]!["t"]).toBeNull();
  });
});
