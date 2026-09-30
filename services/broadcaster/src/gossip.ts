/**
 * Real libp2p gossipsub mesh on topic `curtain/bundles/v1`, per Curtain_Build.md §4.1's
 * "Waku-style relay listener" and §11's item 22, which deferred this: "real P2P networking
 * needs multiple physical/containerized nodes to test meaningfully, out of scope for this
 * environment." That's true for testing across real geographic/network boundaries, but
 * gossipsub propagation between distinct libp2p node instances IS meaningfully testable with
 * multiple in-process nodes connected over loopback TCP — the same technique libp2p's own
 * test suite uses — so this module is implemented and has a real propagation test
 * (gossip.e2e.test.ts), not just scaffolding.
 *
 * A gossip node feeds every bundle it receives into the SAME `BroadcasterNode.trackBundle`/
 * `submitBundle` pipeline the HTTPS fallback (http.ts) uses — there is exactly one place
 * assignment/censorship-fallback logic lives, regardless of which transport a bundle arrived
 * through. Bundles this node itself decides to broadcast (e.g. relayed from its own HTTP
 * intake) are published back onto the same topic so other mesh peers see them too.
 */
import { createLibp2p, type Libp2p } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { gossipsub, type GossipsubEvents } from "@chainsafe/libp2p-gossipsub";
import { identify, type Identify } from "@libp2p/identify";
import { multiaddr } from "@multiformats/multiaddr";
import type { PubSub } from "@libp2p/interface";
import type { Hex } from "viem";
import type { BroadcasterNode } from "./node";
import type { Bundle } from "./types";

export const BUNDLE_TOPIC = "curtain/bundles/v1";

// Explicitly named (not inferred) so tsc's declaration emit doesn't need to reach into
// node_modules' hashed package-manager storage path to describe this type portably.
interface GossipLibp2pServices extends Record<string, unknown> {
  identify: Identify;
  pubsub: PubSub<GossipsubEvents>;
}
type Libp2pNode = Libp2p<GossipLibp2pServices>;

function createGossipLibp2p(listenPort: number): Promise<Libp2pNode> {
  return createLibp2p({
    addresses: { listen: [`/ip4/127.0.0.1/tcp/${listenPort}`] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }),
    },
  });
}

export interface GossipNode {
  libp2p: Libp2pNode;
  /** This node's own multiaddrs — hand one of these to another node's `bootstrapPeers` to connect them. */
  multiaddrs: string[];
  /** Publishes a bundle onto the mesh; every subscribed peer's message handler receives it. */
  publishBundle(bundle: Bundle): Promise<void>;
  stop(): Promise<void>;
}

function serializeBundle(bundle: Bundle): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ ...bundle, feeAmount: bundle.feeAmount.toString() }),
  );
}

function deserializeBundle(bytes: Uint8Array): Bundle {
  const raw = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  return {
    chainId: Number(raw.chainId),
    kind: raw.kind as Bundle["kind"],
    to: raw.to as Bundle["to"],
    calldata: raw.calldata as Hex,
    feeToken: raw.feeToken as Bundle["feeToken"],
    feeAmount: BigInt(raw.feeAmount as string),
    deadline: Number(raw.deadline),
    extDataHash: raw.extDataHash as Hex,
    sig: raw.sig as Hex | undefined,
  };
}

/**
 * Starts a gossipsub-connected libp2p node subscribed to `curtain/bundles/v1`. Every message
 * received is decoded and handed to `broadcasterNode.trackBundle` (always) and
 * `broadcasterNode.submitBundle` (best-effort — a `NotYetAssignableError` for a bundle this
 * node isn't the assignee for yet is expected and swallowed, matching the same
 * assignment-window logic the HTTPS fallback already enforces; any other error is logged,
 * not thrown, so one bad message never kills the gossip loop for the rest of the mesh).
 */
export async function startGossipNode(
  broadcasterNode: BroadcasterNode,
  opts: { listenPort?: number; bootstrapPeers?: string[]; onError?: (e: unknown) => void } = {},
): Promise<GossipNode> {
  const libp2p = await createGossipLibp2p(opts.listenPort ?? 0);

  const pubsub = libp2p.services.pubsub;
  pubsub.subscribe(BUNDLE_TOPIC);

  pubsub.addEventListener("message", (evt) => {
    if (evt.detail.topic !== BUNDLE_TOPIC) return;
    (async () => {
      const bundle = deserializeBundle(evt.detail.data);
      await broadcasterNode.trackBundle(bundle);
      try {
        await broadcasterNode.submitBundle(bundle);
      } catch (e) {
        // NotYetAssignableError is the expected, common case (this node isn't the current
        // assignee yet) — not a failure. Anything else is reported via onError rather than
        // thrown, so a single bad/unsubmittable bundle never breaks the gossip event loop.
        opts.onError?.(e);
      }
    })().catch((e) => opts.onError?.(e));
  });

  for (const addr of opts.bootstrapPeers ?? []) {
    await libp2p.dial(multiaddr(addr));
  }

  return {
    libp2p,
    multiaddrs: libp2p.getMultiaddrs().map((a) => a.toString()),
    async publishBundle(bundle: Bundle) {
      await pubsub.publish(BUNDLE_TOPIC, serializeBundle(bundle));
    },
    async stop() {
      await libp2p.stop();
    },
  };
}
