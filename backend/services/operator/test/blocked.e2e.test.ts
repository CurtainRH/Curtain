/**
 * Recipients the output token refuses don't stall a batch: the zero-transfer probe catches
 * blocklisted recipients, simulation + splitting catches the rest, and everyone else is paid.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migrate, type Db } from "@curtain/db";
import { pgliteDb } from "@curtain/db/pglite";
import { getAddress, parseAbi, parseEther, type Abi, type Address, type Hex } from "viem";
import { CONTRACTS_DIR, startDevnet, type Devnet } from "../../../scripts/devnet";
import { ERC20_ABI, VAULT_ABI } from "../src/abi";
import { createIntent } from "../src/intents";
import { Operator } from "../src/operator";
import { mockQuoter, mockRoute } from "../src/routes";

setDefaultTimeout(180_000);

const RESTRICTED = parseAbi([
  "function mint(address to, uint256 amount)",
  "function setBlocked(address who, bool b)",
  "function setNoReceive(address who, bool b)",
]);
const ADMIN = parseAbi([
  "function setAllowedToken(address token, bool allowed)",
  "function setRate(address tokenIn, address tokenOut, uint256 rateWad)",
  "function mint(address to, uint256 amount)",
]);

const okRecipient = "0x00000000000000000000000000000000000000a1" as Address;
const blocklisted = "0x00000000000000000000000000000000000000b2" as Address;
const cannotReceive = "0x00000000000000000000000000000000000000c3" as Address;

let d: Devnet;
let db: Db;
let op: Operator;
let rst: Address;

const wait = async (hash: Hex) => {
  const r = await d.publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`reverted ${hash}`);
  return r;
};

beforeAll(async () => {
  d = await startDevnet(8691);
  const dep = d.wallets.deployer;
  const art = JSON.parse(readFileSync(join(CONTRACTS_DIR, "out/RestrictedERC20.sol/RestrictedERC20.json"), "utf-8"));
  const hash = await dep.deployContract({ chain: d.chain, account: dep.account!, abi: art.abi as Abi, bytecode: art.bytecode.object as Hex, args: ["Restricted Stock", "RST"] });
  rst = (await wait(hash)).contractAddress!;

  const tx = (address: Address, abi: Abi, functionName: string, args: readonly unknown[]) =>
    dep.writeContract({ chain: d.chain, account: dep.account!, address, abi, functionName, args } as never).then(wait);
  const usdg = d.deployment.tokens["USDG"]!;
  await tx(d.deployment.vault, ADMIN, "setAllowedToken", [rst, true]);
  await tx(d.deployment.router, ADMIN, "setRate", [usdg, rst, parseEther("0.01")]);
  await tx(rst, RESTRICTED, "mint", [d.deployment.router, parseEther("1000")]);
  await tx(rst, RESTRICTED, "setBlocked", [blocklisted, true]);
  await tx(rst, RESTRICTED, "setNoReceive", [cannotReceive, true]);
  await tx(usdg, ADMIN, "mint", [d.wallets.user.account!.address, parseEther("10000")]);

  db = await pgliteDb();
  await migrate(db);
  op = new Operator({
    db, publicClient: d.publicClient, walletClient: d.wallets.operator, chainId: 31337, vault: d.deployment.vault,
    router: d.deployment.router, route: mockRoute, quote: mockQuoter(d.publicClient, d.deployment.router), keeperFeeBps: 5,
    startBlock: await d.publicClient.getBlockNumber(),
  });
});

afterAll(() => d?.stop());

async function intentAndDeposit(recipient: Address) {
  const usdg = d.deployment.tokens["USDG"]!;
  const user = d.wallets.user;
  const now = await d.now();
  const intent = await createIntent(db, {
    tokenIn: usdg, amountIn: parseEther("100"), tokenOut: rst, recipient, depositor: user.account!.address, minOut: parseEther("0.9"), delaySeconds: 0,
  }, new Set([getAddress(usdg), getAddress(rst)]), d.deployment.vault, now);
  await wait(await user.writeContract({ chain: d.chain, account: user.account!, address: usdg, abi: ERC20_ABI, functionName: "approve", args: [d.deployment.vault, parseEther("100")] }));
  await wait(await user.writeContract({ chain: d.chain, account: user.account!, address: d.deployment.vault, abi: VAULT_ABI, functionName: "deposit", args: [usdg, parseEther("100"), intent.deadlineHash] }));
  return intent.id;
}

describe("restricted recipients (e2e)", () => {
  it("settles the good deposit and marks blocked ones, without stalling the batch", async () => {
    const good = await intentAndDeposit(okRecipient);
    const probed = await intentAndDeposit(blocklisted);
    const bisected = await intentAndDeposit(cannotReceive);
    for (let i = 0; i < 20; i++) {
      await op.syncChain();
      const [n] = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM intents WHERE status = 'deposited'");
      if (Number(n!.n) === 3) break;
      await Bun.sleep(100);
    }

    const created = await op.processDue(await d.now());
    expect(created.length).toBe(1);

    const status = async (id: string) => (await db.query<{ status: string; blocked_reason: string | null }>("SELECT status, blocked_reason FROM intents WHERE id = $1", [id]))[0]!;
    expect((await status(good)).status).toBe("settling");
    expect(await status(probed)).toMatchObject({ status: "blocked", blocked_reason: "output token refuses transfers to this recipient" });
    expect((await status(bisected)).status).toBe("blocked");
    expect((await status(bisected)).blocked_reason).toContain("settlement reverts");

    await op.submitSettlements(await d.now());
    await op.syncChain();
    expect((await status(good)).status).toBe("paid");
    expect(await d.publicClient.readContract({ address: rst, abi: ERC20_ABI, functionName: "balanceOf", args: [okRecipient] })).toBeGreaterThan(0n);

    // Blocked deposits aren't retried, so they stay refundable in USDG through the escape hatch.
    expect(await op.processDue(await d.now())).toEqual([]);
  });
});
