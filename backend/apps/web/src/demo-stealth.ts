/**
 * M1 interim demo: narrates the full stealth v0 flow ("send USDG/NVDA to a
 * stealth address; recipient scans and sweeps") against a local anvil devnet
 * it spins up itself. Run with `bun run demo:stealth` from apps/web.
 *
 * This is NOT the wallet UI — that's M5's job, once a frontend framework is
 * chosen. This exists so the M1 flow can be watched end to end without
 * reading the automated test, while apps/web doesn't have a UI yet.
 */
import { spawn } from "node:child_process";
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
} from "@curtain/sdk";

const CONTRACTS_OUT = join(import.meta.dir, "../../../contracts/out");
const ANVIL_PORT = 8647;
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

function log(step: string, detail?: unknown) {
  const rendered = detail !== undefined ? ` ${JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}` : "";
  console.log(`\n\x1b[36m▸ ${step}\x1b[0m${rendered}`);
}

async function main() {
  log("Starting local anvil devnet…");
  const anvil = spawn("anvil", ["--port", String(ANVIL_PORT), "--silent"], { stdio: "ignore" });
  process.on("exit", () => anvil.kill());
  await waitForAnvil();

  const publicClient = createPublicClient({ chain: anvilChain, transport: http() });
  const [deployer, sender, recipientMain] = (await publicClient.request({
    method: "eth_accounts",
  } as Parameters<typeof publicClient.request>[0])) as Address[];

  const deployerClient = createWalletClient({ account: deployer!, chain: anvilChain, transport: http() });
  const senderClient = createWalletClient({ account: sender!, chain: anvilChain, transport: http() });
  const recipientClient = createWalletClient({ account: recipientMain!, chain: anvilChain, transport: http() });

  const registryArtifact = loadArtifact("StealthRegistry");
  const announcerArtifact = loadArtifact("StealthAnnouncer");
  const erc20Artifact = loadArtifact("MockERC20");

  async function deploy(artifact: { abi: readonly unknown[]; bytecode: Hex }, args: unknown[] = []): Promise<Address> {
    const hash = await deployerClient.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    return receipt.contractAddress!;
  }

  log("Deploying StealthRegistry, StealthAnnouncer, and mock USDG/NVDA…");
  const registryAddress = await deploy(registryArtifact);
  const announcerAddress = await deploy(announcerArtifact);
  const usdgAddress = await deploy(erc20Artifact, ["USD Global", "USDG"]);
  const nvdaAddress = await deploy(erc20Artifact, ["NVDA Stock Token", "NVDA"]);
  log("Deployed:", { registryAddress, announcerAddress, usdgAddress, nvdaAddress });

  await deployerClient.writeContract({
    address: usdgAddress, abi: erc20Artifact.abi, functionName: "mint", args: [sender!, parseEther("1000")],
  });
  await deployerClient.writeContract({
    address: nvdaAddress, abi: erc20Artifact.abi, functionName: "mint", args: [sender!, parseEther("10")],
  });
  log("Minted 1000 USDG + 10 NVDA to the sender.", { sender });

  log("Recipient generates a stealth meta-address and registers it on-chain (ERC-6538)…");
  const recipientStealthKeys = generateStealthKeys();
  const metaAddress = encodeMetaAddress(recipientStealthKeys);
  const registerHash = await recipientClient.writeContract({
    address: registryAddress, abi: registryArtifact.abi, functionName: "registerKeys", args: [SCHEME_ID, metaAddress],
  });
  await publicClient.waitForTransactionReceipt({ hash: registerHash });
  log("Meta-address registered.", { metaAddress });

  log("Sender resolves the recipient's meta-address from the registry and derives a stealth address…");
  const onChainMeta = (await publicClient.readContract({
    address: registryAddress, abi: registryArtifact.abi, functionName: "stealthMetaAddressOf", args: [recipientMain!, SCHEME_ID],
  })) as Hex;
  const payment = generateStealthAddress(onChainMeta);
  log("Derived one-time stealth address:", payment);

  log("Sender pays the stealth address (100 USDG, 1 NVDA) and announces it (ERC-5564)…");
  await senderClient.writeContract({
    address: usdgAddress, abi: erc20Artifact.abi, functionName: "transfer", args: [payment.stealthAddress, parseEther("100")],
  });
  await senderClient.writeContract({
    address: nvdaAddress, abi: erc20Artifact.abi, functionName: "transfer", args: [payment.stealthAddress, parseEther("1")],
  });
  const announceHash = await senderClient.writeContract({
    address: announcerAddress, abi: announcerArtifact.abi, functionName: "announce",
    args: [SCHEME_ID, payment.stealthAddress, payment.ephemeralPublicKey, encodeViewTagMetadata(payment.viewTag)],
  });
  await publicClient.waitForTransactionReceipt({ hash: announceHash });
  log("Payment sent and announced.");

  log("Recipient scans on-chain announcements for one matching its viewing key…");
  const logs = await publicClient.getContractEvents({
    address: announcerAddress, abi: announcerArtifact.abi, eventName: "Announcement", fromBlock: 0n,
  });
  let matchEphemeralPubKey: Hex | undefined;
  for (const entry of logs) {
    const args = (entry as unknown as { args: { ephemeralPubKey: Hex; metadata: Hex; stealthAddress: Address } }).args;
    const scan = checkStealthAnnouncement({
      ephemeralPublicKey: args.ephemeralPubKey,
      viewTag: decodeViewTagMetadata(args.metadata),
      spendingPublicKey: recipientStealthKeys.spendingPublicKey,
      viewingPrivateKey: recipientStealthKeys.viewingPrivateKey,
    });
    if (scan.isMatch) {
      matchEphemeralPubKey = args.ephemeralPubKey;
      log("Match found!", { stealthAddress: scan.stealthAddress });
      break;
    }
  }
  if (!matchEphemeralPubKey) throw new Error("no matching announcement found — this should not happen");

  log("Recipient recovers the stealth private key and sweeps the funds…");
  const stealthPrivateKey = computeStealthPrivateKey({
    ephemeralPublicKey: matchEphemeralPubKey,
    spendingPrivateKey: recipientStealthKeys.spendingPrivateKey,
    viewingPrivateKey: recipientStealthKeys.viewingPrivateKey,
  });
  const stealthAccount = privateKeyToAccount(stealthPrivateKey);

  const fundHash = await deployerClient.sendTransaction({ to: payment.stealthAddress, value: parseEther("1") });
  await publicClient.waitForTransactionReceipt({ hash: fundHash });

  const stealthClient = createWalletClient({ account: stealthAccount, chain: anvilChain, transport: http() });
  const sweepUsdgHash = await stealthClient.writeContract({
    address: usdgAddress, abi: erc20Artifact.abi, functionName: "transfer", args: [recipientMain!, parseEther("100")],
  });
  await publicClient.waitForTransactionReceipt({ hash: sweepUsdgHash });
  const sweepNvdaHash = await stealthClient.writeContract({
    address: nvdaAddress, abi: erc20Artifact.abi, functionName: "transfer", args: [recipientMain!, parseEther("1")],
  });
  await publicClient.waitForTransactionReceipt({ hash: sweepNvdaHash });

  const balanceOf = (token: Address, owner: Address) =>
    publicClient.readContract({ address: token, abi: erc20Artifact.abi, functionName: "balanceOf", args: [owner] }) as Promise<bigint>;

  log("Final balances:", {
    stealthAddress_usdg: await balanceOf(usdgAddress, payment.stealthAddress),
    stealthAddress_nvda: await balanceOf(nvdaAddress, payment.stealthAddress),
    recipientMain_usdg: await balanceOf(usdgAddress, recipientMain!),
    recipientMain_nvda: await balanceOf(nvdaAddress, recipientMain!),
  });

  console.log("\n\x1b[32m✓ Done — swept successfully.\x1b[0m\n");
  anvil.kill();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
