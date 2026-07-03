import { describe, expect, it } from "vitest";
import { batch, catchError, createMemo, createSignal, effect, read } from "../src/runtime/signal";

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

  it("batches multiple signal writes into one effect run", () => {
    const first = createSignal(1);
    const second = createSignal(10);
    const seen: number[] = [];

    effect(() => {
      seen.push(first() + second());
    });
    batch(() => {
      first.set(2);
      second.set(20);
    });

    expect(seen).toEqual([11, 22]);
  });

  it("memoizes computed values and prevents diamond dependency glitches", () => {
    const count = createSignal(1);
    const doubled = createMemo(() => count() * 2);
    const seen: string[] = [];

    effect(() => {
      seen.push(`${count()}:${doubled()}`);
    });
    count.set(2);

    expect(doubled()).toBe(4);
    expect(seen).toEqual(["1:2", "2:4"]);
  });

  it("queues writes from effects instead of re-entering the active effect", () => {
    const count = createSignal(0);
    const seen: number[] = [];
    let running = false;
    let reentered = false;

    effect(() => {
      if (running) {
        reentered = true;
      }
      running = true;
      const value = count();
      seen.push(value);
      if (value < 2) {
        count.set(value + 1);
      }
      running = false;
    });

    expect(seen).toEqual([0, 1, 2]);
    expect(reentered).toBe(false);
  });

  it("recovers throwing effects with catchError", () => {
    const value = createSignal("ok");
    const seen: string[] = [];
    const errors: string[] = [];

    const dispose = catchError(
      () => {
        const current = value();
        if (current === "bad") {
          throw new Error("broken");
        }
        seen.push(current);
      },
      (error) => {
        errors.push(error instanceof Error ? error.message : String(error));
      },
    );

    value.set("bad");
    value.set("again");
    dispose();
    value.set("ignored");

    expect(seen).toEqual(["ok", "again"]);
    expect(errors).toEqual(["broken"]);
  });
});
