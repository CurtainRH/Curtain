/**
 * GET /multiplier/:token — public, per Curtain_Build.md §3.1/§4's multiplier-view service.
 * POST /multiplier/:token and /multiplier/:token/schedule — admin-only (shared-secret
 * header), the write path a real corporate-actions feed or ops operator would call once
 * wired up (see store.ts's header for why this can't be a real live feed integration here).
 */
import { MultiplierStore, WAD, type TokenMultiplierRecord } from "./store";

function serializeRecord(r: TokenMultiplierRecord) {
  return {
    address: r.address,
    symbol: r.symbol,
    is8056: r.is8056,
    multiplier: r.multiplier.toString(),
    nextMultiplier: r.nextMultiplier?.toString() ?? null,
    effectiveAt: r.effectiveAt,
  };
}

export function createMultiplierViewServer(port: number, adminToken: string, store: MultiplierStore = new MultiplierStore()) {
  function isAuthorized(req: Request): boolean {
    const header = req.headers.get("authorization");
    return header === `Bearer ${adminToken}`;
  }

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health" && req.method === "GET") {
        return Response.json({ ok: true });
      }

      if (url.pathname === "/multiplier" && req.method === "GET") {
        return Response.json(store.list().map(serializeRecord));
      }

      const tokenMatch = url.pathname.match(/^\/multiplier\/(0x[0-9a-fA-F]{40})$/);
      if (tokenMatch && req.method === "GET") {
        const record = store.get(tokenMatch[1]!);
        if (!record) return Response.json({ error: "unknown token" }, { status: 404 });
        return Response.json(serializeRecord(record));
      }

      if (tokenMatch && req.method === "POST") {
        if (!isAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
        try {
          const body = (await req.json()) as { multiplier: string };
          const record = store.setMultiplier(tokenMatch[1]!, BigInt(body.multiplier));
          return Response.json(serializeRecord(record));
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : "bad request" }, { status: 400 });
        }
      }

      const scheduleMatch = url.pathname.match(/^\/multiplier\/(0x[0-9a-fA-F]{40})\/schedule$/);
      if (scheduleMatch && req.method === "POST") {
        if (!isAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
        try {
          const body = (await req.json()) as { nextMultiplier: string; effectiveAt: number };
          const record = store.scheduleMultiplier(scheduleMatch[1]!, BigInt(body.nextMultiplier), body.effectiveAt);
          return Response.json(serializeRecord(record));
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : "bad request" }, { status: 400 });
        }
      }

      const registerMatch = url.pathname === "/register";
      if (registerMatch && req.method === "POST") {
        if (!isAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
        try {
          const body = (await req.json()) as { address: string; symbol: string; is8056: boolean };
          const record = store.register(body.address, body.symbol, body.is8056);
          return Response.json(serializeRecord(record));
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : "bad request" }, { status: 400 });
        }
      }

      return new Response("not found", { status: 404 });
    },
  });

  return { server, store };
}

export { WAD };
