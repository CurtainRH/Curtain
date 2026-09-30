/**
 * HTTP handler for @curtain/api. No listener and no infrastructure here, so tests can
 * call `handle` directly. `server.ts` is the only entry point that touches Postgres.
 */
import pkg from "../package.json";

export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/health" && req.method === "GET") {
    return Response.json({ status: "ok", timestamp: new Date().toISOString(), version: pkg.version });
  }

  return Response.json({ error: "not found" }, { status: 404 });
}
