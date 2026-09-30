/**
 * Applies backend/db/migrations/*.sql in filename order, once each, recorded in
 * schema_migrations. Each file runs in its own transaction; a failure rolls back and throws.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SQL } from "bun";

export const MIGRATIONS_DIR = join(import.meta.dir, "../../../db/migrations");

export async function migrate(sql: SQL, dir = MIGRATIONS_DIR): Promise<string[]> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;

  const applied = new Set(
    ((await sql`SELECT filename FROM schema_migrations`) as { filename: string }[]).map((r) => r.filename),
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const text = await Bun.file(join(dir, file)).text();
    await sql.begin(async (tx) => {
      await tx.unsafe(text).simple();
      await tx`INSERT INTO schema_migrations (filename) VALUES (${file})`;
    });
    ran.push(file);
  }
  return ran;
}
