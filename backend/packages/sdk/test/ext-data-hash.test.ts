import { describe, expect, it } from "bun:test";
import { computeExtDataHash } from "../src/pool-client";

describe("computeExtDataHash", () => {
  it("matches CurtainPool.extDataHashFor() for the same inputs", () => {
    // Expected value read from a deployed CurtainPool via
    // `cast call <pool> "extDataHashFor(address,uint256,uint256,address,bytes32)(uint256)" ...`
    const h = computeExtDataHash({
      unshieldTo: "0x00000000000000000000000000000000000000aa",
      unshieldAmount: 50_000000000000000000n,
      feeAmount: 100000000000000000n,
      feeRecipient: "0x00000000000000000000000000000000000000B0",
      extData: "0x1111111111111111111111111111111111111111111111111111111111111111",
    });
    expect(h).toBe(12528256523283031669077496745993321103382163902816550829326023917499706746288n);
  });

  it("changes when feeRecipient or extData changes (so proofs can't be replayed with others)", () => {
    const base = {
      unshieldTo: "0x00000000000000000000000000000000000000aa" as const,
      unshieldAmount: 1n,
      feeAmount: 1n,
      feeRecipient: "0x00000000000000000000000000000000000000B0" as const,
      extData: "0x1111111111111111111111111111111111111111111111111111111111111111" as const,
    };
    const h = computeExtDataHash(base);
    expect(computeExtDataHash({ ...base, feeRecipient: "0x00000000000000000000000000000000000000B1" })).not.toBe(h);
    expect(computeExtDataHash({ ...base, extData: `0x${"22".repeat(32)}` })).not.toBe(h);
  });
});
