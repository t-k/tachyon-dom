import { describe, expect, it, vi } from "vitest";
import {
  createHydrationBoundary,
  createLazyHydrationBoundary,
  diagnoseHydrationBoundaries,
  isReplayedInteraction,
  locateHydrationBoundary,
  readHydrationState,
  reportHydrationDiagnostics,
  scheduleHydrationBoundaries,
  scheduleHydration,
  serializeHydrationState,
} from "../src/runtime/hydrate";

describe("hydrate boundary runtime", () => {
  it("locates SSR marker pairs without changing the rendered HTML", () => {
    document.body.innerHTML = `<main><!--tachyon-hydrate:counter:start--><section><button>7</button></section><!--tachyon-hydrate:counter:end--></main>`;
    const main = document.querySelector("main");
    if (!main) {
      throw new Error("Missing main.");
    }
    const before = main.innerHTML;

    const result = locateHydrationBoundary(main, "counter");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.value.element.tagName).toBe("SECTION");
    expect(main.innerHTML).toBe(before);
  });

  it("hydrates a boundary lazily and keeps hydration idempotent", () => {
    document.body.innerHTML = `<main><!--tachyon-hydrate:counter:start--><section><button>7</button></section><!--tachyon-hydrate:counter:end--></main>`;
    const main = document.querySelector("main");
    if (!main) {
      throw new Error("Missing main.");
    }
    const bind = vi.fn((element: Element) => {
      const button = element.querySelector("button");
      button?.addEventListener("click", () => {
        button.textContent = "8";
      });
    });

    const handleResult = createHydrationBoundary(main, "counter", bind);
    expect(handleResult.ok).toBe(true);
    if (!handleResult.ok) {
      throw new Error(handleResult.error.message);
    }
    const handle = handleResult.value;
    const button = main.querySelector("button");

    button?.click();
    expect(button?.textContent).toBe("7");
    expect(handle.hydrated()).toBe(false);

    handle.hydrate();
    handle.hydrate();
    button?.click();

    expect(bind).toHaveBeenCalledTimes(1);
    expect(handle.hydrated()).toBe(true);
    expect(button?.textContent).toBe("8");
  });

  it("disposes a hydrated boundary once even when disposed repeatedly", () => {
    document.body.innerHTML = `<main><!--tachyon-hydrate:counter:start--><section></section><!--tachyon-hydrate:counter:end--></main>`;
    const main = document.querySelector("main");
    if (!main) throw new Error("Missing main.");
    const cleanup = vi.fn();
    const result = createHydrationBoundary(main, "counter", () => cleanup);
    if (!result.ok) throw new Error(result.error.message);

    result.value.hydrate();
    result.value.dispose();
    result.value.dispose();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(result.value.hydrated()).toBe(false);
  });

  it("serializes and reads hydration state without changing boundary DOM", () => {
    document.body.innerHTML = `<main><!--tachyon-hydrate:counter:start--><section><button>7</button></section><!--tachyon-hydrate:counter:end-->${serializeHydrationState("counter", { count: 7, rows: ["a", "<b>"] })}</main>`;
    const main = document.querySelector("main");
    if (!main) {
      throw new Error("Missing main.");
    }
    const boundaryBefore = main.querySelector("section")?.outerHTML;

    const result = readHydrationState<{ count: number; rows: string[] }>(main, "counter");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.value).toEqual({ count: 7, rows: ["a", "<b>"] });
    expect(main.querySelector("section")?.outerHTML).toBe(boundaryBefore);
  });

  it("serializes comment-close text and undefined state as valid JSON", () => {
    document.body.innerHTML = `<main>${serializeHydrationState("article", { body: "before --> after" })}${serializeHydrationState("empty", undefined)}</main>`;
    const main = document.querySelector("main");
    if (!main) {
      throw new Error("Missing main.");
    }

    const article = readHydrationState<{ body: string }>(main, "article");
    const empty = readHydrationState<null>(main, "empty");

    expect(article.ok && article.value).toEqual({ body: "before --> after" });
    expect(empty.ok && empty.value).toBe(null);
  });

  it("serializes script-close text without allowing script breakout", () => {
    const serialized = serializeHydrationState("article", { body: `</script><img src=x onerror=alert(1)>` });
    document.body.innerHTML = `<main>${serialized}</main>`;
    const main = document.querySelector("main");
    if (!main) {
      throw new Error("Missing main.");
    }

    const article = readHydrationState<{ body: string }>(main, "article");

    expect(serialized).toContain(String.raw`\u003c/script\u003e\u003cimg`);
    expect(serialized).not.toContain(`</script><img`);
    expect(main.querySelector("img")).toBeNull();
    expect(article.ok && article.value).toEqual({ body: `</script><img src=x onerror=alert(1)>` });
  });

  it("schedules idle, media, and interaction hydration strategies", () => {
    document.body.innerHTML = `<main><!--tachyon-hydrate:panel:start--><section><button>Open</button></section><!--tachyon-hydrate:panel:end--></main>`;
    const main = document.querySelector("main");
    if (!main) {
      throw new Error("Missing main.");
    }
    const handleResult = createHydrationBoundary(main, "panel", vi.fn());
    expect(handleResult.ok).toBe(true);
    if (!handleResult.ok) {
      throw new Error(handleResult.error.message);
    }
    const handle = handleResult.value;

    const idleCleanup = scheduleHydration(handle, { strategy: "idle" });
    idleCleanup();
    expect(handle.hydrated()).toBe(false);

    const mediaCleanup = scheduleHydration(handle, {
      strategy: "media",
      media: "(min-width: 1px)",
      matchMedia: () =>
        ({
          matches: true,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList,
    });
    mediaCleanup();
    expect(handle.hydrated()).toBe(true);

    const secondResult = createHydrationBoundary(main, "panel", vi.fn());
    if (!secondResult.ok) {
      throw new Error(secondResult.error.message);
    }
    const cleanup = scheduleHydration(secondResult.value, { strategy: "interaction", interaction: "click" });
    main.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(secondResult.value.hydrated()).toBe(true);
    cleanup();
  });

  it("diagnoses missing and duplicate hydration boundary markers", () => {
    document.body.innerHTML = `
      <!--tachyon-hydrate:a:start--><section></section><!--tachyon-hydrate:a:end-->
      <!--tachyon-hydrate:a:start--><section></section><!--tachyon-hydrate:a:end-->
      <!--tachyon-hydrate:b:start--><section></section>
    `;

    expect(diagnoseHydrationBoundaries(document.body, ["a", "b", "c"])).toEqual([
      { id: "a", type: "duplicate", message: "Duplicate hydrate boundary markers for a." },
      { id: "b", type: "missing-end", message: "Missing hydrate boundary end marker for b." },
      { id: "c", type: "missing-start", message: "Missing hydrate boundary start marker for c." },
      { id: "c", type: "missing-end", message: "Missing hydrate boundary end marker for c." },
    ]);
  });

  it("reports hydration diagnostics to a Vite-style dev overlay", () => {
    document.body.innerHTML = `<main><!--tachyon-hydrate:panel:start--></main>`;
    const main = document.querySelector("main");
    if (!main) {
      throw new Error("Missing main.");
    }
    const hot = { send: vi.fn() };

    const diagnostics = reportHydrationDiagnostics(main, ["panel"], { hot });

    expect(diagnostics).toHaveLength(1);
    expect(hot.send).toHaveBeenCalledWith("vite:error", {
      err: {
        message: "Missing hydrate boundary end marker for panel.",
        stack: "Missing hydrate boundary end marker for panel.",
      },
    });
  });

  it("schedules multiple compiled hydration boundaries from metadata", () => {
    document.body.innerHTML = `<main><!--tachyon-hydrate:td-h-0:start--><section><button>Open</button></section><!--tachyon-hydrate:td-h-0:end--></main>`;
    const main = document.querySelector("main");
    if (!main) {
      throw new Error("Missing main.");
    }
    const bind = vi.fn();

    const cleanup = scheduleHydrationBoundaries(
      main,
      [{ id: "td-h-0", idKind: "static", strategy: "interaction", interaction: "pointerenter" }],
      bind,
    );

    expect(bind).not.toHaveBeenCalled();
    main.querySelector("section")?.dispatchEvent(new MouseEvent("pointerenter", { bubbles: true }));
    expect(bind).toHaveBeenCalledTimes(1);
    expect(bind).toHaveBeenCalledWith(main.querySelector("section"), {
      id: "td-h-0",
      idKind: "static",
      strategy: "interaction",
      interaction: "pointerenter",
    });
    cleanup();
  });

  it("replays compiled interaction boundaries and cancels the original event", () => {
    document.body.innerHTML = `<main><!--tachyon-hydrate:td-h-submit:start--><section><button>Send</button></section><!--tachyon-hydrate:td-h-submit:end--></main>`;
    const main = document.querySelector("main");
    const button = main?.querySelector("button");
    if (!main || !(button instanceof HTMLButtonElement)) throw new Error("Missing compiled boundary button.");
    const dispatch = vi.spyOn(button, "dispatchEvent");

    const cleanup = scheduleHydrationBoundaries(
      main,
      [{ id: "td-h-submit", idKind: "static", strategy: "interaction", interaction: "click" }],
      vi.fn(),
    );
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });

    button.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(2);
    cleanup();
    dispatch.mockRestore();
  });

  it("marks the replayed interaction so ancestor capture listeners can distinguish it from the original", () => {
    document.body.innerHTML = `<main><!--tachyon-hydrate:td-h-mark:start--><section><button>Send</button></section><!--tachyon-hydrate:td-h-mark:end--></main>`;
    const main = document.querySelector("main");
    const button = main?.querySelector("button");
    if (!main || !(button instanceof HTMLButtonElement)) throw new Error("Missing compiled boundary button.");
    const observed: Array<{ replayed: boolean; defaultPrevented: boolean }> = [];
    const documentListener = (event: Event): void => {
      observed.push({ replayed: isReplayedInteraction(event), defaultPrevented: event.defaultPrevented });
    };
    document.addEventListener("click", documentListener, true);
    const cleanup = scheduleHydrationBoundaries(
      main,
      [{ id: "td-h-mark", idKind: "static", strategy: "interaction", interaction: "click" }],
      vi.fn(),
    );

    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(observed).toEqual([
      { replayed: false, defaultPrevented: false },
      { replayed: true, defaultPrevented: false },
    ]);
    cleanup();
    document.removeEventListener("click", documentListener, true);
  });

  it("re-arms the interaction trigger after a failed chunk load so the next interaction retries", async () => {
    document.body.innerHTML = `<main><!--tachyon-hydrate:retry:start--><section><button>Open</button></section><!--tachyon-hydrate:retry:end--></main>`;
    const main = document.querySelector("main");
    const button = main?.querySelector("button");
    if (!main || !(button instanceof HTMLButtonElement)) throw new Error("Missing retry button.");
    let attempts = 0;
    const bound: string[] = [];
    const load = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("chunk unavailable");
      return { bind: (element: Element) => void bound.push(element.tagName) };
    });
    const boundary = createLazyHydrationBoundary(main, "retry", load);
    if (!boundary.ok) throw new Error(boundary.error.message);
    const errors: string[] = [];
    const cleanup = scheduleHydration(boundary.value, {
      strategy: "interaction",
      interaction: "click",
      replayInteraction: true,
      onError: (error) => errors.push(error.message),
    });

    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toEqual(["chunk unavailable"]);
    expect(boundary.value.hydrated()).toBe(false);

    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(load).toHaveBeenCalledTimes(2);
    expect(boundary.value.hydrated()).toBe(true);
    expect(bound).toEqual(["SECTION"]);

    cleanup();
    boundary.value.dispose();
  });

  it("rejects duplicate and malformed boundary markers without calling any loader or binder", async () => {
    document.body.innerHTML =
      `<main><!--tachyon-hydrate:dup:start--><section>A</section><!--tachyon-hydrate:dup:end-->` +
      `<!--tachyon-hydrate:dup:start--><section>B</section><!--tachyon-hydrate:dup:end-->` +
      `<div><!--tachyon-hydrate:cross:start--></div><section>C</section><!--tachyon-hydrate:cross:end-->` +
      `<!--tachyon-hydrate:reversed:end--><section>D</section><!--tachyon-hydrate:reversed:start-->` +
      `<!--tachyon-hydrate:empty:start--><!--tachyon-hydrate:empty:end--></main>`;
    const main = document.querySelector("main");
    if (!main) throw new Error("Missing main.");
    const bind = vi.fn(() => undefined);
    const load = vi.fn(async () => ({ bind }));

    const duplicate = createHydrationBoundary(main, "dup", bind);
    const lazyDuplicate = createLazyHydrationBoundary(main, "dup", load);
    const cross = createHydrationBoundary(main, "cross", bind);
    const reversed = createLazyHydrationBoundary(main, "reversed", load);
    const empty = createHydrationBoundary(main, "empty", bind);
    const missing = createHydrationBoundary(main, "absent", bind);

    expect(duplicate.ok).toBe(false);
    expect(lazyDuplicate.ok).toBe(false);
    if (!duplicate.ok && !lazyDuplicate.ok) {
      expect(duplicate.error.kind).toBe("duplicate");
      expect(lazyDuplicate.error.kind).toBe("duplicate");
      expect(lazyDuplicate.error.message).toContain("Duplicate hydrate boundary markers for dup");
    }
    expect(cross.ok).toBe(false);
    expect(reversed.ok).toBe(false);
    expect(empty.ok).toBe(false);
    expect(missing.ok).toBe(false);
    if (!cross.ok && !reversed.ok && !empty.ok && !missing.ok) {
      expect(cross.error.kind).toBe("malformed");
      expect(reversed.error.kind).toBe("malformed");
      expect(empty.error.kind).toBe("malformed");
      expect(missing.error.kind).toBe("missing");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(load).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
  });

  it.each([
    { cancelable: true, replayInteraction: true, async: false },
    { cancelable: true, replayInteraction: true, async: true },
    { cancelable: true, replayInteraction: false, async: false },
    { cancelable: true, replayInteraction: false, async: true },
    { cancelable: false, replayInteraction: true, async: false },
    { cancelable: false, replayInteraction: true, async: true },
    { cancelable: false, replayInteraction: false, async: false },
    { cancelable: false, replayInteraction: false, async: true },
  ])(
    "replays only cancelable interactions (cancelable=$cancelable replay=$replayInteraction async=$async)",
    async ({ cancelable, replayInteraction, async }) => {
      document.body.innerHTML = `<main><!--tachyon-hydrate:matrix:start--><section><button>Go</button></section><!--tachyon-hydrate:matrix:end--></main>`;
      const main = document.querySelector("main");
      const button = main?.querySelector("button");
      if (!main || !(button instanceof HTMLButtonElement)) throw new Error("Missing matrix button.");
      const bound: Event[] = [];
      const binder = (element: Element): (() => void) => {
        const listener = (event: Event): void => void bound.push(event);
        element.addEventListener("click", listener);
        return () => element.removeEventListener("click", listener);
      };
      const boundary = async
        ? createLazyHydrationBoundary(main, "matrix", async () => ({ bind: binder }))
        : createHydrationBoundary(main, "matrix", binder);
      if (!boundary.ok) throw new Error(boundary.error.message);
      const observed: Array<{ replayed: boolean; defaultPrevented: boolean; sameEvent: boolean }> = [];
      const original = new MouseEvent("click", { bubbles: true, cancelable });
      const documentListener = (event: Event): void =>
        void observed.push({
          replayed: isReplayedInteraction(event),
          defaultPrevented: event.defaultPrevented,
          sameEvent: event === original,
        });
      document.addEventListener("click", documentListener);
      const cleanup = scheduleHydration(boundary.value, { strategy: "interaction", interaction: "click", replayInteraction });

      button.dispatchEvent(original);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const expectReplay = replayInteraction && cancelable;
      expect(boundary.value.hydrated()).toBe(true);
      expect(original.defaultPrevented).toBe(expectReplay);
      if (expectReplay) {
        // The original is suppressed at the boundary; only the clone bubbles.
        expect(observed).toEqual([{ replayed: true, defaultPrevented: false, sameEvent: false }]);
        expect(bound.filter(isReplayedInteraction)).toHaveLength(1);
      } else {
        expect(observed).toEqual([{ replayed: false, defaultPrevented: false, sameEvent: true }]);
        expect(bound.some(isReplayedInteraction)).toBe(false);
        // A synchronous binder sees the propagating original; an asynchronous
        // one is not guaranteed to receive it.
        expect(bound.length).toBe(async ? 0 : 1);
      }
      cleanup();
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(observed.filter((entry) => entry.replayed)).toHaveLength(expectReplay ? 1 : 0);
      document.removeEventListener("click", documentListener);
      boundary.value.dispose();
    },
  );

  it("does not replay a pending interaction after the scheduler is released or the boundary is disposed", async () => {
    document.body.innerHTML = `<main><!--tachyon-hydrate:pending:start--><section><button>Go</button></section><!--tachyon-hydrate:pending:end--></main>`;
    const main = document.querySelector("main");
    const button = main?.querySelector("button");
    if (!main || !(button instanceof HTMLButtonElement)) throw new Error("Missing pending button.");
    let resolveChunk!: (chunk: { bind: (element: Element) => void }) => void;
    const boundary = createLazyHydrationBoundary(
      main,
      "pending",
      () => new Promise<{ bind: (element: Element) => void }>((resolve) => void (resolveChunk = resolve)),
    );
    if (!boundary.ok) throw new Error(boundary.error.message);
    const replays: Event[] = [];
    const documentListener = (event: Event): void => {
      if (isReplayedInteraction(event)) replays.push(event);
    };
    document.addEventListener("click", documentListener);
    const cleanup = scheduleHydration(boundary.value, {
      strategy: "interaction",
      interaction: "click",
      replayInteraction: true,
    });

    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    cleanup();
    boundary.value.dispose();
    resolveChunk({ bind: () => undefined });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(boundary.value.hydrated()).toBe(false);
    expect(replays).toHaveLength(0);
    document.removeEventListener("click", documentListener);
  });

  it("loads a lazy boundary once and replays the first interaction", async () => {
    document.body.innerHTML = `<main><!--tachyon-hydrate:panel:start--><section><button>Open</button></section><!--tachyon-hydrate:panel:end--></main>`;
    const main = document.querySelector("main");
    if (!main) throw new Error("Missing main.");
    const before = main.innerHTML;
    let resolveChunk!: (value: { bind: (element: Element) => void }) => void;
    const load = vi.fn(
      () =>
        new Promise<{ bind: (element: Element) => void }>((resolve) => {
          resolveChunk = resolve;
        }),
    );
    const bind = vi.fn((element: Element) => {
      element.querySelector("button")?.addEventListener("click", () => {
        element.setAttribute("data-opened", "true");
      });
    });
    const result = createLazyHydrationBoundary(main, "panel", load);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);

    const interactionCleanup = scheduleHydration(result.value, {
      strategy: "interaction",
      interaction: "click",
      replayInteraction: true,
    });
    const button = main.querySelector("button");
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(load).toHaveBeenCalledTimes(1);
    expect(bind).not.toHaveBeenCalled();
    expect(main.innerHTML).toBe(before);

    resolveChunk({ bind });
    await result.value.hydrate();
    await Promise.resolve();

    expect(bind).toHaveBeenCalledTimes(1);
    expect(result.value.hydrated()).toBe(true);
    expect(main.querySelector("section")?.getAttribute("data-opened")).toBe("true");
    interactionCleanup();
  });

  it("prevents the original submit default action before replaying a lazy click", async () => {
    document.body.innerHTML = `<form id="form"><!--tachyon-hydrate:panel:start--><button type="submit">Send</button><!--tachyon-hydrate:panel:end--></form>`;
    const form = document.querySelector("#form");
    if (!(form instanceof HTMLFormElement)) throw new Error("Missing form.");
    let submissions = 0;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submissions++;
    });
    let resolveChunk!: (value: { bind: (element: Element) => void }) => void;
    const result = createLazyHydrationBoundary(
      form,
      "panel",
      () => new Promise<{ bind: (element: Element) => void }>((resolve) => {
        resolveChunk = resolve;
      }),
    );
    if (!result.ok) throw new Error(result.error.message);
    const stop = scheduleHydration(result.value, {
      strategy: "interaction",
      interaction: "click",
      replayInteraction: true,
    });

    form.querySelector("button")?.click();
    resolveChunk({ bind: () => undefined });
    await result.value.hydrate();
    await Promise.resolve();

    expect(submissions).toBe(1);
    stop();
  });

  it("shares an in-flight lazy chunk, cancels it on dispose, and retries failures", async () => {
    document.body.innerHTML = `<main><!--tachyon-hydrate:panel:start--><section></section><!--tachyon-hydrate:panel:end--></main>`;
    const main = document.querySelector("main");
    if (!main) throw new Error("Missing main.");
    let rejectChunk!: (reason?: unknown) => void;
    let resolveChunk!: (value: { bind: (element: Element) => void }) => void;
    const bind = vi.fn();
    let attempt = 0;
    const load = vi.fn(() => {
      attempt += 1;
      if (attempt === 1) {
        return new Promise<{ bind: (element: Element) => void }>((_resolve, reject) => {
          rejectChunk = reject;
        });
      }
      return new Promise<{ bind: (element: Element) => void }>((resolve) => {
        resolveChunk = resolve;
      });
    });
    const errors: string[] = [];
    const result = createLazyHydrationBoundary(main, "panel", load, {
      onError: (error) => errors.push(error.message),
    });
    if (!result.ok) throw new Error(result.error.message);

    const first = result.value.hydrate();
    const second = result.value.hydrate();
    expect(load).toHaveBeenCalledTimes(1);
    result.value.dispose();
    rejectChunk(new Error("chunk failed"));
    await expect(first).rejects.toThrow("chunk failed");
    await expect(second).rejects.toThrow("chunk failed");
    expect(bind).not.toHaveBeenCalled();
    expect(errors).toEqual(["chunk failed"]);

    const retry = result.value.hydrate();
    expect(load).toHaveBeenCalledTimes(2);
    resolveChunk({ bind });
    await retry;
    expect(bind).toHaveBeenCalledTimes(1);
  });

  it("hydrates only the interaction boundary that receives the event", () => {
    document.body.innerHTML = `<main>
      <!--tachyon-hydrate:a:start--><section id="a"><button>A</button></section><!--tachyon-hydrate:a:end-->
      <!--tachyon-hydrate:b:start--><section id="b"><button>B</button></section><!--tachyon-hydrate:b:end-->
    </main>`;
    const main = document.querySelector("main");
    if (!main) {
      throw new Error("Missing main.");
    }
    const hydrated: string[] = [];
    const cleanup = scheduleHydrationBoundaries(
      main,
      [
        { id: "a", strategy: "interaction", interaction: "click" },
        { id: "b", strategy: "interaction", interaction: "click" },
      ],
      (element) => {
        hydrated.push(element.id);
      },
    );

    main.querySelector("#a button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(hydrated).toEqual(["a"]);
    cleanup();
  });

  it("indexes comments once when scheduling many hydration boundaries", () => {
    document.body.innerHTML = `<main>${Array.from(
      { length: 5 },
      (_, index) =>
        `<!--tachyon-hydrate:td-h-${index}:start--><section>${index}</section><!--tachyon-hydrate:td-h-${index}:end-->`,
    ).join("")}</main>`;
    const main = document.querySelector("main");
    if (!main) {
      throw new Error("Missing main.");
    }
    const createTreeWalker = vi.spyOn(document, "createTreeWalker");

    const cleanup = scheduleHydrationBoundaries(
      main,
      Array.from({ length: 5 }, (_, index) => ({ id: `td-h-${index}`, idKind: "static" as const })),
      vi.fn(),
    );

    expect(createTreeWalker).toHaveBeenCalledTimes(1);
    cleanup();
    createTreeWalker.mockRestore();
  });
});
