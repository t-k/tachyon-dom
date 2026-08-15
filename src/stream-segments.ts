export type SingleOutletSegments = {
  before: string;
  after: string;
  outlet: "once" | "omit";
};

const staticSegments = (before: string, after: string): AsyncIterable<string> =>
  (async function* () {
    if (before) yield before;
    if (after) yield after;
  })();

export const closeAsyncIterable = async (source: AsyncIterable<string>): Promise<void> => {
  const iterator = source[Symbol.asyncIterator]();
  await iterator.return?.();
};

export const composeSingleOutlet = async (
  source: AsyncIterable<string>,
  segments: SingleOutletSegments,
): Promise<AsyncIterable<string>> => {
  if (segments.outlet === "omit") {
    await closeAsyncIterable(source);
    return staticSegments(segments.before, segments.after);
  }

  const sourceIterator = source[Symbol.asyncIterator]();
  let phase: "before" | "source" | "after" | "done" = "before";
  let sourceDone = false;
  let sourceReturned = false;
  const closeSource = async (): Promise<void> => {
    if (sourceDone || sourceReturned) return;
    sourceReturned = true;
    try {
      await sourceIterator.return?.();
    } finally {
      sourceDone = true;
    }
  };
  const iterator: AsyncIterableIterator<string> = {
    [Symbol.asyncIterator]: () => iterator,
    next: async () => {
      while (true) {
        if (phase === "before") {
          phase = "source";
          if (segments.before) return { done: false, value: segments.before };
        }
        if (phase === "source") {
          try {
            const next = await sourceIterator.next();
            if (!next.done) return next;
            sourceDone = true;
            phase = "after";
          } catch (error) {
            await closeSource();
            phase = "done";
            throw error;
          }
        }
        if (phase === "after") {
          phase = "done";
          if (segments.after) return { done: false, value: segments.after };
        }
        return { done: true, value: undefined };
      }
    },
    return: async () => {
      await closeSource();
      phase = "done";
      return { done: true, value: undefined };
    },
  };
  return iterator;
};
