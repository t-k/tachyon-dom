import { afterEach, describe, expect, it, vi } from "vitest";
import { createClientRouter, rawHtml, type ClientRouteDefinition } from "../src/runtime/router";

const createWindow = (path = "/") => {
  const domWindow = window;
  domWindow.history.replaceState({}, "", path);
  return domWindow;
};

describe("client router", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats string route output as text instead of trusted HTML", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing app root.");
    }
    createWindow("/");
    const router = createClientRouter({
      root,
      routes: [{ path: "/", render: ({ url }) => `<img src=x onerror="alert(1)"> ${url.pathname}` }],
      scrollTo: () => undefined,
    });

    await router.start();

    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toBe(`<img src=x onerror="alert(1)"> /`);
    router.dispose();
  });

  it("starts, navigates, updates history, and renders loader data", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing app root.");
    }
    createWindow("/");
    const routes: ClientRouteDefinition[] = [
      { id: "home", path: "/", render: () => rawHtml(`<a href="/users/42">User</a>`) },
      {
        id: "user",
        path: "/users/:id",
        load: ({ params }) => ({ name: `User ${params.id}` }),
        render: ({ data }) => rawHtml(`<h1 tabindex="-1">${(data as { name: string }).name}</h1>`),
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
        { path: "/", render: () => rawHtml(`<a href="/next">Next</a>`) },
        { path: "/next", render: () => rawHtml(`<h1>Next</h1>`) },
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

  it("updates hash-only same-route links without reloading route data", async () => {
    document.body.innerHTML = `<main id="app"></main><section id="section"></section>`;
    const root = document.querySelector("#app");
    const section = document.querySelector("#section");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing app root.");
    }
    const scrollIntoView = vi.fn();
    Object.defineProperty(section, "scrollIntoView", { value: scrollIntoView });
    createWindow("/page?tab=a");
    let loads = 0;
    const scrolled: Array<[number, number]> = [];
    const router = createClientRouter({
      root,
      routes: [
        {
          path: "/page",
          load: () => ({ count: ++loads }),
          render: ({ data }) =>
            rawHtml(`<a href="/page?tab=a#section">Section ${(data as { count: number }).count}</a>`),
        },
      ],
      scrollTo: (x, y) => scrolled.push([x, y]),
    });
    await router.start();
    expect(loads).toBe(1);

    root.querySelector("a")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    await router.settled();

    expect(location.pathname).toBe("/page");
    expect(location.search).toBe("?tab=a");
    expect(location.hash).toBe("#section");
    expect(loads).toBe(1);
    expect(scrolled).toHaveLength(1);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    router.dispose();
  });

  it("restores scroll position on popstate navigations", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing app root.");
    }
    createWindow("/");
    let scrollY = 0;
    vi.spyOn(window, "scrollY", "get").mockImplementation(() => scrollY);
    const scrolled: Array<[number, number]> = [];
    const router = createClientRouter({
      root,
      routes: [
        { path: "/", render: () => rawHtml(`<h1>Home</h1>`) },
        { path: "/long", render: () => rawHtml(`<h1>Long</h1>`) },
      ],
      scrollTo: (x, y) => {
        scrolled.push([x, y]);
        scrollY = y;
      },
    });

    await router.start();
    const homeState = history.state;
    scrollY = 240;
    await router.navigate("/long");
    scrollY = 20;
    history.replaceState(homeState, "", "/");
    dispatchEvent(new PopStateEvent("popstate", { state: homeState }));
    await router.settled();

    expect(location.pathname).toBe("/");
    expect(scrolled.at(-1)).toEqual([0, 240]);
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
        { path: "/", target: "#outlet", render: () => rawHtml(`<h1>Users</h1>`) },
        { path: "/orders", target: "#outlet", render: () => rawHtml(`<h1>Orders</h1>`) },
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
        { path: "/", target: "#outlet", render: () => rawHtml(`<h1>Users</h1>`) },
        {
          path: "/orders",
          target: "#outlet",
          load: () => ({ count: ++loads }),
          render: ({ data }) => rawHtml(`<h1>Orders ${(data as { count: number }).count}</h1>`),
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
        render: ({ data }) => rawHtml(`<h1>${(data as { label: string }).label}</h1>`),
      },
      { path: "/fast", render: () => rawHtml(`<h1>Fast</h1>`) },
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
        { path: "/", render: () => rawHtml(`<h1>Home</h1>`) },
        { path: "/settings", render: () => rawHtml(`<h1>Settings</h1>`) },
      ],
      notFound: ({ url }) => rawHtml(`<h1>Missing ${url.pathname}</h1>`),
    });
    await router.start();
    await router.navigate("/settings");
    history.pushState({}, "", "/missing");
    dispatchEvent(new PopStateEvent("popstate", { state: {} }));
    await router.settled();

    expect(root.innerHTML).toBe(`<h1>Missing /missing</h1>`);
    router.dispose();
  });

  it("matches named wildcards and prioritizes static routes on the client", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing app root.");
    }
    createWindow("/");
    const router = createClientRouter({
      root,
      routes: [
        { path: "/users/:id", render: ({ params }) => rawHtml(`<h1>User ${params.id}</h1>`) },
        { path: "/users/new", render: () => rawHtml(`<h1>New user</h1>`) },
        { path: "/blog/*slug", render: ({ params }) => rawHtml(`<h1>${params.slug}</h1>`) },
      ],
    });

    await router.start();
    await router.navigate("/users/new");
    expect(root.innerHTML).toBe("<h1>New user</h1>");

    await router.navigate("/blog/2026/launch");
    expect(root.innerHTML).toBe("<h1>2026/launch</h1>");
    router.dispose();
  });

  it("reuses compiled client route matchers across navigations", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing app root.");
    }
    createWindow("/");
    const NativeRegExp = RegExp;
    let constructed = 0;
    vi.stubGlobal("RegExp", function RegExpSpy(pattern: string, flags?: string) {
      constructed += 1;
      return new NativeRegExp(pattern, flags);
    } as unknown as RegExpConstructor);
    const router = createClientRouter({
      root,
      routes: [
        { path: "/", render: () => rawHtml(`<a href="/users/1">User</a>`) },
        { path: "/users/:id", render: ({ params }) => rawHtml(`<h1>${params.id}</h1>`) },
      ],
      scrollTo: () => undefined,
    });

    await router.start();
    expect(constructed).toBeGreaterThan(0);
    constructed = 0;
    await router.navigate("/users/1");
    await router.navigate("/users/2");

    expect(constructed).toBe(0);
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
        { path: "/", render: () => rawHtml(`<a href="/cached" data-prefetch="hover">Cached</a>`) },
        {
          path: "/cached",
          load: () => ({ count: ++loads }),
          render: ({ data }) => rawHtml(`<h1>${(data as { count: number }).count}</h1>`),
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

  it("aborts in-flight prefetches on dispose", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing app root.");
    }
    createWindow("/");
    let prefetchSignal: AbortSignal | undefined;
    const router = createClientRouter({
      root,
      routes: [
        { path: "/", render: () => "home" },
        {
          path: "/slow",
          load: ({ signal }) => {
            prefetchSignal = signal;
            return new Promise(() => undefined);
          },
          render: () => "slow",
        },
      ],
    });

    await router.start();
    void router.prefetch("/slow");
    await Promise.resolve();
    router.dispose();

    expect(prefetchSignal?.aborted).toBe(true);
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
          render: ({ data }) => rawHtml(`<h1>${(data as { count: number }).count}</h1>`),
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
