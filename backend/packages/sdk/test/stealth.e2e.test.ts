/**
 * M1 acceptance test: "Send USDG/NVDA to a stealth address; recipient scans
 * and sweeps." Spins up a local anvil devnet, deploys StealthRegistry +
 * StealthAnnouncer + two mock ERC-20s standing in for USDG/NVDA, and runs
 * the full v0 stealth flow end to end.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  SCHEME_ID,
  checkStealthAnnouncement,
  computeStealthPrivateKey,
  decodeViewTagMetadata,
  encodeMetaAddress,
  encodeViewTagMetadata,
  generateStealthAddress,
  generateStealthKeys,
} from "../src/stealth";

const CONTRACTS_OUT = join(import.meta.dir, "../../../contracts/out");
const ANVIL_PORT = 8646;
const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;

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

let anvil: ChildProcess;

async function waitForAnvil(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("anvil did not become ready in time");
}

beforeAll(async () => {
  anvil = spawn("anvil", ["--port", String(ANVIL_PORT), "--silent"], { stdio: "ignore" });
  await waitForAnvil();
});

afterAll(() => {
  anvil?.kill();
});

describe("stealth v0 end-to-end (anvil)", () => {
  it("sends USDG and NVDA to a stealth address; recipient scans and sweeps", async () => {
    const publicClient = createPublicClient({ chain: anvilChain, transport: http() });

    // Anvil unlocks its default dev accounts, so we drive them by address and
    // let anvil sign — no hardcoded private keys to transcribe (and get wrong).
    const [deployerAddr, senderAddr, recipientAddr] = (await publicClient.request({
      method: "eth_accounts",
    } as Parameters<typeof publicClient.request>[0])) as Address[];

    const deployer = deployerAddr!;
    const sender = senderAddr!;
    const recipientMain = recipientAddr!;

    const deployerClient = createWalletClient({ account: deployer, chain: anvilChain, transport: http() });
    const senderClient = createWalletClient({ account: sender, chain: anvilChain, transport: http() });
    const recipientClient = createWalletClient({ account: recipientMain, chain: anvilChain, transport: http() });

    const registryArtifact = loadArtifact("StealthRegistry");
    const announcerArtifact = loadArtifact("StealthAnnouncer");
    const erc20Artifact = loadArtifact("MockERC20");

    async function deploy(artifact: { abi: readonly unknown[]; bytecode: Hex }, args: unknown[] = []): Promise<Address> {
      const hash = await deployerClient.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (!receipt.contractAddress) throw new Error("deployment did not return a contract address");
      return receipt.contractAddress;
    }

    const registryAddress = await deploy(registryArtifact);
    const announcerAddress = await deploy(announcerArtifact);
    const usdgAddress = await deploy(erc20Artifact, ["USD Global", "USDG"]);
    const nvdaAddress = await deploy(erc20Artifact, ["NVDA Stock Token", "NVDA"]);

    // Fund the sender with USDG + NVDA (mock mint, standing in for a real balance).
    await deployerClient.writeContract({
      address: usdgAddress,
      abi: erc20Artifact.abi,
      functionName: "mint",
      args: [sender, parseEther("1000")],
    });
    await deployerClient.writeContract({
      address: nvdaAddress,
      abi: erc20Artifact.abi,
      functionName: "mint",
      args: [sender, parseEther("10")],
    });

    // Recipient generates a stealth meta-address and registers it (ERC-6538).
    const recipientStealthKeys = generateStealthKeys();
    const metaAddress = encodeMetaAddress(recipientStealthKeys);

    const registerHash = await recipientClient.writeContract({
      address: registryAddress,
      abi: registryArtifact.abi,
      functionName: "registerKeys",
      args: [SCHEME_ID, metaAddress],
    });
    await publicClient.waitForTransactionReceipt({ hash: registerHash });

    // Sender resolves the recipient's meta-address from the on-chain registry
    // (not from an out-of-band channel) and derives a fresh stealth address.
    const onChainMeta = (await publicClient.readContract({
      address: registryAddress,
      abi: registryArtifact.abi,
      functionName: "stealthMetaAddressOf",
      args: [recipientMain, SCHEME_ID],
    })) as Hex;
    expect(onChainMeta).toBe(metaAddress);

    const payment = generateStealthAddress(onChainMeta);

    // Sender pays the stealth address in both USDG and NVDA, then announces (ERC-5564).
    await senderClient.writeContract({
      address: usdgAddress,
      abi: erc20Artifact.abi,
      functionName: "transfer",
      args: [payment.stealthAddress, parseEther("100")],
    });
    await senderClient.writeContract({
      address: nvdaAddress,
      abi: erc20Artifact.abi,
      functionName: "transfer",
      args: [payment.stealthAddress, parseEther("1")],
    });

    const announceHash = await senderClient.writeContract({
      address: announcerAddress,
      abi: announcerArtifact.abi,
      functionName: "announce",
      args: [SCHEME_ID, payment.stealthAddress, payment.ephemeralPublicKey, encodeViewTagMetadata(payment.viewTag)],
    });
    await publicClient.waitForTransactionReceipt({ hash: announceHash });

    // Recipient scans every announcement on-chain — the view tag lets it skip
    // the EC math for announcements that aren't addressed to it.
    const logs = await publicClient.getContractEvents({
      address: announcerAddress,
      abi: announcerArtifact.abi,
      eventName: "Announcement",
      fromBlock: 0n,
    });
    expect(logs.length).toBeGreaterThan(0);

    type AnnouncementArgs = { schemeId: bigint; stealthAddress: Address; ephemeralPubKey: Hex; metadata: Hex };
    let matched: { stealthAddress: Address; ephemeralPubKey: Hex } | undefined;

    for (const log of logs) {
      const args = (log as unknown as { args: AnnouncementArgs }).args;
      const scan = checkStealthAnnouncement({
        ephemeralPublicKey: args.ephemeralPubKey,
        viewTag: decodeViewTagMetadata(args.metadata),
        spendingPublicKey: recipientStealthKeys.spendingPublicKey,
        viewingPrivateKey: recipientStealthKeys.viewingPrivateKey,
      });
      if (scan.isMatch) {
        matched = { stealthAddress: scan.stealthAddress!, ephemeralPubKey: args.ephemeralPubKey };
        break;
      }
    }

    expect(matched?.stealthAddress).toBe(payment.stealthAddress);

    // Recipient recovers the one-time private key and confirms it controls the address.
    const stealthPrivateKey = computeStealthPrivateKey({
      ephemeralPublicKey: matched!.ephemeralPubKey,
      spendingPrivateKey: recipientStealthKeys.spendingPrivateKey,
      viewingPrivateKey: recipientStealthKeys.viewingPrivateKey,
    });
    const stealthAccount = privateKeyToAccount(stealthPrivateKey);
    expect(stealthAccount.address).toBe(payment.stealthAddress);

    // Stealth address needs a little ETH to pay gas for the sweep.
    const fundHash = await deployerClient.sendTransaction({ to: payment.stealthAddress, value: parseEther("1") });
    await publicClient.waitForTransactionReceipt({ hash: fundHash });

    const stealthClient = createWalletClient({ account: stealthAccount, chain: anvilChain, transport: http() });
    const sweepUsdgHash = await stealthClient.writeContract({
      address: usdgAddress,
      abi: erc20Artifact.abi,
      functionName: "transfer",
      args: [recipientMain, parseEther("100")],
    });
    await publicClient.waitForTransactionReceipt({ hash: sweepUsdgHash });

    const sweepNvdaHash = await stealthClient.writeContract({
      address: nvdaAddress,
      abi: erc20Artifact.abi,
      functionName: "transfer",
      args: [recipientMain, parseEther("1")],
    });
    await publicClient.waitForTransactionReceipt({ hash: sweepNvdaHash });

    const balanceOf = (token: Address, owner: Address) =>
      publicClient.readContract({ address: token, abi: erc20Artifact.abi, functionName: "balanceOf", args: [owner] }) as Promise<bigint>;

    expect(await balanceOf(usdgAddress, payment.stealthAddress)).toBe(0n);
    expect(await balanceOf(nvdaAddress, payment.stealthAddress)).toBe(0n);
    expect(await balanceOf(usdgAddress, recipientMain)).toBe(parseEther("100"));
    expect(await balanceOf(nvdaAddress, recipientMain)).toBe(parseEther("1"));
  }, 60000);
});
