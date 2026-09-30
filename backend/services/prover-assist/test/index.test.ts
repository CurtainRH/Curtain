import { describe, expect, it } from "bun:test";
import { name, ready } from "../src/index";

describe("@curtain/prover-assist scaffold", () => {
  it("exposes its workspace name", () => {
    expect(name).toBe("prover-assist");
  });

  it("is ready for milestone implementation", () => {
    expect(ready()).toBe(true);
  });
});
