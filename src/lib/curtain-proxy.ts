/**
 * Server-side proxy for Curtain Operator API and Lovable media assets.
 * Executes backend API calls server-side and relays them to the browser client,
 * keeping operator endpoints private and providing clean offline fallbacks.
 */

const DEFAULT_TOKENS: Record<string, string> = {
  USDG: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  NVDA: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
  TSLA: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
  SPY: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C",
  QQQ: "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68",
};

export function getOperatorUrl(env?: unknown): string {
  if (env && typeof env === "object") {
    const e = env as Record<string, unknown>;
    for (const key of [
      "CURTAIN_API_URL",
      "CURTAIN_OPERATOR_URL",
      "OPERATOR_API_URL",
      "VITE_CURTAIN_API_URL",
    ]) {
      if (typeof e[key] === "string" && e[key]) return (e[key] as string).replace(/\/$/, "");
    }
  }
  if (typeof process !== "undefined" && process.env) {
    const p = process.env;
    for (const key of [
      "CURTAIN_API_URL",
      "CURTAIN_OPERATOR_URL",
      "OPERATOR_API_URL",
      "VITE_CURTAIN_API_URL",
    ]) {
      if (typeof p[key] === "string" && p[key]) return p[key]!.replace(/\/$/, "");
    }
  }
  return "";
}

function getVaultAddress(env?: unknown): string {
  if (env && typeof env === "object") {
    const e = env as Record<string, unknown>;
    if (typeof e["VITE_VAULT_ADDR"] === "string" && e["VITE_VAULT_ADDR"])
      return e["VITE_VAULT_ADDR"] as string;
    if (typeof e["VAULT_ADDR"] === "string" && e["VAULT_ADDR"]) return e["VAULT_ADDR"] as string;
  }
  if (typeof process !== "undefined" && process.env) {
    const p = process.env;
    if (p["VITE_VAULT_ADDR"]) return p["VITE_VAULT_ADDR"];
    if (p["VAULT_ADDR"]) return p["VAULT_ADDR"];
  }
  return "";
}

export async function handleCurtainApiProxy(
  request: Request,
  env?: unknown,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/curtain")) {
    return null;
  }

  // Preflight CORS support
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      },
    });
  }

  const subpath = url.pathname.replace(/^\/api\/curtain/, "") || "/";
  const operatorUrl = getOperatorUrl(env);

  // If operator URL is configured, forward request to the backend operator
  if (operatorUrl) {
    const target = `${operatorUrl}${subpath}${url.search}`;
    try {
      const headers = new Headers();
      for (const [k, v] of request.headers.entries()) {
        const lower = k.toLowerCase();
        if (lower !== "host" && lower !== "connection" && lower !== "content-length") {
          headers.set(k, v);
        }
      }
      const init: RequestInit = {
        method: request.method,
        headers,
        signal: AbortSignal.timeout(10000),
      };
      if (request.method !== "GET" && request.method !== "HEAD") {
        init.body = await request.arrayBuffer();
      }

      const upstream = await fetch(target, init);
      const resHeaders = new Headers(upstream.headers);
      resHeaders.set("access-control-allow-origin", "*");
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: resHeaders,
      });
    } catch (err) {
      console.warn(`Upstream operator request to ${target} failed:`, err);
    }
  }

  // Graceful offline fallbacks when backend operator is not yet running
  if (subpath === "/health") {
    return new Response(
      JSON.stringify({
        status: "ok",
        operator: "offline",
        message: "Curtain operator pending deployment",
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
        },
      },
    );
  }

  if (subpath === "/config") {
    const vault = getVaultAddress(env);
    if (vault) {
      return new Response(
        JSON.stringify({
          vault,
          tokens: DEFAULT_TOKENS,
          keeperFeeBps: 5,
          maxDelaySeconds: 15552000,
          offline: true,
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
          },
        },
      );
    }
    return new Response(
      JSON.stringify({
        error: "Curtain operator backend is offline or awaiting mainnet deployment.",
        status: "pending_deployment",
      }),
      {
        status: 503,
        headers: {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
        },
      },
    );
  }

  return new Response(
    JSON.stringify({
      error: "Curtain operator backend is not reachable. Swaps are currently paused.",
      code: "OPERATOR_OFFLINE",
    }),
    {
      status: 503,
      headers: {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
      },
    },
  );
}

export async function handleAssetProxy(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/__l5e/")) {
    return null;
  }
  const remoteUrl = `https://curtainlah.lovable.app${url.pathname}${url.search}`;
  try {
    const upstream = await fetch(remoteUrl, { signal: AbortSignal.timeout(10000) });
    const headers = new Headers(upstream.headers);
    headers.set("cache-control", "public, max-age=31536000, immutable");
    headers.set("access-control-allow-origin", "*");
    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    });
  } catch {
    return null;
  }
}
