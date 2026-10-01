import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  ArrowUpRight,
  Coins,
  ChevronRight,
  Download,
  Info,
  LayoutDashboard,
  Menu,
  RefreshCw,
  Repeat2,
  Wallet,
} from "lucide-react";
import { formatUnits, isAddress, parseUnits, type Address } from "viem";
import {
  CHALLENGE_WINDOW_SECONDS,
  ROBINHOOD_CHAIN_TOKENS,
  TIERS,
  VAULT_ABI,
  type SwapQuote,
} from "@curtain/sdk";
import { Logo, RouteLink, Socials, useNav } from "./App";
import { downloadFile } from "./domain";
import { useWorkspaceTools } from "./useWorkspaceTools";
import {
  address,
  apiUrl,
  chain,
  countdown,
  ensureChain,
  errorMessage,
  publicClient,
  provider,
  stakeToken,
  staking,
  stakingBlock,
  trustedVault,
  validTicket,
  type SavedTicket,
} from "./integration";
import { balanceText, useCurtain, type TokenData } from "./useCurtain";
const nav = [
  { id: "overview", path: "/app", name: "Overview", icon: LayoutDashboard },
  { id: "swap", path: "/app/swap", name: "Swap", icon: Repeat2 },
  { id: "stake", path: "/app/stake", name: "Stake", icon: Coins },
  { id: "activity", path: "/app/activity", name: "Activity", icon: Activity },
];
function Note({ children }: { children: ReactNode }) {
  return (
    <div className="notice">
      <Info size={16} />
      <p>{children}</p>
    </div>
  );
}
function Token({ token }: { token: TokenData }) {
  return (
    <span className="token-icon">
      <img src={token.logo} alt={token.symbol} width={34} height={34} />
    </span>
  );
}
function rawAmount(value: string, d: number) {
  if (
    !new RegExp(`^(?:0|[1-9]\\d*)(?:\\.\\d{1,${Math.max(1, d)}})?$`).test(value) ||
    (d === 0 && value.includes("."))
  )
    throw new Error(`Enter an amount with up to ${d} decimal places.`);
  const raw = parseUnits(value, d);
  if (raw <= 0n || raw >= 2n ** 256n)
    throw new Error("Enter an amount greater than zero and within the supported range.");
  return raw;
}
const statusCopy = {
  awaiting_deposit: "Waiting for your deposit",
  deposited: "Swapping…",
  settling: "Delivering…",
  paid: "Delivered",
  blocked: "This token can't be sent to that recipient.",
  expired: "Deposit didn't match this swap.",
  refund_requested: "Refund in progress",
  refunded: "Refunded to your wallet",
  challenged: "This swap was already delivered; the refund was declined.",
};
export default function Dashboard({ path }: { path: string }) {
  const { wallet, connect, navigate } = useNav();
  const app = useCurtain(wallet);
  const current = nav.find((n) => n.id === (path.split("/")[2] || "overview")) || nav[0]!;
  useWorkspaceTools(current.id, navigate);
  const [sideOpen, setSideOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [from, setFrom] = useState("USDG");
  const [to, setTo] = useState("NVDA");
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState(wallet);
  const [delayed, setDelayed] = useState(false);
  const [delay, setDelay] = useState("3600");
  const [customDelay, setCustomDelay] = useState("3600");
  const [slippage, setSlippage] = useState(100);
  const [quote, setQuote] = useState<SwapQuote>();
  const [quoteError, setQuoteError] = useState("");
  const [quoting, setQuoting] = useState(false);
  const [latest, setLatest] = useState<SavedTicket>();
  const [stakeAmount, setStakeAmount] = useState("");
  const [tier, setTier] = useState<0 | 1 | 2>(0);
  const importRef = useRef<HTMLInputElement>(null);
  const requestNumber = useRef(0);
  const input = app.tokens.find((t) => t.symbol === from);
  const output = app.tokens.find((t) => t.symbol === to);
  const delaySeconds = delayed ? Number(delay === "custom" ? customDelay : delay) : 0;
  useEffect(() => {
    setRecipient(wallet);
    setLatest(undefined);
    setMessage("");
  }, [wallet]);
  useEffect(() => {
    setSideOpen(false);
    setMessage("");
  }, [path]);
  useEffect(() => {
    let alive = true;
    setQuote(undefined);
    setQuoteError("");
    const load = async () => {
      const number = ++requestNumber.current;
      if (!input || !output || !amount || !apiUrl || current.id !== "swap") {
        setQuoting(false);
        return;
      }
      setQuoting(true);
      try {
        const q = await app.sdk.quote(
          input.address,
          output.address,
          rawAmount(amount, input.decimals),
          slippage,
        );
        if (alive && number === requestNumber.current) {
          setQuote(q);
          setQuoteError("");
        }
      } catch (e) {
        if (alive && number === requestNumber.current) {
          setQuote(undefined);
          setQuoteError(errorMessage(e));
        }
      } finally {
        if (alive && number === requestNumber.current) setQuoting(false);
      }
    };
    const first = setTimeout(() => void load(), 400);
    const timer = setInterval(() => void load(), 15000);
    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [input, output, amount, slippage, current.id, app.sdk]);
  function link(hash: string, label: string) {
    return (
      <a
        href={`${chain.blockExplorers.default.url}/tx/${hash}`}
        target="_blank"
        rel="noreferrer"
        className="underlined-link"
      >
        {label}
        <ArrowUpRight size={13} />
      </a>
    );
  }
  async function run(label: string, action: () => Promise<void>) {
    if (busy) return;
    setBusy(label);
    setMessage("");
    app.setError("");
    try {
      await ensureChain();
      const accounts = await provider()?.request({ method: "eth_accounts" });
      if (accounts?.[0]?.toLowerCase() !== wallet.toLowerCase())
        throw new Error("Your wallet account changed. Reconnect before continuing.");
      await action();
    } catch (e) {
      setMessage(errorMessage(e));
      await app.refreshActivity(true);
    } finally {
      setBusy("");
    }
  }
  function download(row: SavedTicket) {
    downloadFile(`curtain-escape-ticket-${row.ticket.depositId}.json`, {
      ...row,
      chainId: row.chainId || chain.id,
    });
  }
  async function swap() {
    if (!input || !output || !app.vault || !quote?.available || quoting) return;
    if (
      !isAddress(recipient) ||
      !address(recipient) ||
      recipient.toLowerCase() === app.vault.toLowerCase()
    ) {
      setMessage("Enter a recipient address other than the zero address or vault.");
      return;
    }
    if (
      !Number.isInteger(delaySeconds) ||
      (delayed ? delaySeconds < 1 : delaySeconds < 0) ||
      delaySeconds > app.maxDelay
    ) {
      setMessage(`Choose a delay between 0 and ${app.maxDelay} seconds.`);
      return;
    }
    await run("Swap", async () => {
      const raw = rawAmount(amount, input.decimals);
      if (input.balance === undefined || raw > input.balance)
        throw new Error("Your token balance is too low for this swap.");
      // Refresh immediately before signing so minimum output matches the current form.
      const fresh = await app.sdk.quote(input.address, output.address, raw, slippage);
      setQuote(fresh);
      if (!fresh.available) throw new Error("No liquidity for this pair right now");
      const fromBlock = await publicClient.getBlockNumber();
      const details = {
        createdAt: new Date().toISOString(),
        tokenIn: from,
        amountIn: formatUnits(raw, input.decimals),
        tokenOut: to,
        recipient,
        delaySeconds,
        chainId: chain.id,
      };
      let pendingId = "";
      const result = await app.sdk
        .swap(
          {
            tokenIn: input.address,
            amountIn: raw,
            tokenOut: output.address,
            recipient: recipient as Address,
            minOut: BigInt(fresh.minOutSuggested),
            delaySeconds,
          },
          {
            // Keep the ticket secrets before the wallet signs, so closing the tab mid-deposit
            // can't strand funds without a refund path.
            onIntent: (pending) => {
              pendingId = pending.intentId;
              app.addPending({
                ...details,
                intentId: pending.intentId,
                pending,
                fromBlock: fromBlock.toString(),
              });
            },
          },
        )
        .catch((e: unknown) => {
          // A wallet cancellation means no deposit was sent, so there is nothing to recover.
          if (pendingId && errorMessage(e).startsWith("You cancelled"))
            app.removePending(pendingId);
          throw e;
        });
      const row: SavedTicket = {
        ...details,
        intentId: result.intentId,
        ticket: result.ticket,
        depositTx: result.depositTx,
      };
      app.addTicket(row);
      app.removePending(result.intentId);
      setLatest(row);
      setAmount("");
      setMessage("Deposit confirmed. Save your escape ticket.");
      void app.refresh();
    });
  }
  async function importTicket(file: File) {
    try {
      if (!address(wallet))
        throw new Error("Connect the depositing wallet before importing a ticket.");
      if (file.size > 100000) throw new Error("This ticket file is too large.");
      const data: unknown = JSON.parse(await file.text());
      const source = data as Partial<SavedTicket>;
      const ticket = validTicket(data) ? data : source.ticket;
      if (!validTicket(ticket)) throw new Error("This file is not a valid Curtain escape ticket.");
      if (!trustedVault(ticket.vault))
        throw new Error(
          "This ticket is for a different vault than Curtain's. It was not imported.",
        );
      if (source.chainId !== undefined && source.chainId !== chain.id)
        throw new Error("This ticket belongs to a different network.");
      const [owner, token, raw] = await publicClient.readContract({
        address: ticket.vault,
        abi: VAULT_ABI,
        functionName: "deposits",
        args: [BigInt(ticket.depositId)],
      });
      if (owner.toLowerCase() !== wallet.toLowerCase())
        throw new Error("Only the wallet that deposited can import this refund ticket.");
      const { decimals } = await import("./integration");
      const d = await decimals(token);
      const symbol =
        app.tokens.find((t) => t.address.toLowerCase() === token.toLowerCase())?.symbol ||
        `${token.slice(0, 6)}…${token.slice(-4)}`;
      app.addTicket({
        intentId:
          typeof source.intentId === "string" && /^[\da-f]{32}$/i.test(source.intentId)
            ? source.intentId
            : `imported-${ticket.depositId}`,
        ticket,
        createdAt:
          typeof source.createdAt === "string" && !Number.isNaN(Date.parse(source.createdAt))
            ? source.createdAt
            : new Date().toISOString(),
        tokenIn: symbol,
        amountIn: formatUnits(raw, d),
        tokenOut: typeof source.tokenOut === "string" ? source.tokenOut : "Recipient token",
        recipient: typeof source.recipient === "string" ? source.recipient : "—",
        chainId: chain.id,
        ...(typeof source.depositTx === "string" && /^0x[\da-f]{64}$/i.test(source.depositTx)
          ? { depositTx: source.depositTx }
          : {}),
        ...(typeof source.delaySeconds === "number" ? { delaySeconds: source.delaySeconds } : {}),
      });
      setMessage("Ticket imported. Refunds use the vault directly.");
    } catch (e) {
      setMessage(errorMessage(e));
    }
  }
  async function refund(row: SavedTicket, finish: boolean) {
    await run(finish ? "Finish refund" : "Refund", async () => {
      const hash = finish
        ? await app.sdk.finalizeRefund(row.ticket)
        : await app.sdk.requestRefund(row.ticket);
      setMessage(`Refund transaction confirmed: ${hash}`);
      await app.refreshActivity(true);
    });
  }
  function rows(onlyOpen = false) {
    const list = app.tickets.filter(
      (r) =>
        !onlyOpen ||
        (!["paid", "refunded", "challenged"].includes(app.statuses[r.intentId]?.status || "") &&
          ![3, 4].includes(app.deposits[r.intentId]?.status || 0)),
    );
    return list.length || app.pending.length ? (
      <div className="v2-activity">
        {app.pending.map((p) => (
          <article className="v2-activity-row" key={`pending-${p.intentId}`}>
            <div>
              <small>{new Date(p.createdAt).toLocaleString()}</small>
              <strong className="v2-swap-pair">
                {p.amountIn} {p.tokenIn} → {p.tokenOut}
              </strong>
              <span className="pill">Waiting for deposit</span>
              <p>Your escape ticket appears here as soon as the deposit confirms.</p>
            </div>
          </article>
        ))}
        {list.map((row) => {
          const status = app.statuses[row.intentId];
          const deposit = app.deposits[row.intentId];
          const foreignVault = !trustedVault(row.ticket.vault);
          const wrongChain =
            (row.chainId !== undefined && row.chainId !== chain.id) || foreignVault;
          const requested = deposit?.status === 2;
          const terminal =
            deposit?.status === 3 ||
            deposit?.status === 4 ||
            ["paid", "refunded", "challenged"].includes(status?.status || "");
          const text =
            deposit?.status === 4
              ? statusCopy.refunded
              : deposit?.status === 3
                ? statusCopy.challenged
                : requested
                  ? statusCopy.refund_requested
                  : status
                    ? status.status === "deposited" && row.delaySeconds
                      ? "Scheduled (private delay)"
                      : statusCopy[status.status]
                    : "Service unavailable — ticket ready";
          const remaining = (deposit?.requestedAt || 0) + CHALLENGE_WINDOW_SECONDS + 1 - app.now;
          return (
            <article
              className="v2-activity-row"
              key={`${row.ticket.vault}-${row.ticket.depositId}`}
            >
              <div>
                <small>{new Date(row.createdAt).toLocaleString()}</small>
                <strong className="v2-swap-pair">
                  {ROBINHOOD_CHAIN_TOKENS.find((t) => t.symbol === row.tokenIn)?.logo && (
                    <img
                      src={ROBINHOOD_CHAIN_TOKENS.find((t) => t.symbol === row.tokenIn)!.logo}
                      alt=""
                      width={24}
                      height={24}
                    />
                  )}{" "}
                  {row.amountIn} {row.tokenIn} →{" "}
                  {ROBINHOOD_CHAIN_TOKENS.find((t) => t.symbol === row.tokenOut)?.logo && (
                    <img
                      src={ROBINHOOD_CHAIN_TOKENS.find((t) => t.symbol === row.tokenOut)!.logo}
                      alt=""
                      width={24}
                      height={24}
                    />
                  )}{" "}
                  {row.tokenOut}
                </strong>
                <span>
                  Recipient{" "}
                  {row.recipient.length > 16
                    ? `${row.recipient.slice(0, 6)}…${row.recipient.slice(-4)}`
                    : row.recipient}
                </span>
                <span className="pill">{text}</span>
                {status?.blockedReason && <p>{status.blockedReason}</p>}
                {wrongChain && (
                  <p>
                    {foreignVault
                      ? "This ticket is for a different vault than this app uses."
                      : `Switch configuration to network ${row.chainId} to use this ticket.`}
                  </p>
                )}
              </div>
              <div className="v2-actions">
                <button onClick={() => download(row)} className="text-button">
                  <Download size={14} />
                  Ticket
                </button>
                {row.depositTx && link(row.depositTx, "Deposit")}
                {status?.payoutTx && link(status.payoutTx, "Payout")}
                {!terminal &&
                  !wrongChain &&
                  (requested ? (
                    <>
                      <small>
                        {remaining > 0
                          ? `Finish refund in ${countdown(remaining)}`
                          : "Challenge window complete"}
                      </small>
                      <button
                        className="button gold"
                        disabled={!!busy || remaining > 0}
                        onClick={() => void refund(row, true)}
                      >
                        Finish refund
                      </button>
                    </>
                  ) : (
                    <>
                      <small>
                        {app.now < app.sdk.refundAvailableAt(row.ticket)
                          ? `Refund available in ${countdown(app.sdk.refundAvailableAt(row.ticket) - app.now)}`
                          : "Refund available"}
                      </small>
                      {app.now >= app.sdk.refundAvailableAt(row.ticket) && (
                        <button
                          className="button gold"
                          disabled={!!busy}
                          onClick={() => void refund(row, false)}
                        >
                          Get my deposit back
                        </button>
                      )}
                    </>
                  ))}
              </div>
            </article>
          );
        })}
      </div>
    ) : (
      <div className="empty-compact">
        <h3>Your next act awaits.</h3>
        <p>No {onlyOpen ? "open swaps" : "saved tickets"} for this wallet.</p>
      </div>
    );
  }
  function picker(id: string, value: string, set: (v: string) => void) {
    const token = app.tokens.find((t) => t.symbol === value);
    return (
      <div className="asset-input">
        {token && <Token token={token} />}
        <select id={id} value={value} onChange={(e) => set(e.target.value)}>
          {app.tokens.map((t) => (
            <option key={t.symbol} value={t.symbol}>
              {t.symbol} · {balanceText(t)}
            </option>
          ))}
        </select>
      </div>
    );
  }
  function positionTable() {
    return (
      <section className="panel">
        <div className="panel-heading">
          <h2>Your positions</h2>
          <span title="After unlocking, a position earns at 1×. Withdraw and restake to earn a multiplier again.">
            <Info size={16} />
          </span>
        </div>
        {app.positions.length ? (
          <div className="v2-table-scroll">
            <table className="v2-position-table">
              <thead>
                <tr>
                  <th>Amount</th>
                  <th>Tier</th>
                  <th>Unlock</th>
                  <th>Rewards</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {app.positions.map((p) => (
                  <tr key={p.id.toString()}>
                    <td>
                      {app.stakeDecimals === undefined
                        ? "—"
                        : formatUnits(p.amount, app.stakeDecimals)}{" "}
                      CRTN
                    </td>
                    <td>
                      {TIERS.find((t) => t.tier === app.positionTiers[p.id.toString()])
                        ? `${TIERS[app.positionTiers[p.id.toString()]!]!.days}d · ${TIERS[app.positionTiers[p.id.toString()]!]!.multiplier}×`
                        : "Loading tier…"}
                    </td>
                    <td>
                      {new Date(p.unlockAt * 1000).toLocaleString()}
                      <small>
                        {p.closed
                          ? "Closed"
                          : p.unlockAt > app.now
                            ? countdown(p.unlockAt - app.now)
                            : "Unlocked · earns at 1×"}
                      </small>
                    </td>
                    <td>
                      {app.rewardDecimals === undefined
                        ? "—"
                        : formatUnits(p.earned, app.rewardDecimals)}
                    </td>
                    <td>
                      <button
                        className="text-button"
                        disabled={!!busy || p.closed || p.earned === 0n}
                        onClick={() =>
                          void run("Claim", async () => {
                            await app.sdk.claim(p.id);
                            await app.refreshStaking();
                            setMessage("Rewards claimed.");
                          })
                        }
                      >
                        Claim
                      </button>
                      <button
                        className="text-button"
                        disabled={!!busy || p.closed || p.unlockAt > app.now}
                        onClick={() =>
                          void run("Withdraw", async () => {
                            await app.sdk.withdraw(p.id);
                            await app.refreshStaking();
                            setMessage("Position withdrawn.");
                          })
                        }
                      >
                        Withdraw
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-compact">
            <p>
              {stakingBlock === undefined
                ? "Position history is not configured. Set the staking deployment block."
                : "No positions for this wallet."}
            </p>
          </div>
        )}
      </section>
    );
  }
  return (
    <main id="main" className="app-layout">
      <aside className={`sidebar ${sideOpen ? "expanded" : ""}`}>
        <div className="sidebar-caption">
          <span className="eyebrow">YOUR PRIVATE BOX</span>
          <span className="box-no">Nº 01</span>
        </div>
        <nav aria-label="Application navigation">
          {nav.map((n) => (
            <RouteLink
              key={n.id}
              to={n.path}
              className={`side-link ${n.id === current.id ? "selected" : ""}`}
            >
              <n.icon size={18} />
              {n.name}
            </RouteLink>
          ))}
          <span className="side-link">Lending — coming soon</span>
        </nav>
        <div className="sidebar-bottom">
          <div className="side-motto">
            <Logo compact />
            <p>
              The position is yours.
              <br />
              <em>So is the privacy.</em>
            </p>
          </div>
          <Socials />
          <div className="side-legal">
            <RouteLink to="/legal/terms">Terms</RouteLink>
            <RouteLink to="/legal/privacy">Privacy</RouteLink>
            <RouteLink to="/legal/risk">Risks</RouteLink>
          </div>
          <RouteLink to="/" className="return-link">
            Back to the overture <ArrowUpRight size={13} />
          </RouteLink>
        </div>
      </aside>
      <div className="app-content">
        <div className="app-topline">
          <button
            className="mobile-sidebar"
            aria-label="Toggle application navigation"
            aria-expanded={sideOpen}
            onClick={() => setSideOpen((v) => !v)}
          >
            <Menu size={18} />
          </button>
          <span className="breadcrumbs">
            PRIVATE BOX <ChevronRight size={12} />
            {current.name}
          </span>
          <button className="wallet-button" onClick={connect}>
            <Wallet size={16} />
            {wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "Connect wallet"}
          </button>
        </div>
        <div className="dashboard-body">
          <div className="dashboard-heading">
            <div>
              <p className="eyebrow">DRAW THE CURTAIN</p>
              <h1>{current.name}</h1>
              <p>Private swaps. Considered timing. Rewards for your next act.</p>
            </div>
            <button
              className="text-button"
              disabled={!!busy}
              onClick={() => {
                void app.refresh();
                void app.refreshActivity(true);
                void app.refreshStaking();
              }}
            >
              <RefreshCw size={16} />
              Refresh
            </button>
          </div>
          {!wallet && <Note>Connect your wallet to see balances, swaps and rewards.</Note>}
          {app.error && (
            <p role="alert" className="form-error">
              {app.error}
            </p>
          )}
          {app.offline && (
            <Note>
              Curtain's service isn't reachable. Your funds are safe; refunds still work from
              Activity.
            </Note>
          )}
          {app.storageWarning && (
            <p role="alert" className="form-error">
              {app.storageWarning}
            </p>
          )}
          {message && (
            <p role="status" className="notice">
              {message}
            </p>
          )}
          {busy && (
            <p role="status" className="notice">
              {busy} in progress. Your wallet may ask for approval and then a transaction.
            </p>
          )}
          {current.id === "overview" && (
            <>
              <div className="overview-grid">
                <section className="panel">
                  <div className="panel-heading">
                    <h2>Your balances</h2>
                    <span className="pill">Raw token units</span>
                  </div>
                  <div className="asset-table">
                    {app.tokens.map((t) => (
                      <div className="asset-row" key={t.symbol}>
                        <div>
                          <Token token={t} />
                          <span>
                            <strong>{t.symbol}</strong>
                            <small>{t.name}</small>
                          </span>
                        </div>
                        <span>{balanceText(t)}</span>
                        <RouteLink to="/app/swap">
                          Swap <ArrowUpRight size={14} />
                        </RouteLink>
                      </div>
                    ))}
                    {!app.tokens.length && (
                      <p className="empty-compact">
                        Token balances are waiting for network configuration.
                      </p>
                    )}
                  </div>
                </section>
                <section className="panel next-act">
                  <p className="eyebrow">THE NEXT ACT</p>
                  <h2>On your terms.</h2>
                  <RouteLink to="/app/swap">
                    Swap privately <ArrowUpRight size={16} />
                  </RouteLink>
                  <RouteLink to="/app/stake">
                    Earn up to 2× rewards <ArrowUpRight size={16} />
                  </RouteLink>
                  <p>Lending coming soon.</p>
                </section>
              </div>
              <section className="panel v2-section">
                <div className="panel-heading">
                  <h2>Open swaps</h2>
                </div>
                {rows(true)}
              </section>
              <div className="v2-section">
                {stakeToken ? positionTable() : <Note>Staking opens when $CRTN launches.</Note>}
              </div>
            </>
          )}
          {current.id === "swap" && (
            <div className="workspace-grid">
              <section className="panel form-panel">
                <div className="panel-heading">
                  <h2>Swap privately</h2>
                </div>
                <label className="field-label" htmlFor="swap-from">
                  From
                </label>
                {picker("swap-from", from, setFrom)}
                <label className="field-label" htmlFor="swap-amount">
                  Amount
                </label>
                <div className="amount-input">
                  <input
                    id="swap-amount"
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0"
                  />
                  <button
                    className="text-button"
                    disabled={input?.balance === undefined}
                    onClick={() =>
                      input &&
                      input.balance !== undefined &&
                      setAmount(formatUnits(input.balance, input.decimals))
                    }
                  >
                    Max
                  </button>
                </div>
                <label className="field-label" htmlFor="swap-to">
                  To
                </label>
                {picker("swap-to", to, setTo)}
                <label className="field-label" htmlFor="swap-recipient">
                  Recipient
                </label>
                <input
                  id="swap-recipient"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder="0x…"
                />
                <button className="text-button" onClick={() => setRecipient(wallet)}>
                  Use my wallet
                </button>
                <span className="field-help">
                  Sending to a fresh address gives you the most privacy.
                </span>
                <p className="field-label">Timing</p>
                <div className="segmented">
                  {[false, true].map((v) => (
                    <button
                      key={String(v)}
                      aria-pressed={delayed === v}
                      onClick={() => setDelayed(v)}
                    >
                      {v ? "Private delay" : "Instant"}
                    </button>
                  ))}
                </div>
                {delayed && (
                  <>
                    <label className="field-label" htmlFor="swap-delay">
                      Delay window
                    </label>
                    <select
                      id="swap-delay"
                      value={delay}
                      onChange={(e) => setDelay(e.target.value)}
                    >
                      {[
                        [3600, "1 hour"],
                        [21600, "6 hours"],
                        [86400, "1 day"],
                        [604800, "7 days"],
                        [2592000, "30 days"],
                        [15552000, "180 days"],
                      ].map(([s, label]) => (
                        <option key={s} value={s} disabled={Number(s) > app.maxDelay}>
                          {label}
                        </option>
                      ))}
                      <option value="custom">Custom</option>
                    </select>
                    {delay === "custom" && (
                      <>
                        <label className="field-label" htmlFor="custom-delay">
                          Window in seconds (maximum {app.maxDelay})
                        </label>
                        <input
                          id="custom-delay"
                          type="number"
                          min={1}
                          max={app.maxDelay}
                          value={customDelay}
                          onChange={(e) => setCustomDelay(e.target.value)}
                        />
                      </>
                    )}
                    <span className="field-help">
                      Curtain pays out at a random time inside this window. Longer windows are more
                      private.
                    </span>
                  </>
                )}
                <label className="field-label" htmlFor="slippage">
                  Slippage
                </label>
                <select
                  id="slippage"
                  value={slippage}
                  onChange={(e) => setSlippage(Number(e.target.value))}
                >
                  {[50, 100, 200].map((bps) => (
                    <option key={bps} value={bps}>
                      {bps / 100}%
                    </option>
                  ))}
                </select>
                <div className="fee-breakdown" aria-live="polite">
                  {quoting && <p>Updating quote…</p>}
                  {quote && output && (
                    <>
                      <div>
                        <span>You receive ≈</span>
                        <strong>
                          {formatUnits(BigInt(quote.expectedOut), output.decimals)} {to}
                        </strong>
                      </div>
                      <div>
                        <span>Minimum</span>
                        <span>
                          {formatUnits(BigInt(quote.minOutSuggested), output.decimals)} {to}
                        </span>
                      </div>
                      <div>
                        <span>Route</span>
                        <span>{quote.venue}</span>
                      </div>
                      <div>
                        <span>Protocol fee</span>
                        <span>0.20%</span>
                      </div>
                      <div>
                        <span>Keeper fee</span>
                        <span>0.05%</span>
                      </div>
                      {!quote.available && <p>No liquidity for this pair right now</p>}
                    </>
                  )}
                  {quoteError && (
                    <p role="alert" className="form-error">
                      {quoteError}
                    </p>
                  )}
                </div>
                <button
                  className="button gold v2-primary"
                  disabled={
                    !!busy || !wallet || !app.vault || !quote?.available || quoting || app.offline
                  }
                  onClick={() => void swap()}
                >
                  Swap privately <ArrowUpRight size={16} />
                </button>
              </section>
              <div>
                <Note>
                  Your deposit shows your wallet, token and amount. Longer delays and fresh
                  recipient addresses give more privacy.
                </Note>
                <Note>
                  If the price falls below your minimum, the swap waits for a better price. After
                  the deadline, use your escape ticket to refund.
                </Note>
                {latest && (
                  <section className="panel form-panel v2-section">
                    <h2>Your escape ticket</h2>
                    <p>
                      Keep this file. If Curtain is ever unavailable, it lets you take your deposit
                      back.
                    </p>
                    <button className="button gold" onClick={() => download(latest)}>
                      <Download size={16} />
                      Download escape ticket
                    </button>
                    <p className="field-help">This file is private. Store it somewhere safe.</p>
                    {link(latest.depositTx!, "Deposit transaction")}
                    {rows()}
                  </section>
                )}
              </div>
            </div>
          )}
          {current.id === "stake" &&
            (!stakeToken ? (
              <section className="panel empty-compact">
                <h3>The next act awaits.</h3>
                <p>Staking opens when $CRTN launches.</p>
              </section>
            ) : (
              <>
                <section className="panel form-panel">
                  <h2>Earn up to 2× rewards</h2>
                  {!staking && <Note>Staking is not configured.</Note>}
                  <label className="field-label" htmlFor="stake-amount">
                    Amount · CRTN{" "}
                    {app.stakeBalance !== undefined && app.stakeDecimals !== undefined
                      ? `· Balance ${formatUnits(app.stakeBalance, app.stakeDecimals)}`
                      : ""}
                  </label>
                  <input
                    id="stake-amount"
                    inputMode="decimal"
                    value={stakeAmount}
                    onChange={(e) => setStakeAmount(e.target.value)}
                  />
                  <div className="v2-tiers">
                    {TIERS.map((t) => (
                      <button
                        key={t.tier}
                        className="panel"
                        aria-pressed={tier === t.tier}
                        onClick={() => setTier(t.tier)}
                      >
                        <strong>{t.days} days</strong>
                        <span>{t.multiplier}× rewards</span>
                      </button>
                    ))}
                  </div>
                  <button
                    className="button gold"
                    disabled={
                      !!busy ||
                      !wallet ||
                      !staking ||
                      app.stakeDecimals === undefined ||
                      !stakeAmount ||
                      stakingBlock === undefined
                    }
                    onClick={() =>
                      void run("Stake", async () => {
                        const raw = rawAmount(stakeAmount, app.stakeDecimals!);
                        if (app.stakeBalance === undefined || raw > app.stakeBalance)
                          throw new Error("Your CRTN balance is too low.");
                        await app.sdk.stake(stakeToken!, raw, tier);
                        setStakeAmount("");
                        await app.refreshStaking();
                        setMessage("Your position is staked.");
                      })
                    }
                  >
                    Stake
                  </button>
                  <span
                    className="field-help"
                    title="After unlocking, a position earns at 1×. Withdraw and restake to earn a multiplier again."
                  >
                    After unlocking, a position earns at 1×. Withdraw and restake to earn a
                    multiplier again.
                  </span>
                </section>
                <div className="v2-section">{positionTable()}</div>
              </>
            ))}
          {current.id === "activity" && (
            <section className="panel">
              <div className="panel-heading">
                <h2>Your swaps & tickets</h2>
                <button
                  className="text-button"
                  disabled={!wallet || !!busy}
                  onClick={() => importRef.current?.click()}
                >
                  Import ticket
                </button>
                <input
                  ref={importRef}
                  type="file"
                  accept="application/json,.json"
                  className="v2-file-input"
                  aria-label="Import escape ticket"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void importTicket(file);
                    e.target.value = "";
                  }}
                />
              </div>
              <Note>
                Keep this file. If Curtain is ever unavailable, it lets you take your deposit back.
                Tickets stay on your device; refunds use the chain directly.
              </Note>
              {rows()}
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
