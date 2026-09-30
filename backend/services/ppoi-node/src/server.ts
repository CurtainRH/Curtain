/**
 * HTTP API for the PPOI node:
 * - GET  /health
 * - GET  /roots                  local list/flag roots per provider
 * - GET  /witness/:origin        non-membership witnesses against the gate's current roots
 * - POST /prove                  { commit, token, rawAmount, ownerPkX, blinding } -> { txHash }
 *   (opt-in: sends the note opening to this node; see node.ts's header)
 */
import { isAddress, type Address, type Hex } from "viem";
import type { PpoiNode } from "./node";
import { toBytes32 } from "./trees";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)), {
    status,
    headers: { "content-type": "application/json" },
  });

export function createPpoiHandler(node: PpoiNode): (req: Request) => Promise<Response> {
  return async (req) => {
    const url = new URL(req.url);
    try {
      if (req.method === "GET" && url.pathname === "/health") return json({ status: "ok", providers: node.trees.size });

      if (req.method === "GET" && url.pathname === "/roots") {
        return json(
          [...node.trees].map(([id, t]) => ({ id, listRoot: toBytes32(t.listRoot), flagRoot: toBytes32(t.flagRoot), size: t.addresses.length })),
        );
      }

      const w = url.pathname.match(/^\/witness\/(0x[0-9a-fA-F]{40})$/);
      if (req.method === "GET" && w) return json(await node.witnessFor(w[1] as Address));

      if (req.method === "POST" && url.pathname === "/prove") {
        const b = (await req.json()) as Record<string, string>;
        if (!b["commit"] || !b["token"] || !isAddress(b["token"])) return json({ error: "commit and token required" }, 400);
        const txHash = await node.proveAndClear({
          commit: b["commit"] as Hex,
          token: b["token"] as Address,
          rawAmount: BigInt(b["rawAmount"]!),
          ownerPkX: BigInt(b["ownerPkX"]!),
          blinding: BigInt(b["blinding"]!),
        });
        return json({ txHash });
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  };
}
