import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { renderHead, type RouteHeadDescriptor } from "../src/router";
import {
  createClientRouter,
  defineClientRoute,
  rawHtml,
  type ClientMountedView,
  type ClientParamsForPath,
  type ClientRouteDefinition,
} from "../src/runtime/router";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type _WildcardWithoutName = Expect<Equal<ClientParamsForPath<"/files/*">, { wildcard: string }>>;
type _WildcardAndParam = Expect<Equal<ClientParamsForPath<"/*rest/:id">, { rest: string; id: string }>>;
type _LiteralColon = Expect<Equal<ClientParamsForPath<"/literal:tag">, {}>>;

const createWindow = (path = "/") => {
  const domWindow = window;
  domWindow.history.replaceState({}, "", path);
  return domWindow;
};

describe("client router", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("infers loader data and path parameters through defineClientRoute", () => {
    const route = defineClientRoute({
      path: "/users/:id",
      load: ({ params }) => ({ name: params.id }),
      render: ({ data, params }) => `${data.name}:${params.id}`,
    });

    expectTypeOf(route).toMatchTypeOf<ClientRouteDefinition<{ name: string }, { id: string }>>();
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

  it("disposes a flat view when its connected callback synchronously disposes the router", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) throw new Error("Missing app root.");
    createWindow("/");
    const tagName = `td-dispose-flat-${Math.random().toString(36).slice(2)}`;
    let router: ReturnType<typeof createClientRouter> | undefined;
    let disposeCount = 0;
    customElements.define(
      tagName,
      class extends HTMLElement {
        connectedCallback(): void {
          router?.dispose();
        }
      },
    );
    router = createClientRouter({
      root,
      routes: [
        {
          path: "/",
          render: () => ({ value: rawHtml(`<${tagName}></${tagName}>`), dispose: () => disposeCount++ }),
        },
      ],
      scrollTo: () => undefined,
    });

    await router.start();

    expect(disposeCount).toBe(1);
    expect(root.childElementCount).toBe(0);
  });

  it("disposes a nested leaf when its connected callback synchronously disposes the router", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) throw new Error("Missing app root.");
    createWindow("/layout/page");
    const tagName = `td-dispose-nested-${Math.random().toString(36).slice(2)}`;
    let router: ReturnType<typeof createClientRouter> | undefined;
    let disposeCount = 0;
    customElements.define(
      tagName,
      class extends HTMLElement {
        connectedCallback(): void {
          router?.dispose();
        }
      },
    );
    router = createClientRouter({
      root,
      routes: [
        {
          path: "/layout",
          render: () => rawHtml(`<section><div data-tachyon-outlet></div></section>`),
          children: [
            {
              path: "page",
              render: () => ({ value: rawHtml(`<${tagName}></${tagName}>`), dispose: () => disposeCount++ }),
            },
          ],
        },
      ],
      scrollTo: () => undefined,
    });

    await router.start();

    expect(disposeCount).toBe(1);
    expect(root.childElementCount).toBe(0);
  });

  it("disposes a view once when connectedCallback re-enters navigation", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) throw new Error("Missing app root.");
    createWindow("/");
    const tagName = `td-reenter-navigation-${Math.random().toString(36).slice(2)}`;
    let router: ReturnType<typeof createClientRouter> | undefined;
    let nextDisposeCount = 0;
    customElements.define(
      tagName,
      class extends HTMLElement {
        connectedCallback(): void {
          void router?.navigate("/other");
        }
      },
    );
    router = createClientRouter({
      root,
      routes: [
        { path: "/", render: () => rawHtml("<p>home</p>") },
        {
          path: "/next",
          render: () => ({ value: rawHtml(`<${tagName}></${tagName}>`), dispose: () => nextDisposeCount++ }),
        },
        { path: "/other", render: () => rawHtml("<p>other</p>") },
      ],
      scrollTo: () => undefined,
    });

    await router.start();
    await router.navigate("/next");
    await router.settled();

    expect(nextDisposeCount).toBe(1);
    router.dispose();
    expect(nextDisposeCount).toBe(1);
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

  it("drops old saved scroll positions after the retention limit", async () => {
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
        { path: "/page/:id", render: ({ params }) => rawHtml(`<h1>Page ${params.id}</h1>`) },
      ],
      scrollTo: (x, y) => {
        scrolled.push([x, y]);
        scrollY = y;
      },
    });

    await router.start();
    const homeState = history.state;
    scrollY = 240;
    for (let index = 0; index < 55; index++) {
      await router.navigate(`/page/${index}`);
      scrollY = index + 1;
    }
    history.replaceState(homeState, "", "/");
    dispatchEvent(new PopStateEvent("popstate", { state: homeState }));
    await router.settled();

    expect(scrolled.at(-1)).toEqual([0, 0]);
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

  it("renders nested layout routes into a stable client outlet", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing app root.");
    }
    createWindow("/app/users");
    let layoutRenders = 0;
    const router = createClientRouter({
      root,
      routes: [
        {
          id: "app",
          path: "/app",
          render: () => {
            layoutRenders += 1;
            return rawHtml(
              `<section data-layout><nav><a href="/app/orders">Orders</a></nav><div data-tachyon-outlet></div></section>`,
            );
          },
          children: [
            { id: "users", path: "users", render: () => rawHtml(`<h1>Users</h1>`) },
            { id: "orders", path: "orders", render: () => rawHtml(`<h1>Orders</h1>`) },
          ],
        },
      ],
      scrollTo: () => undefined,
    });

    await router.start();
    const layout = root.querySelector("[data-layout]");
    await router.navigate("/app/orders");

    expect(root.querySelector("[data-layout]")).toBe(layout);
    expect(root.querySelector("[data-tachyon-outlet]")?.innerHTML).toBe("<h1>Orders</h1>");
    expect(layoutRenders).toBe(1);
    router.dispose();
  });

  it("disposes every exited layout when navigating out of a nested branch", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) throw new Error("Missing app root.");
    createWindow("/app/section/page");
    const disposed: string[] = [];
    const view = (name: string): ClientMountedView => ({
      value:
        name === "page"
          ? rawHtml(`<p>${name}</p>`)
          : rawHtml(`<section data-layout="${name}"><div data-tachyon-outlet></div></section>`),
      dispose: () => disposed.push(name),
    });
    const router = createClientRouter({
      root,
      routes: [
        {
          id: "app",
          path: "/app",
          render: () => view("app"),
          children: [
            {
              id: "section",
              path: "section",
              render: () => view("section"),
              children: [{ id: "page", path: "page", render: () => view("page") }],
            },
          ],
        },
        { id: "other", path: "/other", render: () => view("other") },
      ],
      scrollTo: () => undefined,
    });

    await router.start();
    await router.navigate("/other");

    expect(disposed).toHaveLength(3);
    expect(disposed).toEqual(expect.arrayContaining(["page", "section", "app"]));
    router.dispose();
  });

  it("disposes a pending leaf when an async layout navigation becomes stale", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) throw new Error("Missing app root.");
    createWindow("/");
    let releaseLayout: ((value: ClientMountedView) => void) | undefined;
    const disposed: string[] = [];
    const view = (name: string): ClientMountedView => ({
      value: rawHtml(`<p>${name}</p>`),
      dispose: () => disposed.push(name),
    });
    const router = createClientRouter({
      root,
      routes: [
        { path: "/", render: () => view("home") },
        {
          id: "app",
          path: "/app",
          render: () =>
            new Promise((resolve) => {
              releaseLayout = resolve;
            }),
          children: [{ id: "page", path: "page", render: () => view("page") }],
        },
        { path: "/other", render: () => view("other") },
      ],
      scrollTo: () => undefined,
    });

    await router.start();
    const pending = router.navigate("/app/page");
    await Promise.resolve();
    await router.navigate("/other");
    releaseLayout?.(view("app"));
    await pending;

    expect(disposed.filter((name) => name === "page")).toEqual(["page"]);
    expect(root.textContent).toBe("other");
    router.dispose();
  });

  it("disposes a leaf that is pending behind a never-settling layout", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) throw new Error("Missing app root.");
    createWindow("/");
    let pageRendered = false;
    const disposed: string[] = [];
    const view = (name: string): ClientMountedView => ({
      value: rawHtml(`<p>${name}</p>`),
      dispose: () => disposed.push(name),
    });
    const router = createClientRouter({
      root,
      routes: [
        { path: "/", render: () => view("home") },
        {
          path: "/app",
          render: () => new Promise<ClientMountedView>(() => undefined),
          children: [
            {
              path: "page",
              render: () => {
                pageRendered = true;
                return view("page");
              },
            },
          ],
        },
      ],
      scrollTo: () => undefined,
    });

    await router.start();
    void router.navigate("/app/page");
    for (let index = 0; index < 4 && !pageRendered; index++) await Promise.resolve();

    expect(pageRendered).toBe(true);
    await Promise.resolve();
    router.dispose();
    expect(disposed.filter((name) => name === "page")).toEqual(["page"]);
  });

  it("keeps the displayed nested layout until a replacement layout is ready", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) throw new Error("Missing app root.");
    createWindow("/app/page?q=one");
    let releaseLayout: ((value: ClientMountedView) => void) | undefined;
    const layoutTwo = new Promise<ClientMountedView>((resolve) => {
      releaseLayout = resolve;
    });
    const disposed: string[] = [];
    const view = (name: string): ClientMountedView => ({
      value: rawHtml(
        name.startsWith("layout")
          ? `<section data-layout="${name}"><div data-tachyon-outlet></div></section>`
          : `<p>${name}</p>`,
      ),
      dispose: () => disposed.push(name),
    });
    const router = createClientRouter({
      root,
      routes: [
        {
          id: "app",
          path: "/app",
          render: ({ url }) => {
            if (url.search === "?q=one") return view("layout-one");
            return layoutTwo;
          },
          children: [{ id: "page", path: "page", render: () => view("page") }],
        },
      ],
      scrollTo: () => undefined,
    });

    await router.start();
    const pending = router.navigate("/app/page?q=two");
    await Promise.resolve();

    expect(root.querySelector("[data-layout=layout-one]")).not.toBeNull();
    expect(root.textContent).toBe("page");
    expect(disposed).toEqual([]);
    releaseLayout?.(view("layout-two"));
    await pending;

    expect(root.querySelector("[data-layout=layout-two]")).not.toBeNull();
    expect(root.textContent).toBe("page");
    expect(disposed).toEqual(["page", "layout-one"]);
    router.dispose();
  });

  it("rerenders parent layouts when the query changes", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing app root.");
    }
    createWindow("/app/child?tab=one");
    let layoutRenders = 0;
    const router = createClientRouter({
      root,
      routes: [
        {
          id: "app",
          path: "/app",
          render: ({ url }) => {
            layoutRenders += 1;
            return rawHtml(`<section data-query="${url.search}"><div data-tachyon-outlet></div></section>`);
          },
          children: [{ id: "child", path: "child", render: () => rawHtml("<p>Child</p>") }],
        },
      ],
      scrollTo: () => undefined,
    });

    await router.start();
    await router.navigate("/app/child?tab=two");

    expect(root.querySelector("[data-query]")?.getAttribute("data-query")).toBe("?tab=two");
    expect(location.search).toBe("?tab=two");
    expect(layoutRenders).toBe(2);
    router.dispose();
  });

  it("rerenders loaded parent layouts when route params change", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing app root.");
    }
    createWindow("/app/1/child");
    let parentLoads = 0;
    let parentRenders = 0;
    const router = createClientRouter({
      root,
      routes: [
        {
          id: "app",
          path: "/app/:id",
          load: ({ params }) => {
            parentLoads += 1;
            return { id: params.id };
          },
          render: ({ data }) => {
            parentRenders += 1;
            return rawHtml(
              `<section data-parent="${(data as { id: string }).id}"><div data-tachyon-outlet></div></section>`,
            );
          },
          children: [
            {
              id: "child",
              path: "child",
              render: ({ params }) => rawHtml(`<p data-child="${params.id}"></p>`),
            },
          ],
        },
      ],
      scrollTo: () => undefined,
    });

    await router.start();
    await router.navigate("/app/2/child");

    expect(root.querySelector("[data-parent]")?.getAttribute("data-parent")).toBe("2");
    expect(root.querySelector("[data-child]")?.getAttribute("data-child")).toBe("2");
    expect(parentLoads).toBe(2);
    expect(parentRenders).toBe(2);
    router.dispose();
  });

  it("runs nested loaders and heads with route-local data", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing app root.");
    }
    createWindow("/app/users");
    const calls: string[] = [];
    const router = createClientRouter({
      root,
      routes: [
        {
          id: "app",
          path: "/app",
          load: () => {
            calls.push("load:parent");
            return { label: "Parent" };
          },
          head: ({ data }) => {
            calls.push(`head:${(data as { label: string }).label}`);
            return { title: "Parent", metas: [{ name: "parent", content: "yes" }] };
          },
          render: ({ data }) => {
            calls.push(`render:${(data as { label: string }).label}`);
            return rawHtml(`<section><div data-tachyon-outlet></div></section>`);
          },
          children: [
            {
              id: "users",
              path: "users",
              load: () => {
                calls.push("load:child");
                return { label: "Child" };
              },
              head: ({ data }) => {
                calls.push(`head:${(data as { label: string }).label}`);
                return { title: "Child", metas: [{ name: "child", content: "yes" }] };
              },
              render: ({ data }) => {
                calls.push(`render:${(data as { label: string }).label}`);
                return rawHtml(`<h1>${(data as { label: string }).label}</h1>`);
              },
            },
          ],
        },
      ],
      scrollTo: () => undefined,
    });

    await router.start();

    expect(calls).toEqual(["load:parent", "load:child", "render:Child", "render:Parent", "head:Parent", "head:Child"]);
    expect(document.title).toBe("Child");
    expect(document.head.querySelector(`[name="parent"]`)).not.toBeNull();
    expect(document.head.querySelector(`[name="child"]`)).not.toBeNull();
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

  it("keeps the committed screen alive until the next screen commits", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) throw new Error("Missing app root.");
    createWindow("/");
    let releaseSlow: ((value: string) => void) | undefined;
    const disposed: string[] = [];
    const view = (name: string): ClientMountedView => ({
      value: rawHtml(`<h1>${name}</h1>`),
      dispose: () => disposed.push(name),
    });
    const router = createClientRouter({
      root,
      routes: [
        { path: "/", render: () => view("home") },
        {
          path: "/slow",
          load: () =>
            new Promise((resolve) => {
              releaseSlow = resolve;
            }),
          render: ({ data }) => view(String(data)),
        },
      ],
      scrollTo: () => undefined,
    });

    await router.start();
    const navigation = router.navigate("/slow");
    await Promise.resolve();
    expect(disposed).toEqual([]);
    releaseSlow?.("slow");
    await navigation;

    expect(root.textContent).toBe("slow");
    expect(disposed).toEqual(["home"]);
    router.dispose();
    expect(disposed).toEqual(["home", "slow"]);
  });

  it("continues router disposal after a layout cleanup throws", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) throw new Error("Missing app root.");
    createWindow("/app/section/page");
    const disposed: string[] = [];
    const view = (name: string, throws = false): ClientMountedView => ({
      value:
        name === "page"
          ? rawHtml(`<p data-view="page">Page</p>`)
          : rawHtml(`<section data-view="${name}"><div data-tachyon-outlet></div></section>`),
      dispose: () => {
        disposed.push(name);
        if (throws) throw new Error(`${name} cleanup failed`);
      },
    });
    const router = createClientRouter({
      root,
      routes: [
        {
          id: "app",
          path: "/app",
          render: () => view("app", true),
          children: [
            {
              id: "section",
              path: "section",
              render: () => view("section"),
              children: [{ id: "page", path: "page", render: () => view("page") }],
            },
          ],
        },
      ],
      scrollTo: () => undefined,
    });

    await router.start();

    expect(() => router.dispose()).toThrow("app cleanup failed");
    expect(disposed).toEqual(["app", "section", "page"]);
    expect(() => router.dispose()).not.toThrow();
    await router.navigate("/app/section/page");
    expect(disposed).toEqual(["app", "section", "page"]);
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

  it("keeps runtime route parameters aligned with the route type grammar", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) throw new Error("Missing app root.");
    createWindow("/");
    const router = createClientRouter({
      root,
      routes: [
        { path: "/", render: () => "home" },
        { path: "/files/*", render: ({ params }) => `${params.wildcard}` },
        { path: "/*rest/:id", render: ({ params }) => `${params.rest}:${params.id}` },
        { path: "/literal:tag", render: () => "literal" },
      ],
      scrollTo: () => undefined,
    });

    await router.start();
    await router.navigate("/files/a%20b");
    expect(root.textContent).toBe("a b");
    await router.navigate("/alpha/beta/42");
    expect(root.textContent).toBe("alpha/beta:42");
    await router.navigate("/literal:tag");
    expect(root.textContent).toBe("literal");
    router.dispose();
  });

  it("treats malformed encoded route parameters as a not-found route", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) throw new Error("Missing app root.");
    createWindow("/%E0%A4%A");
    const router = createClientRouter({
      root,
      routes: [{ path: "/users/:id", render: ({ params }) => params.id }],
      notFound: () => "not found",
      scrollTo: () => undefined,
    });

    await router.start();

    expect(root.textContent).toBe("not found");
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

  it("evicts the least recently used loader cache entry", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) throw new Error("Missing app root.");
    createWindow("/");
    const calls = new Map<string, number>();
    const route = (path: string): ClientRouteDefinition => ({
      path,
      load: () => {
        calls.set(path, (calls.get(path) ?? 0) + 1);
        return path;
      },
      render: ({ data }) => String(data),
    });
    const router = createClientRouter({
      root,
      routes: [route("/a"), route("/b"), route("/c")],
      cache: { maxEntries: 2 },
    });

    await router.prefetch("/a");
    await router.prefetch("/b");
    await router.prefetch("/a");
    await router.prefetch("/c");
    await router.navigate("/b");

    expect(Object.fromEntries(calls)).toEqual({ "/a": 1, "/b": 2, "/c": 1 });
    router.dispose();
  });

  it("shares one in-flight prefetch for concurrent requests to the same URL", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) throw new Error("Missing app root.");
    createWindow("/");
    let loads = 0;
    let release: ((value: string) => void) | undefined;
    const router = createClientRouter({
      root,
      routes: [
        { path: "/", render: () => "home" },
        {
          path: "/slow",
          load: () => {
            loads++;
            return new Promise((resolve) => {
              release = resolve;
            });
          },
          render: ({ data }) => String(data),
        },
      ],
    });

    const first = router.prefetch("/slow");
    const second = router.prefetch("/slow");
    await Promise.resolve();
    expect(loads).toBe(1);
    release?.("slow");
    await Promise.all([first, second]);
    router.dispose();
  });

  it("disables loader caching when maxEntries is zero", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) throw new Error("Missing app root.");
    createWindow("/");
    let loads = 0;
    const router = createClientRouter({
      root,
      routes: [{ path: "/a", load: () => ++loads, render: ({ data }) => String(data) }],
      cache: { maxEntries: 0 },
    });

    await router.navigate("/a");
    await router.navigate("/a");

    expect(loads).toBe(2);
    router.dispose();
  });

  it("reconciles managed head metadata on client navigation", async () => {
    document.head.innerHTML = `<meta name="viewport" content="width=device-width">`;
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing app root.");
    }
    createWindow("/");
    const router = createClientRouter({
      root,
      routes: [
        {
          path: "/",
          head: () => ({
            title: "Home",
            metas: [{ name: "description", content: "Home page" }],
            links: [{ rel: "canonical", href: "https://example.test/" }],
          }),
          render: () => rawHtml(`<a href="/about">About</a>`),
        },
        {
          path: "/about",
          head: () => ({
            title: "About",
            metas: [{ property: "og:title", content: "About page" }],
          }),
          render: () => rawHtml(`<h1>About</h1>`),
        },
      ],
      scrollTo: () => undefined,
    });

    await router.start();
    expect(document.title).toBe("Home");
    expect(document.head.querySelector(`meta[name="description"]`)?.getAttribute("content")).toBe("Home page");
    expect(document.head.querySelector(`link[rel="canonical"]`)?.getAttribute("href")).toBe("https://example.test/");

    await router.navigate("/about");

    expect(document.title).toBe("About");
    expect(document.head.querySelector(`meta[name="viewport"]`)).not.toBeNull();
    expect(document.head.querySelector(`meta[name="description"]`)).toBeNull();
    expect(document.head.querySelectorAll(`[data-tachyon-head="route"]`)).toHaveLength(1);
    expect(document.head.querySelector(`meta[property="og:title"]`)?.getAttribute("content")).toBe("About page");
    router.dispose();
  });

  it("applies the same URL policy to server and client head elements", async () => {
    document.head.innerHTML = "";
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) throw new Error("Missing app root.");
    createWindow("/");
    const descriptor: RouteHeadDescriptor = {
      metas: [
        { "http-equiv": "refresh", content: "0;url=javascript:alert(1)", "data-id": "refresh" },
        {
          "http-equiv": "not-refresh",
          "HTTP-EQUIV": "refresh",
          content: "0;url=javascript:alert(1)",
          "data-id": "case-fold-refresh",
        },
      ],
      links: [
        { rel: "stylesheet", href: "data:text/css,body{}", "data-id": "unsafe-link" },
        { rel: "stylesheet", href: "/app.css", "data-id": "safe-link" },
      ],
      scripts: [
        { src: "javascript:alert(1)", onload: "alert(2)", "data-id": "unsafe-script" },
        { src: "/app.js", "data-id": "safe-script" },
      ],
    };
    const router = createClientRouter({
      root,
      routes: [{ path: "/", head: () => descriptor, render: () => "Home" }],
    });

    await router.start();

    const normalized = (elements: readonly Element[]): unknown[] =>
      elements.map((element) => ({
        tag: element.localName,
        attributes: Object.fromEntries(
          [...element.attributes]
            .filter(({ name }) => name !== "data-tachyon-head")
            .map(({ name, value }) => [name, value] as const)
            .sort((left, right) => left[0].localeCompare(right[0])),
        ),
      }));
    const template = document.createElement("template");
    template.innerHTML = renderHead(descriptor);
    const serverElements = [...template.content.children];
    const clientElements = [...document.head.querySelectorAll(`[data-tachyon-head="route"]`)];

    expect(normalized(clientElements)).toEqual(normalized(serverElements));
    expect(document.head.querySelector(`[data-id="unsafe-link"]`)).toBeNull();
    expect(document.head.querySelector(`[data-id="refresh"]`)?.hasAttribute("content")).toBe(false);
    const caseFoldRefresh = document.head.querySelector(`[data-id="case-fold-refresh"]`);
    expect(caseFoldRefresh?.getAttribute("http-equiv")).toBe("not-refresh");
    expect(caseFoldRefresh?.attributes).toHaveLength(4);
    expect(document.head.querySelector(`[data-id="unsafe-script"]`)?.hasAttribute("src")).toBe(false);
    expect(document.head.querySelector(`[data-id="unsafe-script"]`)?.hasAttribute("onload")).toBe(false);
    expect(document.head.querySelector(`[data-id="safe-link"]`)?.getAttribute("href")).toBe("/app.css");
    expect(document.head.querySelector(`[data-id="safe-script"]`)?.getAttribute("src")).toBe("/app.js");
    router.dispose();
  });

  it("wraps client navigation commits in view transitions when enabled", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing app root.");
    }
    createWindow("/");
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
    const startViewTransition = vi.fn((update: () => Promise<void> | void) => {
      const updateCallbackDone = Promise.resolve(update());
      return { updateCallbackDone, finished: updateCallbackDone };
    });
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: startViewTransition });
    const router = createClientRouter({
      root,
      routes: [
        { path: "/", render: () => rawHtml(`<h1>Home</h1>`) },
        { path: "/next", render: () => rawHtml(`<h1>Next</h1>`) },
      ],
      scrollTo: () => undefined,
      viewTransition: true,
    });

    await router.start();
    await router.navigate("/next");

    expect(startViewTransition).toHaveBeenCalled();
    expect(root.innerHTML).toBe("<h1>Next</h1>");
    router.dispose();
  });

  it("skips view transitions when reduced motion is requested", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing app root.");
    }
    createWindow("/");
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    const startViewTransition = vi.fn((update: () => Promise<void> | void) => {
      const updateCallbackDone = Promise.resolve(update());
      return { updateCallbackDone, finished: updateCallbackDone };
    });
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: startViewTransition });
    const router = createClientRouter({
      root,
      routes: [
        { path: "/", render: () => rawHtml(`<h1>Home</h1>`) },
        { path: "/next", render: () => rawHtml(`<h1>Next</h1>`) },
      ],
      scrollTo: () => undefined,
      viewTransition: true,
    });

    await router.start();
    await router.navigate("/next");

    expect(startViewTransition).not.toHaveBeenCalled();
    expect(root.innerHTML).toBe("<h1>Next</h1>");
    router.dispose();
  });

  it("ignores a delayed view-transition callback after a newer navigation commits", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) throw new Error("Missing app root.");
    createWindow("/");
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
    const callbacks: Array<() => void | Promise<void>> = [];
    const releases: Array<() => void> = [];
    const startViewTransition = vi.fn((update: () => void | Promise<void>) => {
      const index = callbacks.push(update) - 1;
      if (index === 0 || index === 2) {
        const updateCallbackDone = Promise.resolve(update());
        return { updateCallbackDone, finished: updateCallbackDone };
      }
      const updateCallbackDone = new Promise<void>((resolve) => releases.push(resolve));
      return { updateCallbackDone, finished: updateCallbackDone };
    });
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: startViewTransition });
    const router = createClientRouter({
      root,
      routes: [
        { path: "/", render: () => rawHtml("<h1>Home</h1>") },
        { path: "/next", render: () => rawHtml("<h1>Next</h1>") },
        { path: "/fast", render: () => rawHtml("<h1>Fast</h1>") },
      ],
      scrollTo: () => undefined,
      viewTransition: true,
    });

    await router.start();
    const delayed = router.navigate("/next");
    await vi.waitFor(() => expect(callbacks).toHaveLength(2));
    await router.navigate("/fast");
    expect(root.textContent).toBe("Fast");
    callbacks[1]?.();
    releases[0]?.();
    await delayed;

    expect(root.textContent).toBe("Fast");
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

  it("aborts an in-flight action when the router is disposed", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) throw new Error("Missing app root.");
    createWindow("/");
    let signal: AbortSignal | undefined;
    const router = createClientRouter({
      root,
      routes: [
        { path: "/", render: () => "home" },
        {
          path: "/action",
          action: ({ signal: actionSignal }) => {
            signal = actionSignal;
            return new Promise<Response>(() => undefined);
          },
          render: () => "action",
        },
      ],
    });

    await router.start();
    void router.submit("/action");
    await Promise.resolve();
    router.dispose();

    expect(signal?.aborted).toBe(true);
  });

  it("composes caller cancellation with the router-owned action signal", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) throw new Error("Missing app root.");
    createWindow("/");
    const caller = new AbortController();
    let actionSignal: AbortSignal | undefined;
    let requestSignal: AbortSignal | undefined;
    let resolveAction: ((response: Response) => void) | undefined;
    const router = createClientRouter({
      root,
      routes: [
        { path: "/", render: () => "home" },
        {
          path: "/action",
          action: ({ signal, request }) => {
            actionSignal = signal;
            requestSignal = request.signal;
            return new Promise<Response>((resolve) => {
              resolveAction = resolve;
            });
          },
          render: () => "action",
        },
      ],
    });

    await router.start();
    const submission = router.submit("/action", { signal: caller.signal });
    await Promise.resolve();
    caller.abort();

    expect(actionSignal?.aborted).toBe(true);
    expect(requestSignal?.aborted).toBe(true);
    resolveAction?.(new Response("cancelled"));
    await submission;
    router.dispose();
  });

  it("prevents stale action redirects after a newer submission or navigation", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) throw new Error("Missing app root.");
    createWindow("/");
    const pending: Array<(response: Response) => void> = [];
    const router = createClientRouter({
      root,
      routes: [
        { path: "/", render: () => "home" },
        { path: "/new", render: () => "new" },
        { path: "/stale", render: () => "stale" },
        {
          path: "/action",
          action: () => new Promise<Response>((resolve) => pending.push(resolve)),
          render: () => "action",
        },
      ],
      scrollTo: () => undefined,
    });

    await router.start();
    const first = router.submit("/action");
    await Promise.resolve();
    const second = router.submit("/action");
    await Promise.resolve();
    pending[0]?.(new Response(null, { status: 302, headers: { location: "/stale" } }));
    pending[1]?.(new Response("ok"));
    await Promise.all([first, second]);
    expect(location.pathname).toBe("/");

    const third = router.submit("/action");
    await Promise.resolve();
    await router.navigate("/new");
    pending[2]?.(new Response(null, { status: 302, headers: { location: "/stale" } }));
    await third;
    expect(location.pathname).toBe("/new");
    expect(root.textContent).toBe("new");
    router.dispose();
  });

  it("propagates action errors without preventing a later submission", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) throw new Error("Missing app root.");
    createWindow("/");
    let attempts = 0;
    const router = createClientRouter({
      root,
      routes: [
        { path: "/", render: () => "home" },
        {
          path: "/action",
          action: () => {
            attempts += 1;
            if (attempts === 1) throw new Error("action failed");
            return new Response("ok");
          },
          render: () => "action",
        },
      ],
    });

    await router.start();
    await expect(router.submit("/action")).rejects.toThrow("action failed");
    await expect(router.submit("/action")).resolves.toBeInstanceOf(Response);
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
