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
  load?: (context: Omit<ClientRouteContext<Data>, "data">) => Data | Promise<Data>;
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
};

export type ClientRouter = {
  start: () => Promise<void>;
  navigate: (href: string, options?: { replace?: boolean }) => Promise<void>;
  settled: () => Promise<void>;
  dispose: () => void;
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

  const renderNotFound = (url: URL): void => {
    renderInto(options.root, options.notFound ? options.notFound({ url }) : `<h1>Not Found</h1>`);
  };

  const renderError = (url: URL, error: unknown): void => {
    renderInto(options.root, options.error ? options.error({ url, error }) : `<h1>Navigation Error</h1>`);
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
        data = match.route.load
          ? await match.route.load({ url, params: match.params, signal: nextController.signal })
          : undefined;
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
        renderInto(options.root, rendered);
        scrollTo(0, 0);
        focusRouteContent(options.root, focusSelector);
      } catch (error) {
        if (!nextController.signal.aborted) {
          renderError(url, error);
        }
      }
    })();
    currentNavigation = task;
    await task;
  };

  const onClick = (event: Event): void => {
    if (!(event instanceof MouseEvent) || isModifiedClick(event)) {
      return;
    }
    const target = event.target instanceof Element ? event.target : undefined;
    const link = target?.closest("a[href]");
    if (!(link instanceof HTMLAnchorElement) || !options.root.contains(link)) {
      return;
    }
    if (link.target || link.hasAttribute("download")) {
      return;
    }
    const url = new URL(link.href);
    if (url.origin !== location.origin || !matchClientRoute(options.routes, url.pathname)) {
      return;
    }
    event.preventDefault();
    void navigate(url.pathname + url.search + url.hash);
  };

  const onPopState = (): void => {
    void navigate(location.pathname + location.search + location.hash, { replace: true });
  };

  return {
    start: async () => {
      options.root.addEventListener("click", onClick);
      addEventListener("popstate", onPopState);
      await navigate(location.pathname + location.search + location.hash, { replace: true });
    },
    navigate,
    settled: () => currentNavigation,
    dispose: () => {
      controller?.abort();
      options.root.removeEventListener("click", onClick);
      removeEventListener("popstate", onPopState);
    },
  };
};
