/** PGlite adapter for tests: real Postgres semantics, in-process, no server. */
import { PGlite } from "@electric-sql/pglite";
import type { Db } from "./index";

export async function pgliteDb(): Promise<Db> {
  const pg = new PGlite();
  const wrap = (c: Pick<PGlite, "query" | "exec">): Db => ({
    query: async <T>(text: string, params: unknown[] = []) => (await c.query<T>(text, params)).rows,
    exec: async (text: string) => {
      await c.exec(text);
    },
    transaction: <T>(fn: (tx: Db) => Promise<T>) => pg.transaction((tx) => fn(wrap(tx))),
  });
  return wrap(pg);
}
