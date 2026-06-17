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

  it("updates route targets without replacing persistent shell DOM", async () => {
    document.body.innerHTML = `<main id="app"><nav data-shell="stable"><a href="/orders">Orders</a></nav><section id="outlet"></section></main>`;
    const root = document.querySelector("#app");
    const nav = document.querySelector("nav");
    if (!(root instanceof HTMLElement) || !(nav instanceof HTMLElement)) {
      throw new Error("Missing app shell.");
    }
    createWindow("/");
    const router = createClientRouter({
      root,
      routes: [
        { path: "/", target: "#outlet", render: () => `<h1>Users</h1>` },
        { path: "/orders", target: "#outlet", render: () => `<h1>Orders</h1>` },
      ],
      scrollTo: () => undefined,
    });

    await router.start();
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    root.querySelector("a")?.dispatchEvent(click);
    await router.settled();

    expect(document.querySelector("nav")).toBe(nav);
    expect(root.querySelector("#outlet")?.innerHTML).toBe("<h1>Orders</h1>");
    expect(location.pathname).toBe("/orders");
    router.dispose();
  });

  it("eagerly navigates prefetched route targets on primary pointer down", async () => {
    document.body.innerHTML = `<main id="app"><nav><a href="/orders">Orders</a></nav><section id="outlet"></section></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing app root.");
    }
    createWindow("/");
    let loads = 0;
    const router = createClientRouter({
      root,
      routes: [
        { path: "/", target: "#outlet", render: () => `<h1>Users</h1>` },
        {
          path: "/orders",
          target: "#outlet",
          load: () => ({ count: ++loads }),
          render: ({ data }) => `<h1>Orders ${(data as { count: number }).count}</h1>`,
        },
      ],
      cache: true,
      initialCache: [{ href: "/orders", data: { count: 1 } }],
      eager: true,
      scrollTo: () => undefined,
    });

    await router.start();
    root.querySelector("a")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    await router.settled();
    expect(root.querySelector("#outlet")?.innerHTML).toBe("<h1>Orders 1</h1>");
    root.querySelector("a")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    await router.settled();

    expect(root.querySelector("#outlet")?.innerHTML).toBe("<h1>Orders 1</h1>");
    expect(location.pathname).toBe("/orders");
    expect(loads).toBe(0);
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

  it("caches loaders, prefetches, invalidates, and announces navigation", async () => {
    document.body.innerHTML = `<main id="app"></main><div id="live" aria-live="polite"></div>`;
    const root = document.querySelector("#app");
    const live = document.querySelector("#live");
    if (!(root instanceof HTMLElement) || !(live instanceof HTMLElement)) {
      throw new Error("Missing app root.");
    }
    createWindow("/");
    let loads = 0;
    const router = createClientRouter({
      root,
      routes: [
        { path: "/", render: () => `<a href="/cached" data-prefetch="hover">Cached</a>` },
        {
          path: "/cached",
          load: () => ({ count: ++loads }),
          render: ({ data }) => `<h1>${(data as { count: number }).count}</h1>`,
        },
      ],
      cache: true,
      liveRegion: live,
      title: ({ url }) => `Page ${url.pathname}`,
      scrollTo: () => undefined,
    });

    await router.start();
    await router.prefetch("/cached");
    await router.navigate("/cached");
    await router.navigate("/");
    await router.navigate("/cached");

    expect(loads).toBe(1);
    expect(root.innerHTML).toBe(`<h1>1</h1>`);
    expect(document.title).toBe("Page /cached");
    expect(live.textContent).toBe("Navigated to /cached");

    router.invalidate("/cached");
    await router.navigate("/cached", { replace: true });
    expect(loads).toBe(2);
    router.dispose();
  });

  it("submits actions and revalidates loader cache by route policy", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing app root.");
    }
    createWindow("/");
    let loads = 0;
    const requests: string[] = [];
    const router = createClientRouter({
      root,
      routes: [
        { id: "home", path: "/", render: () => "home" },
        {
          id: "todos",
          path: "/todos",
          load: () => ({ count: ++loads }),
          action: async ({ request }) => {
            requests.push(`${request.method} ${new URL(request.url).pathname}`);
            return new Response("ok");
          },
          revalidateOnAction: "self",
          render: ({ data }) => `<h1>${(data as { count: number }).count}</h1>`,
        },
      ],
      cache: true,
      scrollTo: () => undefined,
    });

    await router.start();
    await router.navigate("/todos");
    await router.navigate("/");
    await router.navigate("/todos");
    expect(loads).toBe(1);

    const response = await router.submit("/todos", { method: "POST", body: new FormData() });
    expect(await response.text()).toBe("ok");
    expect(requests).toEqual(["POST /todos"]);
    expect(loads).toBe(2);
    expect(root.innerHTML).toBe("<h1>2</h1>");
    router.dispose();
  });
});
