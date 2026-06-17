export type ClientRouteParams = Record<string, string>;

export type ClientRouteContext<Data = unknown> = {
  url: URL;
  params: ClientRouteParams;
  data: Data;
  signal: AbortSignal;
};

export type ClientRouteDefinition<Data = unknown> = {
  id?: string;
  path: string;
  target?:
    | string
    | Element
    | ((context: { root: Element; url: URL; params: ClientRouteParams; data: Data }) => Element | undefined | null);
  load?: (context: Omit<ClientRouteContext<Data>, "data">) => Data | Promise<Data>;
  action?: (context: Omit<ClientRouteContext<Data>, "data"> & { request: Request }) => Response | Promise<Response>;
  revalidateOnAction?:
    | "self"
    | "all"
    | readonly string[]
    | ((context: { url: URL; response: Response }) => readonly string[]);
  render: (
    context: ClientRouteContext<Data>,
  ) => string | Node | readonly Node[] | DocumentFragment | Promise<string | Node | readonly Node[] | DocumentFragment>;
};

export type ClientRouterOptions = {
  root: Element;
  routes: readonly ClientRouteDefinition[];
  baseUrl?: string;
  notFound?: (context: { url: URL }) => string | Node | readonly Node[] | DocumentFragment;
  error?: (context: { url: URL; error: unknown }) => string | Node | readonly Node[] | DocumentFragment;
  scrollTo?: (x: number, y: number) => void;
  focusSelector?: string;
  cache?: boolean;
  initialCache?: readonly { href: string; data: unknown }[];
  eager?: boolean;
  liveRegion?: Element;
  title?: (context: { url: URL; data: unknown }) => string;
};

export type ClientRouter = {
  start: () => Promise<void>;
  navigate: (href: string, options?: { replace?: boolean }) => Promise<void>;
  submit: (href: string, init?: RequestInit) => Promise<Response>;
  prefetch: (href: string) => Promise<void>;
  revalidate: (hrefs?: string | readonly string[]) => Promise<void>;
  invalidate: (href?: string) => void;
  settled: () => Promise<void>;
  dispose: () => void;
};

export type RouteHotReloader = {
  accept: (update?: { routeIds?: readonly string[]; href?: string }) => Promise<void>;
};

export type RouteHotReloaderOptions = Pick<ClientRouter, "invalidate" | "navigate"> & {
  currentPath?: () => string;
  onUpdate?: (update: { routeIds?: readonly string[]; href: string }) => void | Promise<void>;
};

export type RouteHotApi = {
  on: (
    event: "tachyon-dom:routes-update",
    callback: (payload: { routeIds?: readonly string[]; href?: string }) => void,
  ) => void;
  dispose?: (callback: () => void) => void;
};

type ClientMatch = {
  route: ClientRouteDefinition;
  params: ClientRouteParams;
};

const trimSlashes = (value: string): string => value.replace(/^\/+|\/+$/g, "");

const compileRoutePath = (path: string): { regex: RegExp; names: string[]; wildcard: boolean } => {
  if (path === "*") {
    return { regex: /^.*$/, names: [], wildcard: true };
  }
  const names: string[] = [];
  const segments = trimSlashes(path).split("/").filter(Boolean);
  if (segments.length === 0) {
    return { regex: /^\/?$/, names, wildcard: false };
  }
  const source = segments
    .map((segment) => {
      if (segment.startsWith(":")) {
        names.push(segment.slice(1));
        return "([^/]+)";
      }
      if (segment === "*") {
        names.push("wildcard");
        return "(.*)";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { regex: new RegExp(`^/${source}/?$`), names, wildcard: false };
};

const matchClientRoute = (routes: readonly ClientRouteDefinition[], pathname: string): ClientMatch | undefined => {
  let fallback: ClientMatch | undefined;
  for (const route of routes) {
    const compiled = compileRoutePath(route.path);
    const match = compiled.regex.exec(pathname);
    if (!match) {
      continue;
    }
    const params = Object.fromEntries(
      compiled.names.map((name, index) => [name, decodeURIComponent(match[index + 1] ?? "")]),
    );
    const matched = { route, params };
    if (compiled.wildcard) {
      fallback = matched;
      continue;
    }
    return matched;
  }
  return fallback;
};

const toUrl = (href: string, baseUrl: string): URL => new URL(href, baseUrl);

const renderInto = (root: Element, value: string | Node | readonly Node[] | DocumentFragment): void => {
  root.replaceChildren();
  if (typeof value === "string") {
    root.innerHTML = value;
    return;
  }
  if (value instanceof DocumentFragment) {
    root.appendChild(value);
    return;
  }
  if (value instanceof Node) {
    root.appendChild(value);
    return;
  }
  root.append(...value);
};

const focusRouteContent = (root: Element, selector: string): void => {
  const target = root.querySelector(selector);
  if (target instanceof HTMLElement) {
    target.focus({ preventScroll: true });
  }
};

const routeTargetFor = (root: Element, match: ClientMatch, url: URL, data: unknown): Element => {
  const target = match.route.target;
  if (!target) {
    return root;
  }
  if (typeof target === "string") {
    return root.querySelector(target) ?? root;
  }
  if (target instanceof Element) {
    return target;
  }
  return target({ root, url, params: match.params, data }) ?? root;
};

const isModifiedClick = (event: MouseEvent): boolean =>
  event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;

export const createClientRouter = (options: ClientRouterOptions): ClientRouter => {
  const baseUrl = options.baseUrl ?? location.href;
  const scrollTo =
    options.scrollTo ??
    ((x: number, y: number) => {
      if (!navigator.userAgent.includes("jsdom")) {
        window.scrollTo(x, y);
      }
    });
  const focusSelector = options.focusSelector ?? "[autofocus],h1,[data-route-focus],main";
  let controller: AbortController | undefined;
  let currentNavigation: Promise<void> = Promise.resolve();
  const cache = new Map<string, unknown>();
  const eagerlyNavigated = new WeakSet<HTMLAnchorElement>();
  const cacheKey = (url: URL): string => `${url.pathname}${url.search}`;
  for (const entry of options.initialCache ?? []) {
    cache.set(cacheKey(toUrl(entry.href, baseUrl)), entry.data);
  }

  const renderNotFound = (url: URL): void => {
    renderInto(options.root, options.notFound ? options.notFound({ url }) : `<h1>Not Found</h1>`);
  };

  const renderError = (url: URL, error: unknown): void => {
    renderInto(options.root, options.error ? options.error({ url, error }) : `<h1>Navigation Error</h1>`);
  };

  const loadData = async (url: URL, match: ClientMatch, signal: AbortSignal): Promise<unknown> => {
    const key = cacheKey(url);
    if (options.cache && cache.has(key)) {
      return cache.get(key);
    }
    const data = match.route.load ? await match.route.load({ url, params: match.params, signal }) : undefined;
    if (options.cache && !signal.aborted) {
      cache.set(key, data);
    }
    return data;
  };

  const updateA11y = (url: URL, data: unknown): void => {
    if (options.title) {
      document.title = options.title({ url, data });
    }
    if (options.liveRegion) {
      options.liveRegion.textContent = `Navigated to ${url.pathname}`;
    }
  };

  const prefetch = async (href: string): Promise<void> => {
    const url = toUrl(href, location.href || baseUrl);
    const match = matchClientRoute(options.routes, url.pathname);
    if (!match) {
      return;
    }
    const prefetchController = new AbortController();
    await loadData(url, match, prefetchController.signal);
  };

  const revalidate = async (hrefs?: string | readonly string[]): Promise<void> => {
    if (!hrefs) {
      cache.clear();
    } else if (typeof hrefs === "string") {
      cache.delete(cacheKey(toUrl(hrefs, location.href || baseUrl)));
    } else {
      for (const href of hrefs) {
        cache.delete(cacheKey(toUrl(href, location.href || baseUrl)));
      }
    }
    await navigate(location.pathname + location.search + location.hash, { replace: true });
  };

  const hrefsForAction = (url: URL, match: ClientMatch, response: Response): string | readonly string[] | undefined => {
    const policy = match.route.revalidateOnAction ?? "self";
    if (policy === "all") {
      return undefined;
    }
    if (policy === "self") {
      return url.pathname + url.search;
    }
    if (typeof policy === "function") {
      return policy({ url, response });
    }
    return policy;
  };

  const submit = async (href: string, init: RequestInit = {}): Promise<Response> => {
    const url = toUrl(href, location.href || baseUrl);
    const match = matchClientRoute(options.routes, url.pathname);
    if (!match?.route.action) {
      throw new Error(`No action route matched ${url.pathname}.`);
    }
    const actionController = new AbortController();
    const request = new Request(url, { method: init.method ?? "POST", ...init, signal: actionController.signal });
    const response = await match.route.action({ url, params: match.params, signal: actionController.signal, request });
    const locationHeader = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && locationHeader) {
      await navigate(locationHeader, { replace: true });
      return response;
    }
    await revalidate(hrefsForAction(url, match, response));
    return response;
  };

  const navigate = async (href: string, navigateOptions: { replace?: boolean } = {}): Promise<void> => {
    controller?.abort();
    const nextController = new AbortController();
    controller = nextController;
    const url = toUrl(href, location.href || baseUrl);
    const match = matchClientRoute(options.routes, url.pathname);
    const task = (async () => {
      if (!match) {
        if (navigateOptions.replace) {
          history.replaceState({}, "", url);
        } else if (location.pathname !== url.pathname || location.search !== url.search) {
          history.pushState({}, "", url);
        }
        renderNotFound(url);
        scrollTo(0, 0);
        focusRouteContent(options.root, focusSelector);
        return;
      }
      let data: unknown;
      try {
        data = await loadData(url, match, nextController.signal);
        if (nextController.signal.aborted) {
          return;
        }
        const rendered = await match.route.render({ url, params: match.params, data, signal: nextController.signal });
        if (nextController.signal.aborted) {
          return;
        }
        if (navigateOptions.replace) {
          history.replaceState({}, "", url);
        } else if (location.pathname !== url.pathname || location.search !== url.search) {
          history.pushState({}, "", url);
        }
        const target = routeTargetFor(options.root, match, url, data);
        renderInto(target, rendered);
        scrollTo(0, 0);
        focusRouteContent(target, focusSelector);
        updateA11y(url, data);
      } catch (error) {
        if (!nextController.signal.aborted) {
          renderError(url, error);
        }
      }
    })();
    currentNavigation = task;
    await task;
  };

  const routeLinkForEvent = (event: Event): { link: HTMLAnchorElement; url: URL } | undefined => {
    if (!(event instanceof MouseEvent) || isModifiedClick(event)) {
      return undefined;
    }
    const target = event.target instanceof Element ? event.target : undefined;
    const link = target?.closest("a[href]");
    if (!(link instanceof HTMLAnchorElement) || !options.root.contains(link)) {
      return undefined;
    }
    if (link.target || link.hasAttribute("download")) {
      return undefined;
    }
    const url = new URL(link.href);
    if (url.origin !== location.origin || !matchClientRoute(options.routes, url.pathname)) {
      return undefined;
    }
    return { link, url };
  };

  const onPointerDown = (event: Event): void => {
    if (!options.eager) {
      return;
    }
    const routeLink = routeLinkForEvent(event);
    if (!routeLink || !cache.has(cacheKey(routeLink.url))) {
      return;
    }
    event.preventDefault();
    if (eagerlyNavigated.has(routeLink.link)) {
      return;
    }
    eagerlyNavigated.add(routeLink.link);
    void navigate(routeLink.url.pathname + routeLink.url.search + routeLink.url.hash);
  };

  const onClick = (event: Event): void => {
    const routeLink = routeLinkForEvent(event);
    if (!routeLink) {
      return;
    }
    event.preventDefault();
    if (eagerlyNavigated.has(routeLink.link)) {
      eagerlyNavigated.delete(routeLink.link);
      return;
    }
    void navigate(routeLink.url.pathname + routeLink.url.search + routeLink.url.hash);
  };

  const onPointerOver = (event: Event): void => {
    const target = event.target instanceof Element ? event.target : undefined;
    const link = target?.closest("a[href][data-prefetch]");
    if (!(link instanceof HTMLAnchorElement) || !options.root.contains(link)) {
      return;
    }
    const url = new URL(link.href);
    if (url.origin === location.origin) {
      void prefetch(url.pathname + url.search + url.hash);
    }
  };

  const onPopState = (): void => {
    void navigate(location.pathname + location.search + location.hash, { replace: true });
  };

  return {
    start: async () => {
      options.root.addEventListener("click", onClick);
      options.root.addEventListener("pointerdown", onPointerDown);
      options.root.addEventListener("mousedown", onPointerDown);
      options.root.addEventListener("pointerover", onPointerOver);
      addEventListener("popstate", onPopState);
      await navigate(location.pathname + location.search + location.hash, { replace: true });
    },
    navigate,
    submit,
    prefetch,
    revalidate,
    invalidate: (href?: string) => {
      if (!href) {
        cache.clear();
        return;
      }
      cache.delete(cacheKey(toUrl(href, location.href || baseUrl)));
    },
    settled: () => currentNavigation,
    dispose: () => {
      controller?.abort();
      options.root.removeEventListener("click", onClick);
      options.root.removeEventListener("pointerdown", onPointerDown);
      options.root.removeEventListener("mousedown", onPointerDown);
      options.root.removeEventListener("pointerover", onPointerOver);
      removeEventListener("popstate", onPopState);
    },
  };
};

export const createRouteHotReloader = (options: RouteHotReloaderOptions): RouteHotReloader => ({
  accept: async (update = {}) => {
    const href = update.href ?? options.currentPath?.() ?? `${location.pathname}${location.search}${location.hash}`;
    options.invalidate(href);
    await options.onUpdate?.({ ...update, href });
    await options.navigate(href, { replace: true });
  },
});

export const connectRouteHotReloader = (hot: RouteHotApi | undefined, reloader: RouteHotReloader): (() => void) => {
  if (!hot) {
    return () => undefined;
  }
  let disposed = false;
  hot.on("tachyon-dom:routes-update", (payload) => {
    if (!disposed) {
      void reloader.accept(payload);
    }
  });
  hot.dispose?.(() => {
    disposed = true;
  });
  return () => {
    disposed = true;
  };
};
