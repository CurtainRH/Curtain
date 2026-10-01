import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { erc20Abi, formatUnits, parseAbi, type Address } from "viem";
import {
  findDepositId,
  positionsOf,
  ROBINHOOD_CHAIN_TOKENS,
  VAULT_ABI,
  STAKING_ABI,
  type StakePosition,
} from "@curtain/sdk";
import {
  address,
  apiUrl,
  chain,
  client,
  decimals,
  errorMessage,
  fallbackVault,
  publicClient,
  readPending,
  readTickets,
  savePending,
  saveTickets,
  trustedVault,
  type PendingSwap,
  stakeToken,
  staking,
  stakingBlock,
  type SavedTicket,
} from "./integration";
export interface TokenData {
  symbol: string;
  name: string;
  logo: string;
  address: Address;
  decimals: number;
  balance?: bigint;
}
export type SwapState = Awaited<ReturnType<ReturnType<typeof client>["status"]>>;
export interface DepositState {
  owner: Address;
  token: Address;
  amount: bigint;
  requestedAt: number;
  status: number;
}
export function useCurtain(wallet: string) {
  const sdk = useMemo(() => client(wallet), [wallet]);
  const [tokens, setTokens] = useState<TokenData[]>([]);
  const [vault, setVault] = useState(fallbackVault);
  const [maxDelay, setMaxDelay] = useState(15552000);
  const [tickets, setTickets] = useState<SavedTicket[]>(() => readTickets(wallet));
  const [statuses, setStatuses] = useState<Record<string, SwapState>>({});
  const [deposits, setDeposits] = useState<Record<string, DepositState>>({});
  const [positionTiers, setPositionTiers] = useState<Record<string, number>>({});
  const tierCache = useRef<Record<string, number>>({});
  const [positions, setPositions] = useState<StakePosition[]>([]);
  const [stakeDecimals, setStakeDecimals] = useState<number>();
  const [rewardDecimals, setRewardDecimals] = useState<number>();
  const [stakeBalance, setStakeBalance] = useState<bigint>();
  const [error, setError] = useState("");
  const [offline, setOffline] = useState(false);
  const [storageWarning, setStorageWarning] = useState("");
  const [now, setNow] = useState(Date.now() / 1000);
  const currentWallet = useRef(wallet);
  currentWallet.current = wallet;
  const due = useRef<Record<string, number>>({});
  useEffect(() => {
    setTickets(readTickets(wallet));
    setStatuses({});
    setDeposits({});
    setPositions([]);
    setPositionTiers({});
    tierCache.current = {};
    setStakeBalance(undefined);
    setTokens([]);
    setStorageWarning("");
    due.current = {};
  }, [wallet]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(timer);
  }, []);
  const refresh = useCallback(async () => {
    try {
      if (!apiUrl) {
        setError("Swaps are not configured. Set the Curtain API address to open this act.");
        return;
      }
      const config = await sdk.config();
      if (currentWallet.current !== wallet) return;
      if (!fallbackVault) throw new Error("The swap vault is not configured.");
      if (!trustedVault(config.vault))
        throw new Error("Curtain's service reported an unexpected vault. Swaps are disabled.");
      setVault(config.vault);
      setMaxDelay(Math.min(15552000, config.maxDelaySeconds));
      const list = await Promise.all(
        ROBINHOOD_CHAIN_TOKENS.map(async (meta) => {
          const token = address(config.tokens[meta.symbol]);
          if (!token) return undefined;
          const d = await decimals(token);
          const balance = address(wallet)
            ? await publicClient.readContract({
                address: token,
                abi: erc20Abi,
                functionName: "balanceOf",
                args: [wallet as Address],
              })
            : undefined;
          return {
            symbol: meta.symbol,
            name: meta.name,
            logo: meta.logo,
            address: token,
            decimals: d,
            ...(balance !== undefined ? { balance } : {}),
          };
        }),
      );
      if (currentWallet.current !== wallet) return;
      setTokens(list.filter((t): t is TokenData => !!t));
      setOffline(false);
      setError("");
    } catch (e) {
      if (currentWallet.current !== wallet) return;
      setOffline(true);
      setTokens([]);
      setError(errorMessage(e));
    }
  }, [sdk, wallet]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30000);
    return () => clearInterval(timer);
  }, [refresh]);
  const refreshStaking = useCallback(async () => {
    if (!staking || !stakeToken || !address(wallet)) return;
    try {
      const [d, balance, reward, list] = await Promise.all([
        decimals(stakeToken),
        publicClient.readContract({
          address: stakeToken,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [wallet as Address],
        }),
        publicClient.readContract({
          address: staking,
          abi: parseAbi(["function rewardToken() view returns (address)"]),
          functionName: "rewardToken",
        }),
        stakingBlock === undefined
          ? Promise.resolve([])
          : positionsOf(publicClient, staking, wallet as Address, stakingBlock),
      ]);
      const rd = address(reward) ? await decimals(reward) : undefined;
      if (currentWallet.current !== wallet) return;
      setStakeDecimals(d);
      setStakeBalance(balance);
      setRewardDecimals(rd);
      setPositions(list);
      if (
        stakingBlock !== undefined &&
        list.some((p) => tierCache.current[p.id.toString()] === undefined)
      ) {
        const events = await publicClient.getContractEvents({
          address: staking,
          abi: STAKING_ABI,
          eventName: "Staked",
          args: { owner: wallet as Address },
          fromBlock: stakingBlock,
        });
        if (currentWallet.current !== wallet) return;
        const tiers: Record<string, number> = {};
        for (const event of events)
          if (event.args.positionId !== undefined && event.args.tier !== undefined)
            tiers[event.args.positionId.toString()] = event.args.tier;
        tierCache.current = tiers;
        setPositionTiers(tiers);
      }
    } catch (e) {
      if (currentWallet.current !== wallet) return;
      setError(errorMessage(e));
    }
  }, [wallet]);
  useEffect(() => {
    void refreshStaking();
    const timer = setInterval(() => void refreshStaking(), 15000);
    return () => clearInterval(timer);
  }, [refreshStaking]);
  const refreshActivity = useCallback(
    async (force = false) => {
      await Promise.all(
        tickets
          .filter((r) => (!r.chainId || r.chainId === chain.id) && trustedVault(r.ticket.vault))
          .map(async (row) => {
            if (!force && (due.current[row.intentId] || 0) > Date.now()) return;
            const known = statuses[row.intentId];
            const terminal = known && ["paid", "refunded", "challenged"].includes(known.status);
            if (terminal && !force) return;
            due.current[row.intentId] =
              Date.now() + (row.delaySeconds && known?.status === "deposited" ? 60000 : 4000);
            await Promise.allSettled([
              (async () => {
                if (row.intentId.startsWith("imported-") || !apiUrl) return;
                try {
                  const value = await sdk.status(row.intentId);
                  if (currentWallet.current === wallet)
                    setStatuses((s) => ({ ...s, [row.intentId]: value }));
                } catch {
                  if (currentWallet.current === wallet) setOffline(true);
                }
              })(),
              (async () => {
                const [owner, token, amount, , requestedAt, status] =
                  await publicClient.readContract({
                    address: row.ticket.vault,
                    abi: VAULT_ABI,
                    functionName: "deposits",
                    args: [BigInt(row.ticket.depositId)],
                  });
                if (currentWallet.current !== wallet) return;
                setDeposits((s) => ({
                  ...s,
                  [row.intentId]: {
                    owner,
                    token,
                    amount,
                    requestedAt: Number(requestedAt),
                    status,
                  },
                }));
              })(),
            ]);
          }),
      );
    },
    [tickets, statuses, sdk, wallet],
  );
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refreshActivity();
      if (active) timer = setTimeout(() => void poll(), 4000);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [refreshActivity]);
  // Pending swaps: promote to full tickets once their deposit shows up on-chain.
  const [pending, setPending] = useState<PendingSwap[]>(() => readPending(wallet));
  useEffect(() => setPending(readPending(wallet)), [wallet]);
  const ticketsRef = useRef(tickets);
  ticketsRef.current = tickets;
  function addPending(row: PendingSwap) {
    const next = [row, ...readPending(wallet).filter((p) => p.intentId !== row.intentId)];
    setPending(next);
    if (!savePending(wallet, next))
      setStorageWarning(
        "Device storage is unavailable. Download your escape ticket as soon as the deposit confirms.",
      );
  }
  function removePending(intentId: string) {
    const next = readPending(wallet).filter((p) => p.intentId !== intentId);
    setPending(next);
    savePending(wallet, next);
  }
  useEffect(() => {
    if (!pending.length || !address(wallet)) return;
    let active = true;
    const check = async () => {
      for (const p of pending) {
        if (!trustedVault(p.pending.vault)) continue;
        try {
          const id = await findDepositId(
            publicClient,
            p.pending,
            wallet as Address,
            BigInt(p.fromBlock),
          );
          if (!active || currentWallet.current !== wallet) return;
          if (id !== undefined) {
            const { pending: t, fromBlock: _from, ...rest } = p;
            addTicket(
              {
                ...rest,
                ticket: {
                  vault: t.vault,
                  depositId: id.toString(),
                  deadline: t.deadline,
                  salt: t.salt,
                },
              },
              ticketsRef.current,
            );
            removePending(p.intentId);
          } else if (Date.now() - Date.parse(p.createdAt) > 7 * 86400000) {
            removePending(p.intentId); // never deposited: nothing to refund
          }
        } catch {
          /* RPC hiccup: try again next round. */
        }
      }
    };
    void check();
    const timer = setInterval(() => void check(), 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, wallet]);
  function addTicket(row: SavedTicket, current = tickets) {
    const next = [
      row,
      ...current.filter(
        (t) =>
          t.ticket.vault.toLowerCase() !== row.ticket.vault.toLowerCase() ||
          t.ticket.depositId !== row.ticket.depositId,
      ),
    ];
    if (currentWallet.current === wallet) setTickets(next);
    if (!saveTickets(wallet, next))
      setStorageWarning(
        "Device storage is unavailable. Download your escape ticket now and keep the file before leaving this page.",
      );
  }
  return {
    sdk,
    tokens,
    vault,
    maxDelay,
    tickets,
    statuses,
    deposits,
    positions,
    positionTiers,
    stakeDecimals,
    rewardDecimals,
    stakeBalance,
    error,
    setError,
    offline,
    storageWarning,
    now,
    addTicket,
    pending,
    addPending,
    removePending,
    refresh,
    refreshStaking,
    refreshActivity,
  };
}
export function balanceText(token: TokenData) {
  return token.balance === undefined ? "—" : formatUnits(token.balance, token.decimals);
}
