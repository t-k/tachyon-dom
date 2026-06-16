import { describe, expect, it } from "vitest";
import { createClientRouter, type ClientRouteDefinition } from "../src/runtime/router";

const createWindow = (path = "/") => {
  const domWindow = window;
  domWindow.history.replaceState({}, "", path);
  return domWindow;
};

describe("client router", () => {
  it("starts, navigates, updates history, and renders loader data", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing app root.");
    }
    createWindow("/");
    const routes: ClientRouteDefinition[] = [
      { id: "home", path: "/", render: () => `<a href="/users/42">User</a>` },
      {
        id: "user",
        path: "/users/:id",
        load: ({ params }) => ({ name: `User ${params.id}` }),
        render: ({ data }) => `<h1 tabindex="-1">${(data as { name: string }).name}</h1>`,
      },
    ];
    const scrolled: Array<[number, number]> = [];
    const router = createClientRouter({ root, routes, scrollTo: (x, y) => scrolled.push([x, y]) });

    await router.start();
    await router.navigate("/users/42");

    expect(root.innerHTML).toBe(`<h1 tabindex="-1">User 42</h1>`);
    expect(location.pathname).toBe("/users/42");
    expect(scrolled.at(-1)).toEqual([0, 0]);
    expect(document.activeElement).toBe(root.querySelector("h1"));
    router.dispose();
  });

  it("intercepts same-origin links while preserving modified clicks", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing app root.");
    }
    createWindow("/");
    const router = createClientRouter({
      root,
      routes: [
        { path: "/", render: () => `<a href="/next">Next</a>` },
        { path: "/next", render: () => `<h1>Next</h1>` },
      ],
    });
    await router.start();
    const preventedByRouter: boolean[] = [];
    root.addEventListener("click", (event) => {
      preventedByRouter.push(event.defaultPrevented);
      event.preventDefault();
    });

    const modified = new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true, button: 0 });
    root.querySelector("a")?.dispatchEvent(modified);
    expect(preventedByRouter.at(-1)).toBe(false);
    expect(location.pathname).toBe("/");

    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    root.querySelector("a")?.dispatchEvent(click);
    await router.settled();

    expect(preventedByRouter.at(-1)).toBe(true);
    expect(location.pathname).toBe("/next");
    expect(root.innerHTML).toBe(`<h1>Next</h1>`);
    router.dispose();
  });

  it("aborts stale navigations and renders the latest route", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing app root.");
    }
    createWindow("/");
    const signals: AbortSignal[] = [];
    let resolveSlow: ((value: { label: string }) => void) | undefined;
    const routes: ClientRouteDefinition[] = [
      { path: "/", render: () => "home" },
      {
        path: "/slow",
        load: ({ signal }) => {
          signals.push(signal);
          return new Promise((resolve) => {
            resolveSlow = resolve;
          });
        },
        render: ({ data }) => `<h1>${(data as { label: string }).label}</h1>`,
      },
      { path: "/fast", render: () => `<h1>Fast</h1>` },
    ];
    const router = createClientRouter({ root, routes });
    await router.start();

    const slow = router.navigate("/slow");
    const fast = router.navigate("/fast");
    resolveSlow?.({ label: "Slow" });
    await slow;
    await fast;

    expect(signals[0]?.aborted).toBe(true);
    expect(root.innerHTML).toBe(`<h1>Fast</h1>`);
    router.dispose();
  });

  it("handles popstate navigation and exposes 404 rendering", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing app root.");
    }
    createWindow("/");
    const router = createClientRouter({
      root,
      routes: [
        { path: "/", render: () => `<h1>Home</h1>` },
        { path: "/settings", render: () => `<h1>Settings</h1>` },
      ],
      notFound: ({ url }) => `<h1>Missing ${url.pathname}</h1>`,
    });
    await router.start();
    await router.navigate("/settings");
    history.pushState({}, "", "/missing");
    dispatchEvent(new PopStateEvent("popstate", { state: {} }));
    await router.settled();

    expect(root.innerHTML).toBe(`<h1>Missing /missing</h1>`);
    router.dispose();
  });
});
