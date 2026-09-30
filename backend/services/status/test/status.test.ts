import { describe, expect, it } from "bun:test";
import { buildProtocolStatus } from "../src/index";

describe("@curtain/status service", () => {
  it("calculates standard 15-min standby when >= 2 providers are fresh", () => {
    const now = 100000;
    const providers = [
      { id: 1, name: "OFAC", publisher: "0x1", root: "0x111", updatedAt: now - 100, isStale: false },
      { id: 2, name: "ScamSniffer", publisher: "0x2", root: "0x222", updatedAt: now - 200, isStale: false },
      { id: 3, name: "StudioASP", publisher: "0x3", root: "0x333", updatedAt: now - 300, isStale: false },
    ];

    const report = buildProtocolStatus(providers, [], [], now);
    expect(report.standbySeconds).toBe(900);
    expect(report.isDegradedStandby).toBe(false);
    expect(report.freshProviderCount).toBe(3);
  });

  it("degrades standby to 60-min (3600s) when < 2 providers are fresh (> 24h stale)", () => {
    const now = 100000;
    const day = 86400;
    const providers = [
      { id: 1, name: "OFAC", publisher: "0x1", root: "0x111", updatedAt: now - 100, isStale: false }, // fresh
      { id: 2, name: "ScamSniffer", publisher: "0x2", root: "0x222", updatedAt: now - day - 100, isStale: false }, // stale
      { id: 3, name: "StudioASP", publisher: "0x3", root: "0x333", updatedAt: now - day - 500, isStale: false }, // stale
    ];

    const report = buildProtocolStatus(providers, [], [], now);
    expect(report.standbySeconds).toBe(3600);
    expect(report.isDegradedStandby).toBe(true);
    expect(report.freshProviderCount).toBe(1);
  });
});
