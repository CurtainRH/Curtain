/**
 * M7 acceptance: "3 broadcasters; bundle mined by non-assignee after 10
 * min; slash path test." Spins up anvil, bonds 3 broadcasters against a
 * real BroadcasterBond, computes a bundle's assignee, proves the assignee
 * censoring it (never submitting) blocks everyone else until the 10-minute
 * assignment window elapses, then that a non-assignee successfully mines
 * it afterward, then exercises the on-chain slash path with real EIP-712
 * attestor signatures.
 *
 * The bundle's payload is a plain MockERC20 transfer rather than a real
 * CurtainPool transact()/unshieldToOrigin() call — broadcaster mechanics
 * (assignment, the censorship window, fee checking, submit) are agnostic
 * to what calldata they're relaying, and pool-specific calldata is already
 * exercised end to end elsewhere (M4/M5's e2e tests). `kind: "transact"`
 * below is just a label for this test.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, keccak256,
  parseEther, toBytes, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BroadcasterNode, NotYetAssignableError } from "../src/node";
import { computeAssignee } from "../src/assignment";
import type { Bundle } from "../src/types";

const CONTRACTS_OUT = join(import.meta.dir, "../../../contracts/out");
const ANVIL_PORT = 8651;
const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const ASSIGNMENT_WINDOW_MS = 10 * 60 * 1000;

const anvilChain = defineChain({
  id: 31337,
  name: "anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

function loadArtifact(name: string): { abi: readonly unknown[]; bytecode: Hex } {
  const path = join(CONTRACTS_OUT, `${name}.sol`, `${name}.json`);
  const json = JSON.parse(readFileSync(path, "utf-8"));
  return { abi: json.abi, bytecode: json.bytecode.object as Hex };
}

const erc20Abi = loadArtifact("MockERC20").abi;
const bondAbi = loadArtifact("BroadcasterBond").abi;

const TRANSFER_ABI = [
  { type: "function", name: "transfer", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
] as const;

async function waitForAnvil(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(RPC_URL, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("anvil did not become ready in time");
}

let anvil: ChildProcess;

beforeAll(async () => {
  anvil = spawn("anvil", ["--port", String(ANVIL_PORT), "--silent"], { stdio: "ignore" });
  await waitForAnvil();
});

afterAll(() => {
  anvil?.kill();
});

describe("broadcaster: assignment, censorship fallback, slash (M7 acceptance)", () => {
  it(
    "a non-assignee mines a censored bundle after 10 minutes, then the assignee is slashed",
    async () => {
      const publicClient = createPublicClient({ chain: anvilChain, transport: http() });
      const [deployer, b1, b2, b3, recipient] = (await publicClient.request({
        method: "eth_accounts",
      } as Parameters<typeof publicClient.request>[0])) as Address[];

      const deployerClient = createWalletClient({ account: deployer!, chain: anvilChain, transport: http() });

      async function deploy(artifact: { abi: readonly unknown[]; bytecode: Hex }, args: unknown[] = []): Promise<Address> {
        const hash = await deployerClient.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args });
        const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 10_000 });
        return receipt.contractAddress!;
      }

      const tokenAddr = await deploy(loadArtifact("MockERC20"), ["USD Global", "USDG"]);
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({ address: tokenAddr, abi: erc20Abi, functionName: "mint", args: [deployer!, parseEther("1000")] }),
        timeout: 10_000,
      });

      const bondAddr = await deploy(loadArtifact("BroadcasterBond"), [tokenAddr, deployer, deployer]);

      // ---- bond 3 broadcasters ----
      // Each step below is awaited to a mined receipt before the next one
      // is submitted — bond() reads the allowance approve() just set, and
      // (found while building this test) submitting it before approve()
      // is actually mined doesn't cleanly revert, it leaves the dependent
      // transaction stuck pending indefinitely (a real nonce/state-ordering
      // hazard, not a viem or anvil bug) — see Curtain_Build.md §11.
      const MIN_BOND = parseEther("25000");
      for (const b of [b1!, b2!, b3!]) {
        await publicClient.waitForTransactionReceipt({
          hash: await deployerClient.writeContract({ address: tokenAddr, abi: erc20Abi, functionName: "mint", args: [b, MIN_BOND] }),
          timeout: 10_000,
        });
        const client = createWalletClient({ account: b, chain: anvilChain, transport: http() });
        await publicClient.waitForTransactionReceipt({
          hash: await client.writeContract({ address: tokenAddr, abi: erc20Abi, functionName: "approve", args: [bondAddr, MIN_BOND] }),
          timeout: 10_000,
        });
        const hash = await client.writeContract({ address: bondAddr, abi: bondAbi, functionName: "bond", args: [MIN_BOND] });
        await publicClient.waitForTransactionReceipt({ hash, timeout: 10_000 });
      }
      const bondedSet = (await publicClient.readContract({ address: bondAddr, abi: bondAbi, functionName: "bondedBroadcasters" })) as Address[];
      expect(bondedSet.length).toBe(3);

      // ---- build the bundle and compute its assignee ----
      const transferAmount = parseEther("10");
      const bundle: Bundle = {
        chainId: 31337,
        kind: "transact",
        to: tokenAddr,
        calldata: encodeFunctionData({ abi: TRANSFER_ABI, functionName: "transfer", args: [recipient!, transferAmount] }),
        feeToken: tokenAddr,
        feeAmount: 0n,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        extDataHash: keccak256(toBytes("test-bundle")),
      };
      const assignee = computeAssignee(bundle, bondedSet)!;
      const nonAssignees = bondedSet.filter((a) => a.toLowerCase() !== assignee.toLowerCase());
      expect(nonAssignees.length).toBe(2);
      const nonAssignee = nonAssignees[0]!;

      // Whichever broadcaster actually submits becomes `msg.sender` of the
      // relayed transfer() call, so it needs to hold the tokens itself —
      // fund both candidates since we don't yet know which one will submit.
      for (const b of [assignee, nonAssignee]) {
        await publicClient.waitForTransactionReceipt({
          hash: await deployerClient.writeContract({ address: tokenAddr, abi: erc20Abi, functionName: "mint", args: [b, transferAmount] }),
          timeout: 10_000,
        });
      }

      const makeNode = (address: Address) => {
        const walletClient = createWalletClient({ account: address, chain: anvilChain, transport: http() });
        return new BroadcasterNode(
          { address, feeSchedule: new Map([[tokenAddr, 0n]]), assignmentWindowMs: ASSIGNMENT_WINDOW_MS },
          publicClient, walletClient,
          async () => (await publicClient.readContract({ address: bondAddr, abi: bondAbi, functionName: "bondedBroadcasters" })) as Address[],
        );
      };

      const assigneeNode = makeNode(assignee); // will deliberately never submit — simulates censorship
      const nonAssigneeNode = makeNode(nonAssignee);
      void assigneeNode;

      const assignedAtMs = Date.now();
      await nonAssigneeNode.trackBundle(bundle, assignedAtMs);

      // ---- before the 10-minute window: a non-assignee must not submit ----
      await expect(nonAssigneeNode.submitBundle(bundle, assignedAtMs + 1_000)).rejects.toThrow(NotYetAssignableError);

      const beforeWindow = nonAssigneeNode.detectCensorship(bundle, assignedAtMs + 1_000);
      expect(beforeWindow.censored).toBe(false); // window hasn't elapsed yet, so not "censorship" yet — just not this node's turn

      // ---- after the 10-minute window: the bundle is still unmined, and any broadcaster may submit ----
      const afterWindowMs = assignedAtMs + ASSIGNMENT_WINDOW_MS + 1_000;
      const censorship = nonAssigneeNode.detectCensorship(bundle, afterWindowMs);
      expect(censorship.censored).toBe(true);
      expect(censorship.assignee).toBe(assignee);

      const recipientBalanceBefore = (await publicClient.readContract({ address: tokenAddr, abi: erc20Abi, functionName: "balanceOf", args: [recipient!] })) as bigint;
      const txHash = await nonAssigneeNode.submitBundle(bundle, afterWindowMs);
      expect(txHash).toBeDefined();

      const recipientBalanceAfter = (await publicClient.readContract({ address: tokenAddr, abi: erc20Abi, functionName: "balanceOf", args: [recipient!] })) as bigint;
      expect(recipientBalanceAfter).toBe(recipientBalanceBefore + transferAmount);

      // ---- slash path: 3 governance-appointed attestors sign off on the censorship evidence ----
      const attestorAccounts = [
        privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000001" as Hex),
        privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000002" as Hex),
        privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000003" as Hex),
      ];
      for (const attestor of attestorAccounts) {
        const hash = await deployerClient.writeContract({ address: bondAddr, abi: bondAbi, functionName: "setAttestor", args: [attestor.address, true] });
        await publicClient.waitForTransactionReceipt({ hash, timeout: 10_000 });
      }
      await publicClient.waitForTransactionReceipt({
        timeout: 10_000,
        hash: await deployerClient.writeContract({ address: bondAddr, abi: bondAbi, functionName: "setAttestorThreshold", args: [2n] }),
      });

      const slashAmount = parseEther("5000");
      const evidenceRoot = keccak256(toBytes(`censorship:${assignee}:${bundle.deadline}`));
      const domain = { name: "BroadcasterBond", version: "1.0", chainId: 31337, verifyingContract: bondAddr } as const;
      const types = { SlashAttestation: [
        { name: "broadcaster", type: "address" }, { name: "amount", type: "uint256" }, { name: "evidenceRoot", type: "bytes32" },
      ] } as const;
      const message = { broadcaster: assignee, amount: slashAmount, evidenceRoot };

      const sig1 = await attestorAccounts[0]!.signTypedData({ domain, types, primaryType: "SlashAttestation", message });
      const sig2 = await attestorAccounts[1]!.signTypedData({ domain, types, primaryType: "SlashAttestation", message });

      const treasuryBefore = (await publicClient.readContract({ address: tokenAddr, abi: erc20Abi, functionName: "balanceOf", args: [deployer!] })) as bigint;
      const slashHash = await deployerClient.writeContract({
        address: bondAddr, abi: bondAbi, functionName: "slash",
        args: [assignee, slashAmount, evidenceRoot, [attestorAccounts[0]!.address, attestorAccounts[1]!.address], [sig1, sig2]],
      });
      const slashReceipt = await publicClient.waitForTransactionReceipt({ hash: slashHash, timeout: 10_000 });
      expect(slashReceipt.status).toBe("success");

      const treasuryAfter = (await publicClient.readContract({ address: tokenAddr, abi: erc20Abi, functionName: "balanceOf", args: [deployer!] })) as bigint;
      expect(treasuryAfter).toBe(treasuryBefore + slashAmount);

      const remainingBondedSet = (await publicClient.readContract({ address: bondAddr, abi: bondAbi, functionName: "bondedBroadcasters" })) as Address[];
      expect(remainingBondedSet.map((a) => a.toLowerCase())).not.toContain(assignee.toLowerCase());
    },
    // This test runs ~20 sequential on-chain transactions (bonding 3
    // broadcasters, minting, submitting, setting attestors, slashing) —
    // normally ~45-50s total, uncomfortably close to a 60s bound. Found by
    // instrumenting the test after it started intermittently timing out at
    // exactly 60_000ms with no error: it wasn't hung, just slow, and any
    // small system load variance tipped it over the edge. See
    // Curtain_Build.md §11.
    120_000,
  );
});
