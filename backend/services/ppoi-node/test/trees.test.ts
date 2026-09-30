import { describe, expect, it } from "bun:test";
import { ProviderTree, parseList } from "../src/trees";

const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const C = "0x00000000000000000000000000000000000000c3";

describe("provider trees", () => {
  it("parses lists: lowercase, dedupes, skips comments and blanks, rejects junk", () => {
    expect(parseList(`# sanctions\n${B.toUpperCase().replace("0X", "0x")}\n\n${A}\n${A}\n`)).toEqual([A, B]);
    expect(() => parseList("not-an-address")).toThrow();
  });

  it("an empty list has listRoot 0 — the root ScreeningGate uses for excluded providers", async () => {
    const empty = await ProviderTree.empty();
    expect(empty.listRoot).toBe(0n);
    const w = await empty.nonMembership(C);
    expect(w.root).toBe(0n);
    expect(w.isOld0).toBe(1n);
    expect(w.siblings.length).toBe(32);
  });

  it("gives non-membership witnesses for unlisted origins and refuses listed ones", async () => {
    const t = await ProviderTree.build([A, B]);
    expect(t.listRoot).not.toBe(0n);
    const w = await t.nonMembership(C);
    expect(w.root).toBe(t.listRoot);
    expect(w.siblings.length).toBe(32);
    await expect(t.nonMembership(A)).rejects.toThrow();
  });

  it("flag paths verify against flagRoot the way MerkleProof32 does", async () => {
    const t = await ProviderTree.build([A, B, C]);
    for (const addr of [A, B, C] as const) {
      const p = t.flagPath(addr)!;
      expect(p.pathElements.length).toBe(32);
      expect(t.verifyFlagPath(addr, p)).toBe(true);
    }
    expect(t.flagPath("0x00000000000000000000000000000000000000dd")).toBeUndefined();
  });
});
