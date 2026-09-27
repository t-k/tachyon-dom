import { describe, expect, it, vi } from "vitest";
import { createRoot } from "../src/runtime/signal";
import { createQueryClient } from "../src/runtime/query-client";

const tick = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("query client", () => {
  it("shares a request and keeps it alive while another observer is active", async () => {
    let resolve!: (value: string) => void;
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn((_key: string, context: { signal: AbortSignal }) => {
      signal = context.signal;
      return new Promise<string>((done) => (resolve = done));
    });
    const client = createQueryClient();
    const first = createRoot((dispose) => ({ query: client.observe("user:1", fetcher), dispose }));
    const second = createRoot((dispose) => ({ query: client.observe("user:1", fetcher), dispose }));
    await tick();
    expect(fetcher).toHaveBeenCalledTimes(1);
    first.dispose();
    expect(signal?.aborted).toBe(false);
    resolve("Ada");
    await tick();
    expect(second.query.data()).toBe("Ada");
    expect(second.query.hasValue()).toBe(true);
    second.dispose();
    client.dispose();
  });

  it("invalidates only the selected key and refreshes active observers", async () => {
    const fetcher = vi.fn(
      async (key: string) => `${key}:${fetcher.mock.calls.filter(([item]) => item === key).length}`,
    );
    const client = createQueryClient();
    const first = client.observe("a", fetcher);
    const second = client.observe("b", fetcher);
    await Promise.all([first.refetch(), second.refetch()]);
    expect(first.data()).toBe("a:1");
    expect(second.data()).toBe("b:1");
    await client.invalidate("a");
    expect(first.data()).toBe("a:2");
    expect(second.data()).toBe("b:1");
    expect(fetcher).toHaveBeenCalledTimes(3);
    first.dispose();
    second.dispose();
    client.dispose();
  });

  it("keeps stale data visible during a refresh and refetches after the freshness window", async () => {
    vi.useFakeTimers();
    try {
      const resolvers: Array<(value: string) => void> = [];
      const fetcher = vi.fn(() => new Promise<string>((resolve) => resolvers.push(resolve)));
      const client = createQueryClient();
      const first = client.observe("item", fetcher, { staleTime: 1000 });
      await tick();
      resolvers[0]?.("first");
      await tick();
      first.dispose();
      vi.setSystemTime(Date.now() + 500);
      const fresh = client.observe("item", fetcher, { staleTime: 1000 });
      await tick();
      expect(fetcher).toHaveBeenCalledTimes(1);
      fresh.dispose();
      vi.setSystemTime(Date.now() + 1000);
      const stale = client.observe("item", fetcher, { staleTime: 1000 });
      await tick();
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(stale.data()).toBe("first");
      expect(stale.loading()).toBe(true);
      resolvers[1]?.("second");
      await tick();
      expect(stale.data()).toBe("second");
      stale.dispose();
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renews freshness after an equal successful response", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(async () => "same");
      const client = createQueryClient();
      const initial = client.observe("item", fetcher, { staleTime: 1000 });
      await initial.refetch();
      initial.dispose();
      vi.setSystemTime(Date.now() + 1000);
      const refresh = client.observe("item", fetcher, { staleTime: 1000 });
      await refresh.refetch();
      expect(fetcher).toHaveBeenCalledTimes(2);
      refresh.dispose();
      vi.setSystemTime(Date.now() + 500);
      const fresh = client.observe("item", fetcher, { staleTime: 1000 });
      for (let index = 0; index < 8; index++) await Promise.resolve();
      expect(fetcher).toHaveBeenCalledTimes(2);
      fresh.dispose();
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not renew freshness after a failed refetch", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const fetcher = vi.fn(async () => {
        attempts++;
        if (attempts === 2) throw new Error("offline");
        return "saved";
      });
      const client = createQueryClient();
      const initial = client.observe("item", fetcher, { staleTime: 1000 });
      await initial.refetch();
      initial.dispose();
      vi.setSystemTime(Date.now() + 1000);
      const failed = client.observe("item", fetcher, { staleTime: 1000 });
      await expect(failed.refetch()).resolves.toMatchObject({ status: "error" });
      expect(failed.data()).toBe("saved");
      failed.dispose();
      vi.setSystemTime(Date.now() + 500);
      const retried = client.observe("item", fetcher, { staleTime: 1000 });
      await retried.refetch();
      expect(fetcher).toHaveBeenCalledTimes(3);
      retried.dispose();
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies an optimistic value, rolls back failures, and ignores an older failure", async () => {
    const client = createQueryClient();
    const query = client.observe("count", async () => 1);
    await query.refetch();
    let rejectOld!: (error: Error) => void;
    const old = client.mutate(
      "count",
      (value: number | undefined) => (value ?? 0) + 1,
      () => new Promise<number>((_, reject) => (rejectOld = reject)),
    );
    expect(query.data()).toBe(2);
    const newer = client.mutate(
      "count",
      (value: number | undefined) => (value ?? 0) + 10,
      async () => 12,
    );
    expect(query.data()).toBe(12);
    await expect(newer).resolves.toBe(12);
    rejectOld(new Error("old failed"));
    await expect(old).rejects.toThrow("old failed");
    expect(query.data()).toBe(12);
    await expect(
      client.mutate(
        "count",
        (value: number | undefined) => (value ?? 0) + 1,
        async () => {
          throw new Error("failed");
        },
      ),
    ).rejects.toThrow("failed");
    expect(query.data()).toBe(12);
    query.dispose();
    client.dispose();
  });

  it("rolls back to the last committed value when a newer mutation fails", async () => {
    const client = createQueryClient();
    const query = client.observe("count", async () => 1);
    await query.refetch();
    let resolveOld!: (value: number) => void;
    const older = client.mutate(
      "count",
      (value: number | undefined) => (value ?? 0) + 1,
      () => new Promise<number>((resolve) => (resolveOld = resolve)),
    );
    const newer = client.mutate(
      "count",
      (value: number | undefined) => (value ?? 0) + 10,
      async () => {
        throw new Error("failed");
      },
    );
    expect(query.data()).toBe(12);
    await expect(newer).rejects.toThrow("failed");
    expect(query.data()).toBe(1);
    resolveOld(2);
    await expect(older).resolves.toBe(2);
    expect(query.data()).toBe(1);
    query.dispose();
    client.dispose();
  });

  it("invalidates related active queries after a successful commit", async () => {
    let profileVersion = 0;
    const client = createQueryClient();
    const user = client.observe("user:1", async () => ({ name: "Ada" }));
    const profile = client.observe("profile:1", async () => ++profileVersion);
    await Promise.all([user.refetch(), profile.refetch()]);
    await client.mutate(
      "user:1",
      (current: { name: string } | undefined) => ({ name: `${current?.name ?? ""}*` }),
      async () => ({ name: "Grace" }),
      ["profile:1"],
    );
    expect(user.data()).toEqual({ name: "Grace" });
    await tick();
    expect(profile.data()).toBe(2);
    user.dispose();
    profile.dispose();
    client.dispose();
  });

  it("keeps request and user caches isolated by client instance", async () => {
    const fetcher = vi.fn(async () => "data");
    const first = createQueryClient();
    const second = createQueryClient();
    const firstQuery = first.observe("same-key", fetcher);
    const secondQuery = second.observe("same-key", fetcher);
    await tick();
    expect(fetcher).toHaveBeenCalledTimes(2);
    firstQuery.dispose();
    secondQuery.dispose();
    first.dispose();
    second.dispose();
  });

  it("aborts pending work when the owning client is disposed", async () => {
    let signal: AbortSignal | undefined;
    const client = createQueryClient();
    client.observe("slow", (_key, context) => {
      signal = context.signal;
      return new Promise<string>(() => undefined);
    });
    await tick();
    expect(signal?.aborted).toBe(false);
    client.dispose();
    expect(signal?.aborted).toBe(true);
    expect(() => client.observe("slow", async () => "late")).toThrow("Cannot observe a disposed query client.");
  });

  it("does not refetch through a released observer", async () => {
    const fetcher = vi.fn(async () => 1);
    const client = createQueryClient();
    const query = client.observe("key", fetcher);
    await query.refetch();
    query.dispose();
    await expect(query.refetch()).resolves.toMatchObject({ status: "cancelled" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    client.dispose();
  });

  it("defers inactive invalidation and refetches related keys on the next observation", async () => {
    const fetcher = vi.fn(
      async (key: string) => `${key}:${fetcher.mock.calls.filter(([item]) => item === key).length}`,
    );
    const client = createQueryClient();
    const user = client.observe("user:1", fetcher, { staleTime: 100000 });
    const article = client.observe("article:1", fetcher, { staleTime: 100000 });
    await Promise.all([user.refetch(), article.refetch()]);
    user.dispose();
    article.dispose();
    await client.invalidateWhere((key) => key.startsWith("user:"));
    expect(fetcher).toHaveBeenCalledTimes(2);
    const reobservedUser = client.observe("user:1", fetcher, { staleTime: 100000 });
    const reobservedArticle = client.observe("article:1", fetcher, { staleTime: 100000 });
    for (let index = 0; index < 8; index++) await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(reobservedUser.data()).toBe("user:1:2");
    expect(reobservedArticle.data()).toBe("article:1:1");
    reobservedUser.dispose();
    reobservedArticle.dispose();
    client.dispose();
  });

  it("keeps an initial query pending and recognizes a successful undefined value", async () => {
    let resolve!: (value: undefined) => void;
    const client = createQueryClient();
    const query = client.observe("optional", () => new Promise<undefined>((done) => (resolve = done)));
    expect(query.hasValue()).toBe(false);
    await tick();
    expect(query.loading()).toBe(true);
    resolve(undefined);
    await query.refetch();
    expect(query.hasValue()).toBe(true);
    expect(query.data()).toBeUndefined();
    query.dispose();
    client.dispose();
  });

  it("rejects invalid freshness and mutation keys", async () => {
    const client = createQueryClient();
    for (const staleTime of [-1, Infinity, NaN]) {
      expect(() => client.observe("bad", async () => 1, { staleTime })).toThrow(
        "staleTime must be a nonnegative finite number.",
      );
    }
    await expect(client.invalidate("missing")).resolves.toBeUndefined();
    await expect(
      client.mutate(
        "missing",
        () => 1,
        async () => 1,
      ),
    ).rejects.toThrow("No query is registered for missing.");
    client.dispose();
    await expect(
      client.mutate(
        "missing",
        () => 1,
        async () => 1,
      ),
    ).rejects.toThrow("Cannot mutate a disposed query client.");
  });

  it("does not let a background refetch overwrite a pending optimistic value", async () => {
    const resolvers: Array<(value: number) => void> = [];
    const client = createQueryClient();
    const query = client.observe("count", () => new Promise<number>((resolve) => resolvers.push(resolve)));
    await tick();
    resolvers[0]?.(1);
    await query.refetch();
    const refresh = query.refetch();
    await tick();
    let resolveCommit!: (value: number) => void;
    const commit = client.mutate(
      "count",
      (value: number | undefined) => (value ?? 0) + 1,
      () => new Promise<number>((resolve) => (resolveCommit = resolve)),
    );
    expect(query.data()).toBe(2);
    resolvers[1]?.(99);
    await refresh;
    expect(query.data()).toBe(2);
    resolveCommit(3);
    await commit;
    expect(query.data()).toBe(3);
    query.dispose();
    client.dispose();
  });

  it("does not let a request started before a committed mutation overwrite its result", async () => {
    const resolvers: Array<(value: number) => void> = [];
    const client = createQueryClient();
    const query = client.observe("count", () => new Promise<number>((resolve) => resolvers.push(resolve)));
    await tick();
    resolvers[0]?.(1);
    await query.refetch();
    const oldRefresh = query.refetch();
    await tick();
    await client.mutate(
      "count",
      (value: number | undefined) => (value ?? 0) + 1,
      async () => 3,
    );
    expect(query.data()).toBe(3);
    resolvers[1]?.(2);
    await oldRefresh;
    expect(query.data()).toBe(3);
    query.dispose();
    client.dispose();
  });

  it("does not expose an old request error after a successful commit", async () => {
    let rejectRefresh!: (error: Error) => void;
    let attempts = 0;
    const client = createQueryClient();
    const query = client.observe("count", () => {
      attempts++;
      return attempts === 1 ? Promise.resolve(1) : new Promise<number>((_, reject) => (rejectRefresh = reject));
    });
    await query.refetch();
    const oldRefresh = query.refetch();
    await tick();
    await client.mutate(
      "count",
      (value: number | undefined) => (value ?? 0) + 1,
      async () => 3,
    );
    rejectRefresh(new Error("old offline error"));
    await expect(oldRefresh).resolves.toMatchObject({ status: "error" });
    expect(query.data()).toBe(3);
    expect(query.hasError()).toBe(false);
    expect(query.error()).toBeUndefined();
    query.dispose();
    client.dispose();
  });

  it("reports a current fetch error, clears it while retrying, and accepts the retry", async () => {
    let attempts = 0;
    let resolveRetry!: (value: number) => void;
    const client = createQueryClient();
    const query = client.observe("count", () => {
      attempts++;
      return attempts === 1
        ? Promise.reject(new Error("offline"))
        : new Promise<number>((resolve) => (resolveRetry = resolve));
    });
    expect(query.hasError()).toBe(false);
    await query.refetch();
    expect(query.hasError()).toBe(true);
    expect(query.error()).toBeInstanceOf(Error);
    const retry = query.refetch();
    expect(query.loading()).toBe(true);
    expect(query.hasError()).toBe(false);
    await tick();
    resolveRetry(2);
    await retry;
    expect(query.data()).toBe(2);
    expect(query.hasError()).toBe(false);
    expect(query.error()).toBeUndefined();
    query.dispose();
    client.dispose();
  });

  it("accepts a new result after discarding an old result from before a mutation", async () => {
    const resolvers: Array<(value: number) => void> = [];
    const client = createQueryClient();
    const query = client.observe("count", () => new Promise<number>((resolve) => resolvers.push(resolve)));
    await tick();
    resolvers[0]?.(1);
    await query.refetch();
    const oldRefresh = query.refetch();
    await tick();
    await client.mutate(
      "count",
      () => 3,
      async () => 3,
    );
    resolvers[1]?.(2);
    await oldRefresh;
    expect(query.data()).toBe(3);
    const freshRefresh = query.refetch();
    await tick();
    resolvers[2]?.(4);
    await freshRefresh;
    expect(query.data()).toBe(4);
    query.dispose();
    client.dispose();
  });

  it("treats the freshness deadline as stale and releases owner observers exactly once", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(async () => fetcher.mock.calls.length);
      const client = createQueryClient();
      const owned = createRoot((dispose) => ({ query: client.observe("key", fetcher, { staleTime: 1000 }), dispose }));
      await owned.query.refetch();
      expect(owned.query.data()).toBe(1);
      owned.dispose();
      await client.invalidate("key");
      expect(fetcher).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 1000);
      const second = client.observe("key", fetcher, { staleTime: 1000 });
      await second.refetch();
      expect(fetcher).toHaveBeenCalledTimes(2);
      second.dispose();
      second.dispose();
      vi.setSystemTime(Date.now() + 1000);
      const third = client.observe("key", fetcher, { staleTime: 1000 });
      for (let index = 0; index < 8; index++) await Promise.resolve();
      expect(fetcher).toHaveBeenCalledTimes(3);
      await client.invalidate("key");
      expect(fetcher).toHaveBeenCalledTimes(4);
      third.dispose();
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("commits an optimistic value before an initial fetch has returned", async () => {
    const client = createQueryClient();
    const query = client.observe("slow", () => new Promise<number>(() => undefined));
    expect(query.hasValue()).toBe(false);
    await expect(
      client.mutate(
        "slow",
        () => 3,
        async () => 4,
      ),
    ).resolves.toBe(4);
    expect(query.hasValue()).toBe(true);
    expect(query.data()).toBe(4);
    query.dispose();
    client.dispose();
  });

  it("restores the absence of data when an initial optimistic commit fails", async () => {
    const client = createQueryClient();
    const query = client.observe("slow", () => new Promise<number>(() => undefined));
    expect(query.hasValue()).toBe(false);
    const mutation = client.mutate(
      "slow",
      () => 1,
      async () => {
        throw new Error("failed");
      },
    );
    expect(query.hasValue()).toBe(true);
    await expect(mutation).rejects.toThrow("failed");
    expect(query.hasValue()).toBe(false);
    expect(query.data()).toBeUndefined();
    query.dispose();
    client.dispose();
  });
});
