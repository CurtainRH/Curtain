import { describe, expect, it } from "bun:test";
import { name, ready } from "../src/index";

describe("@curtain/multiplier-view scaffold", () => {
  it("exposes its workspace name", () => {
    expect(name).toBe("multiplier-view");
  });

  it("is ready for milestone implementation", () => {
    expect(ready()).toBe(true);
  });
});
