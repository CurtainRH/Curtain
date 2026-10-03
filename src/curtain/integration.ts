import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  custom,
  decodeErrorResult,
  defineChain,
  erc20Abi,
  http,
  isAddress,
  parseAbi,
  zeroAddress,
  type Address,
  type EIP1193Provider,
} from "viem";
import { CurtainClient, type EscapeTicket, type PendingTicket } from "@curtain/sdk";
const env = import.meta.env;
export const apiUrl = (env["VITE_CURTAIN_API_URL"] || "/api/curtain").replace(/\/$/, "");
export const chain = defineChain({
  id: Number(env["VITE_CHAIN_ID"] || 4663),
  name: Number(env["VITE_CHAIN_ID"] || 4663) === 4663 ? "Robinhood Chain" : "Curtain local chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [env["VITE_RPC_URL"] || "https://rpc.mainnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: {
      name: "Explorer",
      url: env["VITE_EXPLORER_URL"] || "https://robinhoodchain.blockscout.com",
    },
  },
});
export const publicClient = createPublicClient({ chain, transport: http() });
export function address(value: unknown): Address | undefined {
  return typeof value === "string" && isAddress(value) && value.toLowerCase() !== zeroAddress
    ? value
    : undefined;
}
export const staking = address(env["VITE_STAKING_ADDR"]);
export const stakeToken = address(env["VITE_STAKE_TOKEN_ADDR"]);
export const fallbackVault = address(env["VITE_VAULT_ADDR"]);
export const stakingBlock = /^\d+$/.test(env["VITE_STAKING_FROM_BLOCK"] || "")
  ? BigInt(env["VITE_STAKING_FROM_BLOCK"])
  : undefined;
export function provider() {
  return (window as Window & { ethereum?: EIP1193Provider }).ethereum;
}
export async function ensureChain() {
  const p = provider();
  if (!p) throw new Error("Connect a browser wallet first.");
  if ((await publicClient.getChainId()) !== chain.id)
    throw new Error("The RPC network does not match Curtain’s configured network.");
  const id = `0x${chain.id.toString(16)}`;
  if ((await p.request({ method: "eth_chainId" })) === id) return;
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: id }] });
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e;
    await p.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: id,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: chain.rpcUrls.default.http,
          blockExplorerUrls: [chain.blockExplorers.default.url],
        },
      ],
    });
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: id }] });
  }
}
export function client(wallet?: string) {
  const p = provider();
  return new CurtainClient({
    apiUrl,
    fetch: async (input, init) => {
      try {
        return await fetch(input, { ...init, signal: AbortSignal.timeout(8000) });
      } catch {
        throw new Error(
          "Curtain's service isn't reachable. Your funds are safe; refunds still work from Activity.",
        );
      }
    },
    publicClient,
    // Pinned from the app's own config: the SDK refuses to deposit into, or refund from, any
    // other vault, even if the API (or an imported ticket file) names one.
    ...(fallbackVault ? { vaultAddress: fallbackVault } : {}),
    ...(staking ? { stakingAddress: staking } : {}),
    ...(wallet && p && isAddress(wallet)
      ? { walletClient: createWalletClient({ chain, transport: custom(p), account: wallet }) }
      : {}),
  });
}
const decimalsCache = new Map<string, Promise<number>>();
export function decimals(token: Address) {
  const key = `${chain.id}:${token.toLowerCase()}`;
  let result = decimalsCache.get(key);
  if (!result) {
    result = publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" });
    decimalsCache.set(key, result);
    result.catch(() => decimalsCache.delete(key));
  }
  return result;
}
export const errorAbi = parseAbi([
  "error TokenNotAllowed(address token)",
  "error DepositsArePaused()",
  "error DeadlineHashReused()",
  "error TooEarly(uint256 availableAt)",
  "error WrongDeadline()",
  "error NotDepositor()",
  "error WrongStatus(uint8 status)",
  "error Locked(uint64 unlockAt)",
  "error TokensNotSet()",
]);
export function countdown(seconds: number) {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
}
export function errorMessage(e: unknown): string {
  if (e instanceof BaseError) {
    const rejection = e.walk(
      (x) =>
        !!x &&
        ((x as { code?: number }).code === 4001 ||
          (x as { name?: string }).name === "UserRejectedRequestError"),
    );
    if (
      rejection &&
      ((rejection as { code?: number }).code === 4001 ||
        (rejection as { name?: string }).name === "UserRejectedRequestError")
    )
      return "You cancelled in your wallet. Nothing was sent.";
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const mapped = contractMessage(revert.data?.errorName, revert.data?.args?.[0]);
      if (mapped) return mapped;
    }
    const withData = e.walk((x) => !!x && typeof (x as { data?: unknown }).data === "string");
    const data = (withData as { data?: unknown } | null)?.data;
    if (typeof data === "string") {
      try {
        const decoded = decodeErrorResult({ abi: errorAbi, data: data as `0x${string}` });
        const mapped = contractMessage(decoded.errorName, decoded.args?.[0]);
        if (mapped) return mapped;
      } catch {
        /* Other contract errors use the wallet's message. */
      }
    }
  }
  if ((e as { code?: number })?.code === 4001)
    return "You cancelled in your wallet. Nothing was sent.";
  if (e instanceof TypeError)
    return "Curtain's service isn't reachable. Your funds are safe; refunds still work from Activity.";
  return e instanceof Error ? e.message : "The action could not be completed.";
}
export interface SavedTicket {
  intentId: string;
  ticket: EscapeTicket;
  createdAt: string;
  tokenIn: string;
  amountIn: string;
  tokenOut: string;
  recipient: string;
  depositTx?: string;
  delaySeconds?: number;
  chainId?: number;
}
const storageKey = "curtain-tickets-v1";
export function validTicket(value: unknown): value is EscapeTicket {
  if (!value || typeof value !== "object") return false;
  const t = value as EscapeTicket;
  return (
    !!address(t.vault) &&
    typeof t.depositId === "string" &&
    /^\d+$/.test(t.depositId) &&
    BigInt(t.depositId) < 2n ** 256n &&
    typeof t.deadline === "string" &&
    /^\d+$/.test(t.deadline) &&
    Number.isSafeInteger(Number(t.deadline)) &&
    typeof t.salt === "string" &&
    /^0x[\da-f]{64}$/i.test(t.salt)
  );
}
export function readTickets(wallet: string): SavedTicket[] {
  try {
    const data = JSON.parse(localStorage.getItem(storageKey) || "{}");
    const rows: unknown = data[wallet.toLowerCase()];
    return Array.isArray(rows)
      ? rows.filter(
          (r): r is SavedTicket =>
            !!r &&
            validTicket(r.ticket) &&
            typeof r.intentId === "string" &&
            /^[\da-f]{32}$|^imported-\d+$/i.test(r.intentId) &&
            typeof r.createdAt === "string" &&
            typeof r.tokenIn === "string" &&
            typeof r.tokenOut === "string" &&
            typeof r.amountIn === "string" &&
            typeof r.recipient === "string",
        )
      : [];
  } catch {
    return [];
  }
}
/** True when a ticket belongs to the vault this app is configured for. */
export function trustedVault(vault: string) {
  return !!fallbackVault && vault.toLowerCase() === fallbackVault.toLowerCase();
}
/**
 * A swap whose ticket secrets were saved before the deposit was signed. Once the deposit is
 * found on-chain it becomes a full SavedTicket; until then it cannot be refunded (and if the
 * deposit never happened, nothing is at risk).
 */
export interface PendingSwap extends Omit<SavedTicket, "ticket" | "depositTx"> {
  pending: PendingTicket;
  fromBlock: string;
}
const pendingKey = "curtain-pending-v1";
export function readPending(wallet: string): PendingSwap[] {
  try {
    const rows: unknown = JSON.parse(localStorage.getItem(pendingKey) || "{}")[
      wallet.toLowerCase()
    ];
    return Array.isArray(rows)
      ? rows.filter(
          (r): r is PendingSwap =>
            !!r &&
            typeof r.intentId === "string" &&
            /^\d+$/.test(r.fromBlock) &&
            !!r.pending &&
            !!address(r.pending.vault) &&
            /^\d+$/.test(r.pending.deadline) &&
            /^0x[\da-f]{64}$/i.test(r.pending.salt),
        )
      : [];
  } catch {
    return [];
  }
}
export function savePending(wallet: string, rows: PendingSwap[]) {
  try {
    const data = JSON.parse(localStorage.getItem(pendingKey) || "{}");
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    data[wallet.toLowerCase()] = rows;
    localStorage.setItem(pendingKey, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}
export function saveTickets(wallet: string, rows: SavedTicket[]) {
  try {
    const data = JSON.parse(localStorage.getItem(storageKey) || "{}");
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    data[wallet.toLowerCase()] = rows;
    localStorage.setItem(storageKey, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

function contractMessage(name: string | undefined, arg?: unknown): string | undefined {
  if (name === "TooEarly")
    return `Not yet. Available in ${countdown(Number(arg) - Date.now() / 1000)}.`;
  if (name === "Locked")
    return `Still locked until ${new Date(Number(arg) * 1000).toLocaleString()}.`;
  const messages: Record<string, string> = {
    TokenNotAllowed: "This token isn't supported.",
    DepositsArePaused:
      "New swaps are paused for maintenance. Existing swaps and refunds still work.",
    DeadlineHashReused: "This swap was already deposited. Start a new swap.",
    WrongDeadline: "This ticket doesn't match the deposit.",
    NotDepositor: "Only the wallet that deposited can request this refund.",
    WrongStatus: "The swap may already have finished or been refunded. Refresh Activity.",
    TokensNotSet: "Staking isn't open yet.",
  };
  return name ? messages[name] : undefined;
}
