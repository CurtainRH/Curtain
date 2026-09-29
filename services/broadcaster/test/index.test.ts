import { describe, expect, it } from "bun:test";
import { name, ready } from "../src/index";

describe("@curtain/broadcaster scaffold", () => {
  it("exposes its workspace name", () => {
    expect(name).toBe("broadcaster");
  });

  it("is ready for milestone implementation", () => {
    expect(ready()).toBe(true);
  });
});
