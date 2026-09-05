import { afterEach, describe, expect, it, vi } from "vitest";
import {
  batch,
  catchError,
  createMemo,
  createResource,
  createRoot,
  createSignal,
  effect,
  onCleanup,
  read,
  untrack,
} from "../src/runtime/signal";

const arrayFrom = Array.from;

afterEach(() => {
  Array.from = arrayFrom;
});

describe("signal runtime", () => {
  it("disposes root-owned effects and memos with cleanup callbacks in reverse order", () => {
    const count = createSignal(1);
    const seen: number[] = [];
    const cleanups: string[] = [];
    const dispose = createRoot((disposeRoot) => {
      onCleanup(() => cleanups.push("first"));
      const doubled = createMemo(() => count() * 2);
      effect(() => seen.push(doubled()));
      onCleanup(() => cleanups.push("second"));
      return disposeRoot;
    });

    count.set(2);
    dispose();
    dispose();
    count.set(3);

    expect(seen).toEqual([2, 4]);
    expect(cleanups).toEqual(["second", "first"]);
  });

  it("runs every root cleanup before rethrowing the first cleanup error", () => {
    const cleanups: string[] = [];
    const dispose = createRoot((disposeRoot) => {
      onCleanup(() => cleanups.push("last"));
      onCleanup(() => {
        cleanups.push("throws");
        throw new Error("cleanup failed");
      });
      onCleanup(() => cleanups.push("first"));
      return disposeRoot;
    });

    expect(dispose).toThrow("cleanup failed");
    expect(cleanups).toEqual(["first", "throws", "last"]);
    expect(() => dispose()).not.toThrow();
  });

  it("aborts root-owned resources and detaches their source tracking", async () => {
    const key = createSignal("first");
    const calls: string[] = [];
    let requestSignal: AbortSignal | undefined;
    const dispose = createRoot((disposeRoot) => {
      createResource(key, (value, context) => {
        calls.push(value);
        requestSignal = context.signal;
        return new Promise<string>(() => undefined);
      });
      return disposeRoot;
    });

    await Promise.resolve();
    dispose();
    key.set("ignored");

    expect(requestSignal?.aborted).toBe(true);
    expect(calls).toEqual(["first"]);
  });
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

  it("replaces effect-run cleanups before rerunning and disposes the latest run", () => {
    const source = createSignal(0);
    const events: string[] = [];

    const dispose = effect(() => {
      const value = source();
      onCleanup(() => events.push(`registered:${value}`));
      return () => events.push(`returned:${value}`);
    });

    source.set(1);
    dispose();

    expect(events).toEqual(["returned:0", "registered:0", "returned:1", "registered:1"]);
  });

  it("continues an effect rerun cleanup sequence after one cleanup throws", () => {
    const source = createSignal(0);
    const events: string[] = [];

    const dispose = effect(() => {
      const value = source();
      onCleanup(() => {
        events.push(`throws:${value}`);
        if (value === 0) throw new Error("run cleanup failed");
      });
      onCleanup(() => events.push(`after:${value}`));
    });

    expect(() => source.set(1)).toThrow("run cleanup failed");
    expect(events).toEqual(["after:0", "throws:0"]);
    dispose();
    expect(events).toEqual(["after:0", "throws:0", "after:1", "throws:1"]);
  });

  it("detaches an effect that throws during initial registration", () => {
    const value = createSignal(0);
    let runs = 0;

    expect(() =>
      effect(() => {
        runs++;
        value();
        throw new Error("initial failure");
      }),
    ).toThrow("initial failure");

    expect(() => value.set(1)).not.toThrow();
    expect(runs).toBe(1);
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

  it("reads signals without subscribing the active effect through untrack", () => {
    const count = createSignal(1);
    const seen: number[] = [];

    effect(() => {
      seen.push(untrack(() => count()));
    });
    count.set(2);

    expect(seen).toEqual([1]);
  });

  it("creates effects inside untrack without attaching them to the active owner", () => {
    const outer = createSignal(0);
    const inner = createSignal("a");
    const seen: string[] = [];
    let disposeInner: (() => void) | undefined;

    const disposeOuter = effect(() => {
      outer();
      if (!disposeInner) {
        untrack(() => {
          disposeInner = effect(() => {
            seen.push(inner());
          });
        });
      }
    });

    outer.set(1);
    inner.set("b");
    disposeOuter();
    inner.set("c");
    disposeInner?.();
    inner.set("d");

    expect(seen).toEqual(["a", "b", "c"]);
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

  it("drains sibling effects before reporting an unhandled failure", () => {
    const source = createSignal(0);
    const calls: string[] = [];
    effect(() => {
      const value = source();
      calls.push(`thrower:${value}`);
      if (value === 1) throw new Error("first");
    });
    effect(() => {
      calls.push(`sibling:${source()}`);
    });
    calls.length = 0;

    expect(() => batch(() => source.set(1))).toThrow("first");

    expect(calls).toEqual(["thrower:1", "sibling:1"]);
  });

  it("reports multiple unhandled reactive failures in queue order", () => {
    const source = createSignal(0);
    effect(() => {
      if (source() === 1) throw new Error("first");
    });
    effect(() => {
      if (source() === 1) throw new Error("second");
    });
    let thrown: unknown;

    try {
      batch(() => source.set(1));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([new Error("first"), new Error("second")]);
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

  it("runs memo updates before dependent effects subscribed earlier", () => {
    const source = createSignal(1);
    let memo: (() => number) | undefined;
    const seen: string[] = [];

    effect(() => {
      const value = source();
      seen.push(memo ? `s=${value} m=${memo()}` : `s=${value}`);
    });
    memo = createMemo(() => source() * 10);
    seen.length = 0;

    source.set(2);

    expect(seen).toEqual(["s=2 m=20"]);
  });

  it("flushes batched pending effects without scanning the whole pending queue per effect", () => {
    const sources = Array.from({ length: 64 }, () => createSignal(0));
    const seen: number[] = [];
    let largestSetSnapshot = 0;
    const from = vi.fn((value: Iterable<unknown> | ArrayLike<unknown>) => {
      if (value instanceof Set) {
        largestSetSnapshot = Math.max(largestSetSnapshot, value.size);
      }
      return arrayFrom(value);
    }) as typeof Array.from;
    Array.from = from;

    for (const [index, source] of sources.entries()) {
      effect(() => {
        seen[index] = source();
      });
    }

    batch(() => {
      for (const [index, source] of sources.entries()) {
        source.set(index + 1);
      }
    });

    expect(seen).toEqual(sources.map((_, index) => index + 1));
    expect(largestSetSnapshot).toBeLessThanOrEqual(1);
  });

  it("tracks createResource loading, data, and error states through effects", async () => {
    const key = createSignal("ok");
    const resource = createResource(key, async (value) => {
      await Promise.resolve();
      if (value === "bad") {
        throw new Error("broken");
      }
      return value.toUpperCase();
    });
    const seen: string[] = [];

    effect(() => {
      seen.push(`${resource.loading()}:${resource.data() ?? "-"}:${resource.error() instanceof Error ? "err" : "-"}`);
    });
    await resource.refetch();
    key.set("bad");
    await resource.refetch();

    expect(seen).toEqual(["true:-:-", "false:OK:-", "true:OK:-", "false:OK:err"]);
  });

  it("refetches when an accessor source changes", async () => {
    const key = createSignal("first");
    const calls: string[] = [];
    const resource = createResource(key, async (value) => {
      calls.push(value);
      return value.toUpperCase();
    });

    await resource.refetch();
    key.set("second");
    await Promise.resolve();
    await Promise.resolve();
    await resource.refetch();

    expect(calls).toEqual(["first", "second"]);
    expect(resource.data()).toBe("SECOND");
  });

  it("keeps the newest resource result when its source changes in flight", async () => {
    const key = createSignal("first");
    const calls: string[] = [];
    const signals: AbortSignal[] = [];
    const resolve = new Map<string, (value: string) => void>();
    const resource = createResource(key, (value, { signal }) => {
      calls.push(value);
      signals.push(signal);
      return new Promise<string>((done) => resolve.set(value, done));
    });

    await Promise.resolve();
    key.set("second");
    await Promise.resolve();
    expect(calls).toEqual(["first", "second"]);
    expect(signals[0]?.aborted).toBe(true);

    resolve.get("second")?.("SECOND");
    await resource.refetch();
    resolve.get("first")?.("STALE");
    await Promise.resolve();
    expect(resource.data()).toBe("SECOND");
    expect(resource.loading()).toBe(false);
    resource.dispose();
  });

  it("does not reload resources for equal source values and clears errors after recovery", async () => {
    const key = createSignal("bad");
    const calls: string[] = [];
    const resource = createResource(key, async (value) => {
      calls.push(value);
      if (value === "bad") throw new Error("broken");
      return value.toUpperCase();
    });

    await resource.refetch();
    key.set("bad");
    expect(calls).toEqual(["bad"]);
    expect(resource.error()).toBeInstanceOf(Error);

    key.set("good");
    await resource.refetch();
    expect(calls).toEqual(["bad", "good"]);
    expect(resource.data()).toBe("GOOD");
    expect(resource.error()).toBeUndefined();
    resource.dispose();
  });

  it("aborts and detaches resource tracking when disposed", async () => {
    const key = createSignal("first");
    let signal: AbortSignal | undefined;
    const calls: string[] = [];
    const resource = createResource(key, (value, context) => {
      calls.push(value);
      signal = context.signal;
      return new Promise<string>(() => undefined);
    });

    await Promise.resolve();
    resource.dispose();
    key.set("ignored");

    expect(signal?.aborted).toBe(true);
    expect(resource.loading()).toBe(false);
    expect(calls).toEqual(["first"]);
  });

  it("distinguishes successful undefined data, errors, and cancellation outcomes", async () => {
    let resolveFirst: ((value: undefined) => void) | undefined;
    let rejectSecond: ((reason: Error) => void) | undefined;
    let request = 0;
    const resource = createResource("source", () => {
      request++;
      if (request === 1) {
        return new Promise<undefined>((resolve) => {
          resolveFirst = resolve;
        });
      }
      if (request === 2) {
        return new Promise<never>((_resolve, reject) => {
          rejectSecond = reject;
        });
      }
      return new Promise<string>(() => undefined);
    });

    await Promise.resolve();
    resolveFirst?.(undefined);
    expect(await resource.refetchOutcome()).toEqual({ status: "success", data: undefined });

    const errorOutcome = resource.refetchOutcome();
    await Promise.resolve();
    rejectSecond?.(new Error("broken"));
    expect(await errorOutcome).toMatchObject({ status: "error", error: expect.any(Error) });

    const cancelled = resource.refetchOutcome();
    await Promise.resolve();
    resource.dispose();
    expect(await cancelled).toMatchObject({ status: "cancelled" });
  });
});
