import { describe, expect, it, vi } from "vitest";
import {
  createHydrationBoundary,
  diagnoseHydrationBoundaries,
  locateHydrationBoundary,
  readHydrationState,
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
});
