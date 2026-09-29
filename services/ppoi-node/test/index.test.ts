import { describe, expect, it } from "bun:test";
import { name, ready } from "../src/index";

describe("@curtain/ppoi-node scaffold", () => {
  it("exposes its workspace name", () => {
    expect(name).toBe("ppoi-node");
  });

  it("is ready for milestone implementation", () => {
    expect(ready()).toBe(true);
  });
});
