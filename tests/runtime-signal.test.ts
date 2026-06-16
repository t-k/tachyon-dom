import { describe, expect, it } from "vitest";
import { createSignal, effect, read } from "../src/runtime/signal";

describe("signal runtime", () => {
  it("re-runs effects only while they are active", () => {
    const count = createSignal(1);
    const seen: number[] = [];

    const dispose = effect(() => {
      seen.push(count());
    });
    count.set(2);
    dispose();
    count.set(3);

    expect(seen).toEqual([1, 2]);
  });

  it("reads plain values and signal values through one helper", () => {
    const title = createSignal("Hello");

    expect(read("Plain")).toBe("Plain");
    expect(read(title)).toBe("Hello");
  });
});
