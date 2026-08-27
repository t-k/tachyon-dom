import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { composeSingleOutlet } from "../src/stream-segments";
import { propertyParameters } from "./fast-check-config";

type Tracker = {
  nextCalls: number;
  returnCalls: number;
};

const trackedSource = (
  values: readonly string[],
  failAt?: number,
): { source: AsyncIterable<string>; tracker: Tracker } => {
  let index = 0;
  const tracker: Tracker = { nextCalls: 0, returnCalls: 0 };
  const iterator: AsyncIterableIterator<string> = {
    [Symbol.asyncIterator]: () => iterator,
    next: async () => {
      tracker.nextCalls += 1;
      if (index === failAt) throw new Error("source failed");
      if (index < values.length) return { done: false, value: values[index++] as string };
      return { done: true, value: undefined };
    },
    return: async () => {
      tracker.returnCalls += 1;
      return { done: true, value: undefined };
    },
  };
  return { source: { [Symbol.asyncIterator]: () => iterator }, tracker };
};

const collect = async (source: AsyncIterable<string>, maxChunks = Number.POSITIVE_INFINITY): Promise<string[]> => {
  const output: string[] = [];
  const iterator = source[Symbol.asyncIterator]();
  while (true) {
    const next = await iterator.next();
    if (next.done) return output;
    if (output.length === maxChunks) throw new Error(`stream exceeded ${maxChunks} chunks`);
    output.push(next.value);
  }
};

const chunk = fc.string({ unit: "grapheme", maxLength: 16 });

describe("single-outlet stream composition properties", () => {
  it("emits framing and enumerates an included source once", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(chunk, { maxLength: 6 }), chunk, chunk, async (values, before, after) => {
        const tracked = trackedSource(values);
        const composed = await composeSingleOutlet(tracked.source, { before, after, outlet: "once" });
        const expected = [...(before ? [before] : []), ...values, ...(after ? [after] : [])];
        expect(await collect(composed, expected.length)).toEqual(expected);
        expect(tracked.tracker.nextCalls).toBe(values.length + 1);
        expect(tracked.tracker.returnCalls).toBe(0);
      }),
      propertyParameters(),
    );
  });

  it("closes an omitted source without pulling it", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(chunk, { maxLength: 6 }), chunk, chunk, async (values, before, after) => {
        const tracked = trackedSource(values);
        const composed = await composeSingleOutlet(tracked.source, { before, after, outlet: "omit" });
        expect(await collect(composed)).toEqual([...(before ? [before] : []), ...(after ? [after] : [])]);
        expect(tracked.tracker.nextCalls).toBe(0);
        expect(tracked.tracker.returnCalls).toBe(1);
      }),
      propertyParameters(),
    );
  });

  it("propagates early return to an unconsumed source exactly once", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(chunk, { minLength: 1, maxLength: 6 }), async (values) => {
        const tracked = trackedSource(values);
        const composed = await composeSingleOutlet(tracked.source, {
          before: "prefix",
          after: "suffix",
          outlet: "once",
        });
        const iterator = composed[Symbol.asyncIterator]();
        await expect(iterator.next()).resolves.toEqual({ done: false, value: "prefix" });
        await iterator.return?.();
        await iterator.return?.();
        expect(tracked.tracker.nextCalls).toBe(0);
        expect(tracked.tracker.returnCalls).toBe(1);
      }),
      propertyParameters(),
    );
  });

  it("closes a partially consumed source once under concurrent returns", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(chunk, { minLength: 1, maxLength: 6 }), async (values) => {
        const tracked = trackedSource(values);
        const composed = await composeSingleOutlet(tracked.source, { before: "", after: "suffix", outlet: "once" });
        const iterator = composed[Symbol.asyncIterator]();
        await expect(iterator.next()).resolves.toEqual({ done: false, value: values[0] });
        await Promise.all([iterator.return?.(), iterator.return?.()]);
        expect(tracked.tracker.nextCalls).toBe(1);
        expect(tracked.tracker.returnCalls).toBe(1);
      }),
      propertyParameters(),
    );
  });

  it("closes a failing source exactly once", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(chunk, { minLength: 1, maxLength: 6 }), fc.nat(), async (values, offset) => {
        const failAt = offset % values.length;
        const tracked = trackedSource(values, failAt);
        const composed = await composeSingleOutlet(tracked.source, { before: "", after: "", outlet: "once" });
        await expect(collect(composed)).rejects.toThrow("source failed");
        expect(tracked.tracker.returnCalls).toBe(1);
      }),
      propertyParameters(),
    );
  });
});
