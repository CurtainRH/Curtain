import { describe, expect, it } from "bun:test";
import { name, ready } from "../src/index";

describe("@curtain/solvency scaffold", () => {
  it("exposes its workspace name", () => {
    expect(name).toBe("solvency");
  });

  it("is ready for milestone implementation", () => {
    expect(ready()).toBe(true);
  });
});
