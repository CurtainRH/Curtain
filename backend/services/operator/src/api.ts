/**
 * Operator HTTP API.
 *
 *   GET  /health                  liveness (always 200 while the process serves)
 *   GET  /status                  200 when healthy, 503 + problems when it needs attention
 *   GET  /config                  vault, tokens, fees, limits
 *   GET  /quote?tokenIn&tokenOut&amountIn[&slippageBps]   expected output after fees, suggested minOut
 *   POST /intents                 { tokenIn, amountIn, tokenOut, recipient, depositor, minOut, delaySeconds }
 *                                 -> { id, deadline, salt, deadlineHash, vault }
 *                                 Keep `deadline` and `salt`: they unlock the escape hatch.
 *   GET  /intents/:id             status of your swap
 *   GET  /settlements/pending     signed settlements any keeper may submit (keeper earns the fees)
 */
import { getAddress, isAddress, type Address } from "viem";
import type { Db } from "@curtain/db";
import { createIntent, IntentError, MAX_DELAY_SECONDS } from "./intents";
import type { Operator } from "./operator";

export interface ApiConfig {
  db: Db;
  operator: Operator;
  vault: Address;
  tokens: Record<string, Address>; // symbol -> address
  keeperFeeBps: number;
  /** /status reports a problem below this operator gas balance (default 0.005 ETH). */
  minBalanceWei?: bigint;
  now?: () => number; // unix seconds
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });

export function createApi(cfg: ApiConfig): (req: Request) => Promise<Response> {
  const now = cfg.now ?? (() => Math.floor(Date.now() / 1000));
  const allowed = new Set(Object.values(cfg.tokens).map((t) => getAddress(t))); // config casing must not matter

  return async (req) => {
    const url = new URL(req.url);
    try {
      if (req.method === "OPTIONS") {
        return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type" } });
      }
      if (req.method === "GET" && url.pathname === "/health") return json({ status: "ok" });

      // For an uptime monitor: 503 with the list of problems when something needs attention.
      if (req.method === "GET" && url.pathname === "/status") {
        const st = await cfg.operator.status(now(), { minBalanceWei: cfg.minBalanceWei });
        return json(st, st.ok ? 200 : 503);
      }

      if (req.method === "GET" && url.pathname === "/config") {
        return json({ vault: cfg.vault, tokens: cfg.tokens, keeperFeeBps: cfg.keeperFeeBps, maxDelaySeconds: MAX_DELAY_SECONDS });
      }

      if (req.method === "GET" && url.pathname === "/quote") {
        const tokenIn = url.searchParams.get("tokenIn") ?? "";
        const tokenOut = url.searchParams.get("tokenOut") ?? "";
        const amountIn = url.searchParams.get("amountIn") ?? "";
        if (!isAddress(tokenIn) || !isAddress(tokenOut) || !/^[1-9]\d*$/.test(amountIn)) {
          return json({ error: "tokenIn, tokenOut (addresses) and amountIn (raw units, > 0) are required" }, 400);
        }
        if (!allowed.has(getAddress(tokenIn)) || !allowed.has(getAddress(tokenOut))) return json({ error: "token not supported" }, 400);
        const slippage = Number(url.searchParams.get("slippageBps") ?? 100);
        if (!(slippage >= 0 && slippage <= 5000)) return json({ error: "slippageBps must be 0..5000" }, 400);
        return json(await cfg.operator.quoteForUser(getAddress(tokenIn), getAddress(tokenOut), BigInt(amountIn), slippage));
      }

      if (req.method === "POST" && url.pathname === "/intents") {
        const body = (await req.json()) as Record<string, unknown>;
        const intent = await createIntent(cfg.db, {
          tokenIn: String(body["tokenIn"]),
          amountIn: String(body["amountIn"]),
          tokenOut: String(body["tokenOut"]),
          recipient: String(body["recipient"]),
          depositor: String(body["depositor"]),
          minOut: String(body["minOut"]),
          delaySeconds: Number(body["delaySeconds"] ?? 0),
        }, allowed, cfg.vault, now());
        return json({ id: intent.id, deadline: intent.deadline, salt: intent.salt, deadlineHash: intent.deadlineHash, vault: cfg.vault }, 201);
      }

      const m = url.pathname.match(/^\/intents\/([0-9a-f]{32})$/);
      if (req.method === "GET" && m) {
        const rows = await cfg.db.query<Record<string, unknown>>(
          `SELECT i.status, i.deposit_id::text AS "depositId", i.amount_out::text AS "amountOut", s.tx_hash AS "payoutTx",
                  i.blocked_reason AS "blockedReason"
           FROM intents i LEFT JOIN settlements s ON s.id = i.settlement_id AND s.status = 'confirmed' WHERE i.id = $1`,
          [m[1]],
        );
        return rows[0] ? json(rows[0]) : json({ error: "unknown intent" }, 404);
      }

      if (req.method === "GET" && url.pathname === "/settlements/pending") {
        return json(await cfg.operator.pendingSettlements(now()));
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      if (e instanceof IntentError || e instanceof SyntaxError) return json({ error: e.message }, 400);
      console.error(e);
      return json({ error: "internal error" }, 500);
    }
  };
}
