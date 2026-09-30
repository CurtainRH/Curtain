import { describe, expect, it } from "bun:test";
import { handle } from "../src/app";

describe("GET /health", () => {
  it("returns ok with an ISO timestamp", async () => {
    const res = await handle(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; timestamp: string; version: string };
    expect(body.status).toBe("ok");
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
    expect(body.version).toBe("0.0.1");
  });

  it("404s unknown routes", async () => {
    const res = await handle(new Request("http://localhost/nope"));
    expect(res.status).toBe(404);
  });
});
