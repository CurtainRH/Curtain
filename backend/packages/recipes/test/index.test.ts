import { describe, expect, it } from "bun:test";
import { name, ready } from "../src/index";

describe("@curtain/recipes scaffold", () => {
  it("exposes its workspace name", () => {
    expect(name).toBe("recipes");
  });

  it("is ready for milestone implementation", () => {
    expect(ready()).toBe(true);
  });
});
