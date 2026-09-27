import { describe, expect, it } from "vitest";
import { createResourceBoundary } from "../src/runtime/resource-boundary";
import { createRoot, createSignal, onCleanup } from "../src/runtime/signal";

const node = (tag: string, text: string): HTMLElement => {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
};

describe("resource boundary", () => {
  it("replaces pending with success and keeps the old view during refetch", async () => {
    const requests: Array<{ resolve: (value: string) => void; signal: AbortSignal }> = [];
    const root = document.createElement("div");
    let disposedViews = 0;
    const boundary = createResourceBoundary(
      root,
      "item",
      (_, { signal }) => new Promise<string>((resolve) => requests.push({ resolve, signal })),
      {
        pending: () => node("p", "Loading"),
        success: (value) => {
          onCleanup(() => disposedViews++);
          return node("article", value);
        },
        error: () => node("p", "Error"),
        refreshing: () => node("small", "Updating"),
      },
    );
    expect(root.textContent).toBe("Loading");
    expect(boundary.resource.hasValue()).toBe(false);
    const initial = boundary.resource.refetchOutcome();
    await Promise.resolve();
    requests[0]?.resolve("First");
    expect(await initial).toEqual({ status: "success", data: "First" });
    const first = root.querySelector("article");
    expect(first?.textContent).toBe("First");
    expect(boundary.resource.hasValue()).toBe(true);

    const refresh = boundary.resource.refetchOutcome();
    expect(root.querySelector("article")).toBe(first);
    expect(root.textContent).toBe("FirstUpdating");
    expect(disposedViews).toBe(0);
    await Promise.resolve();
    requests[1]?.resolve("Second");
    expect(await refresh).toEqual({ status: "success", data: "Second" });
    expect(root.querySelector("article")?.textContent).toBe("Second");
    expect(root.querySelector("article")).not.toBe(first);
    expect(disposedViews).toBe(1);

    boundary.dispose();
    expect(disposedViews).toBe(2);
  });

  it("shows errors, retries, and treats undefined as a successful value", async () => {
    const requests: Array<{ resolve: (value: undefined) => void; reject: (reason: unknown) => void }> = [];
    const root = document.createElement("div");
    let retry: (() => Promise<unknown>) | undefined;
    const boundary = createResourceBoundary(
      root,
      "item",
      () => new Promise<undefined>((resolve, reject) => requests.push({ resolve, reject })),
      {
        pending: () => node("p", "Loading"),
        success: (value) => node("article", value === undefined ? "Empty result" : "Unexpected"),
        error: (_error, next) => {
          retry = next;
          return node("button", "Retry");
        },
      },
    );
    const initial = boundary.resource.refetchOutcome();
    await Promise.resolve();
    requests[0]?.reject(undefined);
    expect((await initial).status).toBe("error");
    expect(boundary.resource.hasError()).toBe(true);
    expect(root.querySelector("button")?.textContent).toBe("Retry");
    const outcome = retry?.();
    expect(root.textContent).toBe("Loading");
    await Promise.resolve();
    requests[1]?.resolve(undefined);
    expect(await outcome).toEqual({ status: "success", data: undefined });
    expect(root.querySelector("article")?.textContent).toBe("Empty result");
    expect(boundary.resource.hasValue()).toBe(true);
    expect(boundary.resource.hasError()).toBe(false);
    boundary.dispose();
  });

  it("keeps stale content after a refetch error and replaces its status on retry", async () => {
    const requests: Array<{ resolve: (value: string) => void; reject: (reason: unknown) => void }> = [];
    const root = document.createElement("div");
    let retry: (() => Promise<unknown>) | undefined;
    let statusCleanups = 0;
    const boundary = createResourceBoundary(
      root,
      "item",
      () => new Promise<string>((resolve, reject) => requests.push({ resolve, reject })),
      {
        pending: () => node("p", "Loading"),
        success: (value) => node("article", value),
        error: (_reason, next) => {
          retry = next;
          onCleanup(() => statusCleanups++);
          return node("button", "Retry");
        },
        refreshing: () => {
          onCleanup(() => statusCleanups++);
          return node("small", "Updating");
        },
      },
    );
    const initial = boundary.resource.refetchOutcome();
    await Promise.resolve();
    requests[0]?.resolve("Old");
    await initial;
    const article = root.querySelector("article");

    const failedRefresh = boundary.resource.refetchOutcome();
    await Promise.resolve();
    requests[1]?.reject(new Error("offline"));
    expect((await failedRefresh).status).toBe("error");
    expect(root.querySelector("article")).toBe(article);
    expect(root.textContent).toBe("OldRetry");
    expect(statusCleanups).toBe(1);

    const recovered = retry?.();
    expect(root.querySelector("article")).toBe(article);
    expect(root.textContent).toBe("OldUpdating");
    expect(statusCleanups).toBe(2);
    await Promise.resolve();
    requests[2]?.resolve("New");
    expect(await recovered).toEqual({ status: "success", data: "New" });
    expect(root.textContent).toBe("New");
    expect(statusCleanups).toBe(3);
    boundary.dispose();
  });

  it("aborts superseded and disposed requests without displaying stale results", async () => {
    const source = createSignal("first");
    const requests: Array<{ key: string; signal: AbortSignal; resolve: (value: string) => void }> = [];
    const root = document.createElement("div");
    const boundary = createResourceBoundary(
      root,
      source,
      (key, { signal }) => new Promise<string>((resolve) => requests.push({ key, signal, resolve })),
      { pending: () => node("p", "Loading"), success: (value) => node("p", value), error: () => node("p", "Error") },
    );
    await Promise.resolve();
    source.set("second");
    await Promise.resolve();
    expect(requests[0]?.signal.aborted).toBe(true);
    requests[0]?.resolve("stale");
    expect(root.textContent).toBe("Loading");

    boundary.dispose();
    expect(requests[1]?.signal.aborted).toBe(true);
    requests[1]?.resolve("after dispose");
    await Promise.resolve();
    expect(root.textContent).toBe("Loading");
  });

  it("releases its request and rendered view when the parent owner is disposed", async () => {
    const root = document.createElement("div");
    let signal: AbortSignal | undefined;
    let cleanupCount = 0;
    const disposeParent = createRoot((dispose) => {
      createResourceBoundary(
        root,
        "item",
        (_, context) => {
          signal = context.signal;
          return new Promise<string>(() => undefined);
        },
        {
          pending: () => {
            onCleanup(() => cleanupCount++);
            return node("p", "Loading");
          },
          success: (value) => node("p", value),
          error: () => node("p", "Error"),
        },
      );
      return dispose;
    });
    await Promise.resolve();
    expect(signal?.aborted).toBe(false);
    disposeParent();
    expect(signal?.aborted).toBe(true);
    expect(cleanupCount).toBe(1);
  });
});
