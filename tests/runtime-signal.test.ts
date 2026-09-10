import { afterEach, describe, expect, it, vi } from "vitest";
import {
  batch,
  catchError,
  createMemo,
  createReactiveErrorScope,
  createResource,
  createRoot,
  createSignal,
  detachFromEffectOwner,
  effect,
  onCleanup,
  read,
  untrack,
  type Resource,
  type ResourceOutcome,
} from "../src/runtime/signal";

const arrayFrom = Array.from;

afterEach(() => {
  Array.from = arrayFrom;
});

describe("signal runtime", () => {
  it("does not skip older sibling cleanups when one cleanup disposes another sibling", () => {
    const events: string[] = [];
    let disposeSibling: (() => void) | undefined;
    const dispose = createRoot((disposeRoot) => {
      effect(() => {
        onCleanup(() => events.push("C"));
      });
      disposeSibling = effect(() => {
        onCleanup(() => events.push("B"));
      });
      effect(() => {
        onCleanup(() => {
          events.push("A");
          disposeSibling?.();
        });
      });
      return disposeRoot;
    });

    dispose();

    expect(events).toEqual(["A", "B", "C"]);
  });

  it.each([undefined, null, 0, false, ""])("rethrows a falsy root cleanup error: %s", (error) => {
    const dispose = createRoot((disposeRoot) => {
      onCleanup(() => {
        throw error;
      });
      return disposeRoot;
    });

    let didThrow = false;
    let thrown: unknown;
    try {
      dispose();
    } catch (caught) {
      didThrow = true;
      thrown = caught;
    }

    expect(didThrow).toBe(true);
    expect(thrown).toBe(error);
  });

  it.each([undefined, null, 0, false, ""])("rethrows a falsy effect cleanup error: %s", (error) => {
    const dispose = effect(() => {
      onCleanup(() => {
        throw error;
      });
    });

    let didThrow = false;
    let thrown: unknown;
    try {
      dispose();
    } catch (caught) {
      didThrow = true;
      thrown = caught;
    }

    expect(didThrow).toBe(true);
    expect(thrown).toBe(error);
  });

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

  it("does not attach cleanup registered after an async effect continuation", async () => {
    let registered: boolean | undefined;
    const cleanup = vi.fn();
    const dispose = effect(async () => {
      await Promise.resolve();
      registered = onCleanup(cleanup);
    });

    await Promise.resolve();
    await Promise.resolve();
    dispose();

    expect(registered).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("delivers async effect rejections to the nearest reactive error owner", async () => {
    const errors: string[] = [];
    const scope = createReactiveErrorScope((error) => {
      errors.push(error instanceof Error ? error.message : String(error));
    });
    const dispose = scope.run(() =>
      effect(async () => {
        throw new Error("async failure");
      }),
    );

    await Promise.resolve();
    await Promise.resolve();
    dispose();
    scope.dispose();

    expect(errors).toEqual(["async failure"]);
  });

  it("continues reactive error-scope disposal after a runner cleanup throws", () => {
    const events: string[] = [];
    const scope = createReactiveErrorScope(() => undefined);

    scope.run(() => {
      effect(() => {
        onCleanup(() => {
          events.push("first");
          throw new Error("scope cleanup failed");
        });
      });
      effect(() => {
        onCleanup(() => events.push("second"));
      });
    });

    expect(() => scope.dispose()).toThrow("scope cleanup failed");
    expect(events).toEqual(["first", "second"]);
    expect(() => scope.dispose()).not.toThrow();
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

  it("does not rerun an effect after its root is disposed during the initial run", () => {
    const source = createSignal(0);
    let runs = 0;
    const disposeRoot = createRoot((dispose) => {
      effect(() => {
        source();
        runs++;
        dispose();
      });
      return dispose;
    });

    source.set(1);

    expect(runs).toBe(1);
    disposeRoot();
  });

  it("does not rerun an effect after its root is disposed by rerun cleanup", async () => {
    const source = createSignal(0);
    let runs = 0;
    let cleanupRuns = 0;
    let fetchCalls = 0;
    let resource: Resource<number> | undefined;
    const disposeRoot = createRoot((dispose) => {
      effect(() => {
        source();
        runs++;
        if (runs === 2) {
          resource = createResource("key", () => {
            fetchCalls++;
            return 1;
          });
        }
        return () => {
          cleanupRuns++;
          dispose();
        };
      });
      return dispose;
    });

    source.set(1);
    await Promise.resolve();
    await Promise.resolve();

    expect(runs).toBe(1);
    expect(cleanupRuns).toBe(1);
    expect(fetchCalls).toBe(0);
    expect(resource).toBeUndefined();
    disposeRoot();
  });

  it("preserves a rerun cleanup error when that cleanup disposes its root", () => {
    const source = createSignal(0);
    const cleanupError = new Error("cleanup disposed the root");
    let runs = 0;
    let cleanupRuns = 0;
    let disposeRoot: (() => void) | undefined;

    createRoot((dispose) => {
      disposeRoot = dispose;
      effect(() => {
        source();
        runs++;
        return () => {
          cleanupRuns++;
          dispose();
          throw cleanupError;
        };
      });
      return dispose;
    });

    expect(() => source.set(1)).toThrow(cleanupError);
    expect(runs).toBe(1);
    expect(cleanupRuns).toBe(1);
    expect(() => disposeRoot?.()).not.toThrow();
  });

  it("runs a returned cleanup immediately when the initial owner is disposed", () => {
    let cleanupRuns = 0;
    const disposeRoot = createRoot((dispose) => {
      effect(() => {
        dispose();
        return () => {
          cleanupRuns++;
        };
      });
      return dispose;
    });

    expect(cleanupRuns).toBe(1);
    disposeRoot();
    expect(cleanupRuns).toBe(1);
  });

  it("does not retain work created after an initial owner disposal", async () => {
    const source = createSignal(0);
    let registered: boolean | undefined;
    let childRuns = 0;
    let fetchCalls = 0;
    let resource!: Resource<string>;
    const disposeRoot = createRoot((dispose) => {
      effect(() => {
        dispose();
        source();
        registered = onCleanup(() => undefined);
        effect(() => {
          childRuns++;
          source();
        });
        resource = createResource("source", () => {
          fetchCalls++;
          return "payload";
        });
      });
      return dispose;
    });

    source.set(1);
    await Promise.resolve();
    await Promise.resolve();

    expect(registered).toBe(false);
    expect(childRuns).toBe(0);
    expect(fetchCalls).toBe(0);
    expect(resource.loading()).toBe(false);
    await expect(resource.refetchOutcome()).resolves.toMatchObject({ status: "cancelled" });
    disposeRoot();
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

  it("keeps effects created inside untrack owned by the active effect run", () => {
    const outer = createSignal(0);
    const inner = createSignal("a");
    const seen: string[] = [];

    const disposeOuter = effect(() => {
      outer();
      untrack(() => {
        effect(() => {
          seen.push(inner());
        });
      });
    });

    inner.set("b");
    // The rerun disposes the previous run's inner effect, so only one subscription observes "c".
    outer.set(1);
    inner.set("c");
    disposeOuter();
    inner.set("d");

    expect(seen).toEqual(["a", "b", "b", "c"]);
  });

  it("does not let untrack change which owner receives onCleanup", () => {
    const outer = createSignal(0);
    const events: string[] = [];

    const dispose = effect(() => {
      outer();
      untrack(() => {
        onCleanup(() => events.push("run-cleanup"));
      });
    });

    outer.set(1);
    expect(events).toEqual(["run-cleanup"]);
    dispose();
    expect(events).toEqual(["run-cleanup", "run-cleanup"]);
  });

  it("detaches effects from the active effect run only through detachFromEffectOwner", () => {
    const outer = createSignal(0);
    const inner = createSignal("a");
    const seen: string[] = [];
    let disposeInner: (() => void) | undefined;

    const disposeOuter = effect(() => {
      outer();
      if (!disposeInner) {
        disposeInner = detachFromEffectOwner(() =>
          effect(() => {
            seen.push(inner());
          }),
        );
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

  it("attaches detached effects to the enclosing root so the root still disposes them", () => {
    const outer = createSignal(0);
    const inner = createSignal("a");
    const seen: string[] = [];

    const disposeRoot = createRoot((dispose) => {
      effect(() => {
        outer();
        detachFromEffectOwner(() =>
          effect(() => {
            seen.push(inner());
          }),
        );
      });
      return dispose;
    });

    inner.set("b");
    disposeRoot();
    inner.set("c");

    expect(seen).toEqual(["a", "b"]);
  });

  it("does not subscribe the reader inside detachFromEffectOwner", () => {
    const count = createSignal(1);
    const seen: number[] = [];

    effect(() => {
      seen.push(detachFromEffectOwner(() => count()));
    });
    count.set(2);

    expect(seen).toEqual([1]);
  });

  it("returns the fresh memo value when read inside batch", () => {
    const count = createSignal(1);
    const doubled = createMemo(() => count() * 2);
    let runs = 0;
    effect(() => {
      doubled();
      runs++;
    });

    batch(() => {
      count.set(2);
      expect(count()).toBe(2);
      expect(doubled()).toBe(4);
      expect(runs).toBe(1);
    });

    expect(doubled()).toBe(4);
    expect(runs).toBe(2);
  });

  it("recomputes a memo at most once per flush even when it was read early", () => {
    const count = createSignal(1);
    let computations = 0;
    const doubled = createMemo(() => {
      computations++;
      return count() * 2;
    });

    batch(() => {
      count.set(2);
      doubled();
      doubled();
      count.set(3);
      expect(doubled()).toBe(6);
    });

    expect(computations).toBe(3);
    expect(doubled()).toBe(6);
  });

  it("reads chained memos fresh inside batch", () => {
    const count = createSignal(1);
    const doubled = createMemo(() => count() * 2);
    const quadrupled = createMemo(() => doubled() * 2);

    batch(() => {
      count.set(2);
      expect(quadrupled()).toBe(8);
      expect(doubled()).toBe(4);
    });

    expect(quadrupled()).toBe(8);
  });

  it("reads a memo fresh inside an effect after that effect wrote its source", () => {
    const count = createSignal(1);
    const doubled = createMemo(() => count() * 2);
    const trigger = createSignal(0);
    const seen: number[] = [];

    effect(() => {
      trigger();
      count.set(untrack(count) + 1);
      seen.push(untrack(doubled));
    });
    trigger.set(1);

    expect(seen).toEqual([4, 6]);
  });

  it("keeps tracking the memo when it is read fresh inside an effect", () => {
    const count = createSignal(1);
    const doubled = createMemo(() => count() * 2);
    const seen: number[] = [];

    effect(() => {
      seen.push(doubled());
    });
    batch(() => {
      count.set(2);
      doubled();
    });
    count.set(3);

    expect(seen).toEqual([2, 4, 6]);
  });

  it("throws the memo failure to an early reader and does not run it again in the flush", () => {
    const count = createSignal(1);
    let computations = 0;
    const doubled = createMemo(() => {
      computations++;
      if (count() === 2) throw new Error("memo failed");
      return count() * 2;
    });

    expect(() =>
      batch(() => {
        count.set(2);
        doubled();
      }),
    ).toThrow("memo failed");
    expect(computations).toBe(2);
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

  // Leaf effects own no children, so the only non-empty set a notification could copy is the subscriber set
  // itself. Rerun cleanup still copies each runner's (empty) child set because those do mutate while iterating.
  it("queues every subscriber without copying the subscriber set", () => {
    const source = createSignal(0);
    const seen: number[] = [];
    const copiedSetSizes: number[] = [];
    for (let index = 0; index < 8; index++) {
      effect(() => {
        seen[index] = source();
      });
    }
    seen.length = 0;
    Array.from = vi.fn((value: Iterable<unknown> | ArrayLike<unknown>) => {
      if (value instanceof Set && value.size > 0) copiedSetSizes.push(value.size);
      return arrayFrom(value);
    }) as typeof Array.from;

    source.set(1);

    Array.from = arrayFrom;
    expect(seen).toEqual(Array.from({ length: 8 }, () => 1));
    expect(copiedSetSizes).toEqual([]);
  });

  it("keeps computed subscribers ahead of plain effects and skips equal-value writes", () => {
    const count = createSignal(1);
    const order: string[] = [];
    const doubled = createMemo(() => {
      order.push("memo");
      return count() * 2;
    });
    effect(() => {
      order.push(`effect:${count()}:${doubled()}`);
    });
    order.length = 0;

    count.set(1);
    expect(order).toEqual([]);

    count.set(2);
    expect(order).toEqual(["memo", "effect:2:4"]);

    order.length = 0;
    batch(() => {
      count.set(3);
      count.set(4);
    });
    expect(order).toEqual(["memo", "effect:4:8"]);
  });

  it("skips subscribers disposed by an earlier subscriber of the same notification", () => {
    const source = createSignal(0);
    const calls: string[] = [];
    let disposeSecond: (() => void) | undefined;
    effect(() => {
      calls.push(`first:${source()}`);
      disposeSecond?.();
    });
    disposeSecond = effect(() => {
      calls.push(`second:${source()}`);
    });
    const third = effect(() => {
      calls.push(`third:${source()}`);
    });
    calls.length = 0;

    source.set(1);

    expect(calls).toEqual(["first:1", "third:1"]);
    third();
  });

  it("delivers notifications to subscriptions added and removed while flushing", () => {
    const source = createSignal(0);
    const other = createSignal("a");
    const calls: string[] = [];
    let readOther = false;
    const dispose = effect(() => {
      calls.push(readOther ? `both:${source()}:${other()}` : `source:${source()}`);
      onCleanup(() => calls.push("cleanup"));
    });
    calls.length = 0;

    readOther = true;
    source.set(1);
    expect(calls).toEqual(["cleanup", "both:1:a"]);

    calls.length = 0;
    other.set("b");
    expect(calls).toEqual(["cleanup", "both:1:b"]);

    calls.length = 0;
    readOther = false;
    source.set(2);
    expect(calls).toEqual(["cleanup", "source:2"]);

    calls.length = 0;
    other.set("c");
    expect(calls).toEqual([]);
    dispose();
  });

  it("stops notifying subscribers of a root disposed during the same flush", () => {
    const source = createSignal(0);
    const calls: string[] = [];
    createRoot((dispose) => {
      effect(() => {
        calls.push(`disposer:${source()}`);
        if (source() === 1) dispose();
      });
      effect(() => {
        calls.push(`sibling:${source()}`);
      });
    });
    calls.length = 0;

    source.set(1);
    expect(calls).toEqual(["disposer:1"]);

    calls.length = 0;
    source.set(2);
    expect(calls).toEqual([]);
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

  it("settles successful outcomes after an unhandled data notification error", async () => {
    let resolveFetch: ((value: string) => void) | undefined;
    const subscriberError = new Error("subscriber failed");
    const resource = createResource(
      "source",
      () =>
        new Promise<string>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    effect(() => {
      if (resource.data() !== undefined) {
        throw subscriberError;
      }
    });

    const reported: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      reported.push(reason);
    };
    const onUncaughtException = (error: unknown): void => {
      reported.push(error);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    process.on("uncaughtException", onUncaughtException);
    try {
      const outcome = resource.refetchOutcome();
      await Promise.resolve();
      resolveFetch?.("payload");
      const result = await Promise.race([
        outcome,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("resource outcome did not settle")), 100);
        }),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(result).toEqual({ status: "success", data: "payload" });
      expect(resource.data()).toBe("payload");
      expect(resource.loading()).toBe(false);
      expect(reported).toContain(subscriberError);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      process.off("uncaughtException", onUncaughtException);
      resource.dispose();
    }
  });

  it("keeps successful outcomes separate from handled data notification errors", async () => {
    let resolveFetch: ((value: string) => void) | undefined;
    const subscriberError = new Error("handled subscriber failed");
    const errors: unknown[] = [];
    const errorScope = createReactiveErrorScope((error) => errors.push(error));
    const resource = createResource(
      "source",
      () =>
        new Promise<string>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    errorScope.run(() =>
      effect(() => {
        if (resource.data() !== undefined) {
          throw subscriberError;
        }
      }),
    );

    try {
      const outcome = resource.refetchOutcome();
      await Promise.resolve();
      resolveFetch?.("payload");

      await expect(outcome).resolves.toEqual({ status: "success", data: "payload" });
      expect(resource.data()).toBe("payload");
      expect(resource.loading()).toBe(false);
      expect(errors).toEqual([subscriberError]);
    } finally {
      resource.dispose();
      errorScope.dispose();
    }
  });

  it("keeps fetch errors separate from handled error notification errors", async () => {
    let rejectFetch: ((reason: unknown) => void) | undefined;
    const fetchError = new Error("fetch failed");
    const subscriberError = new Error("handled error subscriber failed");
    const errors: unknown[] = [];
    const errorScope = createReactiveErrorScope((error) => errors.push(error));
    const resource = createResource(
      "source",
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectFetch = reject;
        }),
    );
    errorScope.run(() =>
      effect(() => {
        if (resource.error() !== undefined) {
          throw subscriberError;
        }
      }),
    );

    try {
      const outcome = resource.refetchOutcome();
      await Promise.resolve();
      rejectFetch?.(fetchError);

      await expect(outcome).resolves.toEqual({ status: "error", error: fetchError });
      expect(resource.error()).toBe(fetchError);
      expect(resource.loading()).toBe(false);
      expect(errors).toEqual([subscriberError]);
    } finally {
      resource.dispose();
      errorScope.dispose();
    }
  });

  it("settles the previous outcome when a data notification refetches", async () => {
    const resolvers: Array<(value: string) => void> = [];
    const resource = createResource(
      "source",
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    let nextOutcome: Promise<import("../src/runtime/signal").ResourceOutcome<string>> | undefined;
    effect(() => {
      if (resource.data() === "first") {
        nextOutcome = resource.refetchOutcome();
      }
    });

    try {
      const firstOutcome = resource.refetchOutcome();
      await Promise.resolve();
      resolvers[0]?.("first");

      await expect(firstOutcome).resolves.toEqual({ status: "cancelled", reason: "superseded" });
      await Promise.resolve();
      expect(resolvers).toHaveLength(2);

      resolvers[1]?.("second");
      await expect(nextOutcome).resolves.toEqual({ status: "success", data: "second" });
      expect(resource.data()).toBe("second");
      expect(resource.loading()).toBe(false);
    } finally {
      resource.dispose();
    }
  });

  it("settles the current outcome when a data notification disposes the resource", async () => {
    let resolveFetch: ((value: string) => void) | undefined;
    const resource = createResource(
      "source",
      () =>
        new Promise<string>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    effect(() => {
      if (resource.data() === "payload") {
        resource.dispose();
      }
    });

    const outcome = resource.refetchOutcome();
    await Promise.resolve();
    resolveFetch?.("payload");

    await expect(outcome).resolves.toEqual({ status: "cancelled", reason: "disposed" });
    expect(resource.data()).toBe("payload");
    expect(resource.loading()).toBe(false);
    resource.dispose();
  });

  it("does not revive loading when an abort listener disposes a completed resource", async () => {
    let resource!: Resource<string>;
    let fetchCalls = 0;
    resource = createResource("source", (_value, { signal }) => {
      fetchCalls++;
      signal.addEventListener("abort", () => resource.dispose(), { once: true });
      return "payload";
    });

    await expect(resource.refetchOutcome()).resolves.toEqual({ status: "success", data: "payload" });
    await expect(resource.refetchOutcome()).resolves.toEqual({ status: "cancelled", reason: "superseded" });

    expect(fetchCalls).toBe(1);
    expect(resource.loading()).toBe(false);
    resource.dispose();
  });

  it("shares the current source outcome when an abort listener refetches", async () => {
    const source = createSignal("a");
    const calls: string[] = [];
    const resolvers = new Map<string, (value: string) => void>();
    let nested: Promise<import("../src/runtime/signal").ResourceOutcome<string>> | undefined;
    let resource!: Resource<string>;
    resource = createResource(source, (value, { signal }) => {
      calls.push(value);
      if (value === "a") {
        signal.addEventListener("abort", () => {
          nested = resource.refetchOutcome();
        }, { once: true });
      }
      return new Promise<string>((resolve) => resolvers.set(value, resolve));
    });

    const first = resource.refetchOutcome();
    await Promise.resolve();
    source.set("b");
    const current = resource.refetchOutcome();

    expect(nested).toBe(current);
    expect(nested).not.toBe(first);
    await Promise.resolve();
    expect(calls).toEqual(["a", "b"]);
    resolvers.get("b")?.("B");

    await expect(first).resolves.toEqual({ status: "cancelled", reason: "superseded" });
    await expect(nested).resolves.toEqual({ status: "success", data: "B" });
    expect(resource.data()).toBe("B");
    expect(resource.loading()).toBe(false);
    resource.dispose();
  });

  it("does not share an abort reentry with a later source outcome", async () => {
    const source = createSignal("a");
    const calls: string[] = [];
    const resolvers = new Map<string, (value: string) => void>();
    let nested: Promise<ResourceOutcome<string>> | undefined;
    let resource!: Resource<string>;
    resource = createResource(source, (value, { signal }) => {
      calls.push(value);
      if (value === "a") {
        signal.addEventListener(
          "abort",
          () => {
            nested = resource.refetchOutcome();
            source.set("c");
          },
          { once: true },
        );
      }
      return new Promise<string>((resolve) => resolvers.set(value, resolve));
    });

    const first = resource.refetchOutcome();
    await Promise.resolve();
    source.set("b");
    await Promise.resolve();
    await Promise.resolve();
    const current = resource.refetchOutcome();

    expect(nested).toBeDefined();
    expect(nested).not.toBe(current);
    expect(calls).toEqual(["a", "c"]);
    resolvers.get("c")?.("C");

    await expect(first).resolves.toEqual({ status: "cancelled", reason: "superseded" });
    await expect(nested).resolves.toEqual({ status: "cancelled", reason: "superseded" });
    await expect(current).resolves.toEqual({ status: "success", data: "C" });
    expect(resource.data()).toBe("C");
    expect(resource.loading()).toBe(false);
    resource.dispose();
  });

  it("detaches a resource before a throwing dispose notification", () => {
    const notificationError = new Error("dispose notification failed");
    let resource!: ReturnType<typeof createResource<string, string>>;
    const disposeRoot = createRoot((dispose) => {
      resource = createResource("source", () => new Promise<string>(() => undefined));
      effect(() => {
        if (!resource.loading()) {
          throw notificationError;
        }
      });
      return dispose;
    });

    expect(() => resource.dispose()).toThrow(notificationError);
    expect(() => resource.dispose()).not.toThrow();
    expect(() => disposeRoot()).not.toThrow();
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
