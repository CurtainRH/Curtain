/**
 * @curtain/api HTTP handler: the read side of Curtain_Backend.md §3.2, over the indexer's
 * public-aggregate tables. Nothing here can link a note to an address, an amount or another
 * note, because no table holds that.
 *
 *   GET /health
 *   GET /tokens                  registered tokens, TVL, multiplier
 *   GET /ppoi/status/:commit     cleared | flagged | standby | spendable, standbyUntil
 *   GET /providers               list roots, freshness (stale after 24h)
 *   GET /broadcasters            bond, fees, failures
 *   GET /solvency/latest         latest finalized epoch per token
 *   GET /recipes                 recipe registry
 *   GET /stats                   daily activity counts (last 30 days)
 *
 * Building transactions (shield.build, transact.build, relay.build, ...) happens in the
 * wallet SDK, which holds the keys; the server never sees note secrets.
 *
 * No listener and no infrastructure here: `server.ts` wires in the database.
 */
import type { Db } from "@curtain/db";
import pkg from "../package.json";

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function createApp(db: Db, now: () => Date = () => new Date()): (req: Request) => Promise<Response> {
  return async (req) => {
    const url = new URL(req.url);
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);

    try {
      if (url.pathname === "/health") {
        return json({ status: "ok", timestamp: now().toISOString(), version: pkg.version });
      }

      if (url.pathname === "/tokens") {
        const rows = await db.query(
          "SELECT addr, symbol, is8056, multiplier::text, next_mult::text, next_at, tvl::text FROM tokens ORDER BY symbol",
        );
        return json(rows);
      }

      const status = url.pathname.match(/^\/ppoi\/status\/(0x[0-9a-fA-F]{64})$/);
      if (status) {
        const rows = await db.query<{ cleared: boolean; flagged: boolean; standby_until: string | Date }>(
          "SELECT cleared, flagged, standby_until FROM commitments WHERE lower(commit) = lower($1)",
          [status[1]],
        );
        const c = rows[0];
        if (!c) return json({ error: "unknown commitment" }, 404);
        const standbyUntil = new Date(c.standby_until);
        const state = c.flagged ? "flagged" : c.cleared ? "cleared" : now() < standbyUntil ? "standby" : "spendable";
        return json({ status: state, standbyUntil: standbyUntil.toISOString() });
      }

      if (url.pathname === "/providers") {
        const rows = await db.query<{ id: number; name: string; root: string; updated_at: string | Date | null; active: boolean }>(
          "SELECT id, name, root, updated_at, active FROM providers ORDER BY id",
        );
        const t = now().getTime();
        const providers = rows.map((p) => {
          const updatedAt = p.updated_at ? new Date(p.updated_at) : null;
          const fresh = p.active && updatedAt !== null && t - updatedAt.getTime() <= STALE_AFTER_MS;
          return { id: p.id, name: p.name, root: p.root, updatedAt: updatedAt?.toISOString() ?? null, active: p.active, stale: !fresh };
        });
        const freshCount = providers.filter((p) => !p.stale).length;
        return json({ providers, freshCount, standbyMinutes: freshCount < 2 ? 60 : 15 });
      }

      if (url.pathname === "/broadcasters") {
        return json(await db.query(
          "SELECT addr, bond::text, fee_bps, gas_markup_bps, submitted, failed, uptime_30d::text FROM broadcasters ORDER BY bond DESC",
        ));
      }

      if (url.pathname === "/solvency/latest") {
        return json(await db.query(
          `SELECT DISTINCT ON (token) token, epoch::text, ts, pool_balance::text, live_notes::text, tx,
             (live_notes <= pool_balance) AS ok
           FROM solvency ORDER BY token, epoch DESC`,
        ));
      }

      if (url.pathname === "/recipes") {
        return json(await db.query("SELECT id, name, version, targets, audited FROM recipes ORDER BY id"));
      }

      if (url.pathname === "/stats") {
        return json(await db.query(
          "SELECT day::text, kind, count::text FROM activity WHERE day >= (now() - interval '30 days')::date ORDER BY day, kind",
        ));
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: "internal error" }, 500);
    }
  };
}
