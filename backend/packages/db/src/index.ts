/**
 * Minimal Postgres access shared by @curtain/api and @curtain/indexer. `Db` is a two-method
 * interface so production runs on Bun's built-in client (`bunSqlDb`) and tests run on PGlite
 * (real Postgres in WASM) without a server.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  /** Runs `fn` in a transaction; rolls back if it throws. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  /** Multi-statement SQL, no parameters (migrations). */
  exec(text: string): Promise<void>;
}

export const MIGRATIONS_DIR = join(import.meta.dir, "../../../db/migrations");

/** Production adapter over Bun's built-in Postgres client. */
export async function bunSqlDb(url = process.env["DATABASE_URL"]): Promise<Db> {
  if (!url) throw new Error("DATABASE_URL is not set");
  const { SQL } = await import("bun");
  const sql = new SQL(url);
  const wrap = (s: InstanceType<typeof SQL>): Db => ({
    query: async <T>(text: string, params: unknown[] = []) => (await s.unsafe(text, params as never[])) as T[],
    exec: async (text: string) => {
      await s.unsafe(text).simple();
    },
    transaction: <T>(fn: (tx: Db) => Promise<T>) => s.begin((tx) => fn(wrap(tx as unknown as InstanceType<typeof SQL>))) as Promise<T>,
  });
  return wrap(sql);
}

/**
 * Applies `dir`/*.sql in filename order, once each, recorded in schema_migrations. Each file
 * runs in its own transaction; a failure rolls back and throws.
 */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const applied = new Set((await db.query<{ filename: string }>("SELECT filename FROM schema_migrations")).map((r) => r.filename));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const text = await Bun.file(join(dir, file)).text();
    await db.transaction(async (tx) => {
      await tx.exec(text);
      await tx.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
    });
    ran.push(file);
  }
  return ran;
}
