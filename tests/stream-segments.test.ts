import { describe, expect, it } from "vitest";

import { closeAsyncIterable, composeSingleOutlet } from "../src/stream-segments";

const returnlessSource = (values: readonly string[]): { source: AsyncIterable<string>; nextCalls: () => number } => {
  let index = 0;
  let calls = 0;
  const iterator: AsyncIterableIterator<string> = {
    [Symbol.asyncIterator]: () => iterator,
    next: async () => {
      calls += 1;
      if (index < values.length) return { done: false, value: values[index++] as string };
      if (index === values.length) {
        index += 1;
        return { done: true, value: undefined };
      }
      throw new Error("source read after completion");
    },
  };
  return { source: { [Symbol.asyncIterator]: () => iterator }, nextCalls: () => calls };
};

const closeableSource = (): { source: AsyncIterable<string>; returnCalls: () => number } => {
  let calls = 0;
  const iterator: AsyncIterableIterator<string> = {
    [Symbol.asyncIterator]: () => iterator,
    next: async () => ({ done: true, value: undefined }),
    return: async () => {
      calls += 1;
      return { done: true, value: undefined };
    },
  };
  return { source: { [Symbol.asyncIterator]: () => iterator }, returnCalls: () => calls };
};

describe("single-outlet stream lifecycle", () => {
  it("closes a valid return-less source without throwing", async () => {
    const tracked = returnlessSource([]);
    await expect(closeAsyncIterable(tracked.source)).resolves.toBeUndefined();
  });

  it("emits each phase once and remains terminal", async () => {
    const tracked = returnlessSource(["source"]);
    const composed = await composeSingleOutlet(tracked.source, {
      before: "before",
      after: "after",
      outlet: "once",
    });
    const iterator = composed[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ done: false, value: "before" });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: "source" });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: "after" });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(tracked.nextCalls()).toBe(2);
  });

  it("returns an exact terminal result and closes the source at most once", async () => {
    const tracked = closeableSource();
    const composed = await composeSingleOutlet(tracked.source, { before: "", after: "", outlet: "once" });
    const iterator = composed[Symbol.asyncIterator]();

    await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined });
    await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(tracked.returnCalls()).toBe(1);
  });

  it("does not close the source again after natural completion", async () => {
    const tracked = closeableSource();
    const composed = await composeSingleOutlet(tracked.source, { before: "", after: "", outlet: "once" });
    const iterator = composed[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined });
    expect(tracked.returnCalls()).toBe(0);
  });

  it("cancels a partially consumed return-less source without throwing", async () => {
    const tracked = returnlessSource(["source"]);
    const composed = await composeSingleOutlet(tracked.source, { before: "", after: "", outlet: "once" });
    const iterator = composed[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ done: false, value: "source" });
    await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined });
  });
});
