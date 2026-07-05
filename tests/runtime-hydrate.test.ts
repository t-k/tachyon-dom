import { describe, expect, it, vi } from "vitest";
import {
  createHydrationBoundary,
  diagnoseHydrationBoundaries,
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
