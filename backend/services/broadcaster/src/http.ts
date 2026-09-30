/**
 * HTTPS fallback transport, per Curtain_Build.md §4.1 ("plus HTTPS
 * fallback POST /bundle"). The libp2p gossipsub mesh (`curtain/bundles/v1`)
 * this is a fallback FOR is not implemented in M7 — see Curtain_Build.md
 * §11 for why (real P2P networking needs multiple physical/containerized
 * nodes to test meaningfully, which is out of scope for this environment).
 * This HTTP surface is fully real and is what test/broadcaster.e2e.test.ts
 * exercises.
 */
import type { Hex } from "viem";
import type { BroadcasterNode } from "./node";
import type { Bundle } from "./types";

function reviveBundle(body: unknown): Bundle {
  const b = body as Record<string, unknown>;
  return {
    chainId: Number(b.chainId),
    kind: b.kind as Bundle["kind"],
    to: b.to as Bundle["to"],
    calldata: b.calldata as Hex,
    feeToken: b.feeToken as Bundle["feeToken"],
    feeAmount: BigInt(b.feeAmount as string),
    deadline: Number(b.deadline),
    extDataHash: b.extDataHash as Hex,
    sig: b.sig as Hex | undefined,
  };
}

export function createBroadcasterServer(node: BroadcasterNode, port: number) {
  return Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health" && req.method === "GET") {
        return Response.json({ ok: true });
      }

      if (url.pathname === "/fees.json" && req.method === "GET") {
        return Response.json(node.publishFeeSchedule());
      }

      if (url.pathname === "/bundle" && req.method === "POST") {
        try {
          const bundle = reviveBundle(await req.json());
          await node.trackBundle(bundle);
          const txHash = await node.submitBundle(bundle);
          return Response.json({ txHash });
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 422 });
        }
      }

      return new Response("not found", { status: 404 });
    },
  });
}
