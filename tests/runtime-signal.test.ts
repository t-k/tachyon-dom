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

  it("disposes nested effects before rerunning their owner", () => {
    const outer = createSignal(0);
    const inner = createSignal("a");
    const seen: string[] = [];

    const dispose = effect(() => {
      const outerValue = outer();
      effect(() => {
        seen.push(`${outerValue}:${inner()}`);
      });
    });

    outer.set(1);
    inner.set("b");
    dispose();
    inner.set("c");

    expect(seen).toEqual(["0:a", "1:a", "1:b"]);
  });

  it("reads plain values and signal values through one helper", () => {
    const title = createSignal("Hello");

    expect(read("Plain")).toBe("Plain");
    expect(read(title)).toBe("Hello");
  });
});
