/**
 * PpoiNode against a real chain (Anvil + Deploy.s.sol). Providers are added through the 24h
 * timelock that owns ScreeningGate (the production path). Covers: automatic flagging of a
 * listed origin, root publishing, witnesses matching the gate's root set, and stale
 * providers dropping to the empty root. Proving is covered by clear-shield.e2e.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { encodeFunctionData, parseAbi, parseEther, type Address } from "viem";
import { startDevnet, viaTimelock, type Devnet } from "../../../scripts/devnet";
import { GATE_ABI, PpoiNode } from "../src/node";
import { ProviderTree, toBytes32 } from "../src/trees";

setDefaultTimeout(120_000);

const ERC20 = parseAbi(["function mint(address,uint256)", "function approve(address,uint256) returns (bool)"]);
const POOL = parseAbi(["function shield(address token, uint256 rawAmount, uint256 ownerPkX, uint256 blinding, bytes ephemeralPk, bytes ct)"]);
const GATE_ADMIN = parseAbi(["function addProvider(uint8 id, address publisher, bytes32 initialListRoot, bytes32 initialFlagRoot)"]);
const OTHER = "0x00000000000000000000000000000000000000c3" as Address;

let d: Devnet;
let lists: Record<string, string>;
let node: PpoiNode;

beforeAll(async () => {
  d = await startDevnet(8653);
  const user = d.user.account!.address.toLowerCase();
  lists = { "p0": `${user}\n`, "p1": `${OTHER}\n`, "p2": "" };

  node = new PpoiNode({
    publicClient: d.publicClient as never,
    walletClient: d.deployer as never,
    gateAddress: d.addr("ScreeningGate"),
    poolAddress: d.addr("CurtainPool"),
    providers: [{ id: 0, url: "p0" }, { id: 1, url: "p1" }, { id: 2, url: "p2" }],
    publishes: [0, 1, 2],
    wasmPath: "", zkeyPath: "",
    fetchList: async (url) => lists[url]!,
  });
  await node.refreshLists();

  const ops = [...node.trees].map(([id, tree]) => ({
    target: d.addr("ScreeningGate"),
    data: encodeFunctionData({
      abi: GATE_ADMIN, functionName: "addProvider",
      args: [id, d.deployer.account!.address, toBytes32(tree.listRoot), toBytes32(tree.flagRoot)],
    }),
  }));
  await viaTimelock(d, ops, "add-provider");
});

afterAll(() => d?.stop());

describe("PpoiNode (e2e)", () => {
  it("flags a shield whose origin a provider lists, during standby", async () => {
    const usdg = d.deployment.usdg;
    const user = d.user.account!.address;
    const wait = async (h: `0x${string}`) => d.publicClient.waitForTransactionReceipt({ hash: h });
    await wait(await d.deployer.writeContract({ chain: d.chain, account: d.deployer.account!, address: usdg, abi: ERC20, functionName: "mint", args: [user, parseEther("10")] }));
    await wait(await d.user.writeContract({ chain: d.chain, account: d.user.account!, address: usdg, abi: ERC20, functionName: "approve", args: [d.addr("CurtainPool"), parseEther("10")] }));
    const r = await wait(await d.user.writeContract({
      chain: d.chain, account: d.user.account!, address: d.addr("CurtainPool"), abi: POOL, functionName: "shield",
      args: [usdg, parseEther("10"), 1n, 2n, "0x", "0x"],
    }));

    const actions = await node.scanShields(r.blockNumber, r.blockNumber);
    expect(actions.length).toBe(1);
    expect(actions[0]!.providerId).toBe(0);
    const flagged = await d.publicClient.readContract({ address: d.addr("ScreeningGate"), abi: GATE_ABI, functionName: "flagged", args: [actions[0]!.commit] });
    expect(flagged).toBe(true);
  });

  it("serves witnesses against exactly the gate's roots, and refuses listed origins", async () => {
    const { roots, witnesses } = await node.witnessFor(OTHER.replace("c3", "d4") as Address);
    expect(roots.map((x) => toBytes32(x))).toEqual([...node.trees.values()].map((t) => toBytes32(t.listRoot)));
    expect(witnesses.length).toBe(3);
    await expect(node.witnessFor(d.user.account!.address)).rejects.toThrow();
  });

  it("publishes a changed list root, rate-limited to once an hour by the gate", async () => {
    lists["p2"] = `${OTHER}\n`;
    await node.refreshLists();
    await d.testClient.increaseTime({ seconds: 3601 });
    await d.testClient.mine({ blocks: 1 });
    expect(await node.publishRoots()).toEqual([2]);
    const p = await d.publicClient.readContract({ address: d.addr("ScreeningGate"), abi: GATE_ABI, functionName: "providers", args: [2] });
    expect(BigInt(p[0])).toBe((await ProviderTree.build([OTHER])).listRoot);
  });

  it("excludes stale providers: the gate's roots drop to 0 and witnesses use the empty tree", async () => {
    await d.testClient.increaseTime({ seconds: 24 * 3600 + 1 });
    await d.testClient.mine({ blocks: 1 });
    const { roots } = await node.witnessFor(OTHER.replace("c3", "d4") as Address);
    expect(roots).toEqual([0n, 0n, 0n]);
  });
});
