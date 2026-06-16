import { describe, expect, it, vi } from "vitest";
import {
  createHydrationBoundary,
  locateHydrationBoundary,
  readHydrationState,
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
});
