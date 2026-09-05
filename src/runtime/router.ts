import { isClientHtml, rawHtml, type ClientHtml } from "./html.js";
import { sanitizeHeadAttributes } from "../head-policy.js";

export { rawHtml, type ClientHtml } from "./html.js";

export type ClientRouteParams = Record<string, string>;

export type ClientRouteContext<Data = unknown, Params extends ClientRouteParams = ClientRouteParams> = {
  url: URL;
  params: Params;
  data: Data;
  signal: AbortSignal;
};

export type ClientRenderValue = string | ClientHtml | Node | readonly Node[] | DocumentFragment;

export type ClientMountedView = {
  value: ClientRenderValue;
  dispose: () => void;
};

export type ClientRenderResult = ClientRenderValue | ClientMountedView;

export type ClientHeadDescriptor = {
  title?: string;
  metas?: Array<Record<string, string>>;
  links?: Array<Record<string, string>>;
  scripts?: Array<Record<string, string>>;
};

export type ClientRouteDefinition<Data = unknown, Params extends ClientRouteParams = ClientRouteParams> = {
  id?: string;
  path: string;
  children?: readonly ClientRouteDefinition<any, any>[];
  target?:
    | string
    | Element
    | ((context: { root: Element; url: URL; params: Params; data: Data }) => Element | undefined | null);
  load?: (context: Omit<ClientRouteContext<Data, Params>, "data">) => Data | Promise<Data>;
  head?: (context: ClientRouteContext<Data, Params>) => ClientHeadDescriptor | Promise<ClientHeadDescriptor>;
  action?: (
    context: Omit<ClientRouteContext<Data, Params>, "data"> & { request: Request },
  ) => Response | Promise<Response>;
  revalidateOnAction?:
    | "self"
    | "all"
    | readonly string[]
    | ((context: { url: URL; response: Response }) => readonly string[]);
  render: (context: ClientRouteContext<Data, Params>) => ClientRenderResult | Promise<ClientRenderResult>;
};

type TrimRoutePath<Path extends string> = Path extends `/${infer Rest}`
  ? TrimRoutePath<Rest>
  : Path extends `${infer Rest}/`
    ? TrimRoutePath<Rest>
    : Path;

type ClientParamsForSegment<Segment extends string> = Segment extends `:${infer Param}`
  ? Param extends ""
    ? {}
    : { [Key in Param]: string }
  : Segment extends `*${infer Param}`
    ? { [Key in Param extends "" ? "wildcard" : Param]: string }
    : {};

type ClientParamsForSegments<Path extends string> = Path extends `${infer Segment}/${infer Rest}`
  ? ClientParamsForSegment<Segment> & ClientParamsForSegments<Rest>
  : ClientParamsForSegment<Path>;

type ExpandClientParams<Params> = { [Key in keyof Params]: Params[Key] };

export type ClientParamsForPath<Path extends string> = string extends Path
  ? ClientRouteParams
  : Path extends "*"
    ? {}
    : ExpandClientParams<ClientParamsForSegments<TrimRoutePath<Path>>>;

export type ClientRouteDefinitionInput<Path extends string, Data> = Omit<
  ClientRouteDefinition<Data, ClientParamsForPath<Path>>,
  "path" | "children"
> & {
  path: Path;
  children?: readonly ClientRouteDefinition<any, any>[];
};

type ClientRouteDefinitionWithLoader<Path extends string, Data> = Omit<
  ClientRouteDefinition<Data, ClientParamsForPath<Path>>,
  "path" | "children" | "load"
> & {
  path: Path;
  load: (context: Omit<ClientRouteContext<unknown, ClientParamsForPath<Path>>, "data">) => Data | Promise<Data>;
  children?: readonly ClientRouteDefinition<any, any>[];
};

export function defineClientRoute<const Path extends string, Data>(
  definition: ClientRouteDefinitionWithLoader<Path, Data>,
): ClientRouteDefinition<Data, ClientParamsForPath<Path>>;
export function defineClientRoute<const Path extends string>(
  definition: ClientRouteDefinitionInput<Path, unknown>,
): ClientRouteDefinition<unknown, ClientParamsForPath<Path>>;
export function defineClientRoute(definition: ClientRouteDefinition<any, any>): ClientRouteDefinition<any, any> {
  return definition;
}

export type ClientRouterOptions = {
  root: Element;
  routes: readonly ClientRouteDefinition<any, any>[];
  baseUrl?: string;
  notFound?: (context: { url: URL }) => ClientRenderValue;
  error?: (context: { url: URL; error: unknown }) => ClientRenderValue;
  scrollTo?: (x: number, y: number) => void;
  focusSelector?: string;
  cache?: boolean | { maxEntries?: number };
  initialCache?: readonly { href: string; data: unknown }[];
  eager?: boolean;
  liveRegion?: Element;
  title?: (context: { url: URL; data: unknown }) => string;
  viewTransition?: boolean | ((context: { url: URL; params: ClientRouteParams; data: unknown }) => boolean);
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

type NavigateOptions = {
  replace?: boolean;
  restoreScroll?: boolean;
};

type ViewTransitionResult = {
  updateCallbackDone?: Promise<unknown>;
  finished?: Promise<unknown>;
};

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void | Promise<void>) => ViewTransitionResult;
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
  branch: readonly ClientRouteDefinition[];
  params: ClientRouteParams;
};

const loadedClientBranchBrand = Symbol("tachyon.loadedClientBranch");

type LoadedClientBranch = {
  [loadedClientBranchBrand]: true;
  dataByRoute: Map<ClientRouteDefinition, unknown>;
  leafData: unknown;
};

type RankedClientRoute = {
  route: ClientRouteDefinition;
  order: number;
};

type CompiledClientRoute = RankedClientRoute & {
  branch: readonly ClientRouteDefinition[];
  fullPath: string;
  regex: RegExp;
  names: string[];
  wildcard: boolean;
  specificity: number[];
};

type LayoutState = {
  root: Element;
  loaded: LoadedClientBranch;
  paramsKey: string;
  searchKey: string;
  dispose: () => void;
};

type PrefetchEntry = {
  controller: AbortController;
  promise: Promise<void>;
};

const trimSlashes = (value: string): string => value.replace(/^\/+|\/+$/g, "");

const joinRoutePaths = (parent: string, child: string): string => {
  if (child === "*") {
    return "*";
  }
  if (child.startsWith("/")) {
    return child === "/" ? "/" : `/${trimSlashes(child)}`;
  }
  const joined = [trimSlashes(parent), trimSlashes(child)].filter(Boolean).join("/");
  return joined ? `/${joined}` : "/";
};

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
      if (segment === "*" || segment.startsWith("*")) {
        names.push(segment.slice(1) || "wildcard");
        return "(.*)";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { regex: new RegExp(`^/${source}/?$`), names, wildcard: false };
};

const routeSegmentScore = (segment: string): number => {
  if (segment === "*" || segment.startsWith("*")) {
    return 0;
  }
  if (segment.startsWith(":")) {
    return 1;
  }
  return 2;
};

const routeSpecificity = (path: string): number[] => {
  if (path === "*") {
    return [-1, 0, 0];
  }
  const segments = trimSlashes(path).split("/").filter(Boolean);
  const segmentScores = segments.map(routeSegmentScore);
  return [
    segmentScores.reduce((total, score) => total + score, 0),
    segments.length,
    segmentScores.filter((score) => score === 2).length,
  ];
};

const compareCompiledClientRoutes = (left: CompiledClientRoute, right: CompiledClientRoute): number => {
  for (let index = 0; index < left.specificity.length; index += 1) {
    const difference = (right.specificity[index] ?? 0) - (left.specificity[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.order - right.order;
};

const flattenClientRoutes = (
  routes: readonly ClientRouteDefinition[],
  parentPath = "",
  parentBranch: readonly ClientRouteDefinition[] = [],
  orderOffset = { value: 0 },
): CompiledClientRoute[] => {
  const entries: CompiledClientRoute[] = [];
  for (const route of routes) {
    const fullPath = joinRoutePaths(parentPath, route.path);
    const compiled = compileRoutePath(fullPath);
    const branch = [...parentBranch, route];
    entries.push({
      route,
      branch,
      fullPath,
      order: orderOffset.value++,
      names: compiled.names,
      regex: compiled.regex,
      specificity: routeSpecificity(fullPath),
      wildcard: compiled.wildcard,
    });
    if (route.children) {
      entries.push(...flattenClientRoutes(route.children, fullPath, branch, orderOffset));
    }
  }
  return entries;
};

const compileClientRoutes = (routes: readonly ClientRouteDefinition[]): readonly CompiledClientRoute[] =>
  flattenClientRoutes(routes).sort(compareCompiledClientRoutes);

const matchClientRoute = (routes: readonly CompiledClientRoute[], pathname: string): ClientMatch | undefined => {
  let fallback: ClientMatch | undefined;
  for (const routeEntry of routes) {
    const match = routeEntry.regex.exec(pathname);
    if (!match) {
      continue;
    }
    const params = Object.fromEntries(
      routeEntry.names.map((name, index) => [name, decodeURIComponent(match[index + 1] ?? "")]),
    );
    const matched = { route: routeEntry.route, branch: routeEntry.branch, params };
    if (routeEntry.wildcard) {
      fallback = matched;
      continue;
    }
    return matched;
  }
  return fallback;
};

const toUrl = (href: string, baseUrl: string): URL => new URL(href, baseUrl);

const isClientMountedView = (value: ClientRenderResult): value is ClientMountedView =>
  typeof value === "object" &&
  value !== null &&
  "value" in value &&
  "dispose" in value &&
  typeof value.dispose === "function";

const viewValue = (value: ClientRenderResult): ClientRenderValue => (isClientMountedView(value) ? value.value : value);

const disposeRenderResult = (value: ClientRenderResult | undefined): void => {
  if (value && isClientMountedView(value)) value.dispose();
};

const once = (dispose: () => void): (() => void) => {
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    dispose();
  };
};

const runDisposers = (disposers: readonly (() => void)[]): void => {
  let firstError: unknown;
  let failed = false;
  for (const dispose of disposers) {
    try {
      dispose();
    } catch (error) {
      if (!failed) firstError = error;
      failed = true;
    }
  }
  if (failed) throw firstError;
};

const renderInto = (root: Element, value: ClientRenderResult): (() => void) => {
  const mountedDispose = isClientMountedView(value) ? once(value.dispose) : undefined;
  const renderedValue = viewValue(value);
  root.replaceChildren();
  if (isClientHtml(renderedValue)) {
    root.innerHTML = renderedValue.toString();
    return mountedDispose ?? (() => undefined);
  }
  if (typeof renderedValue === "string") {
    root.textContent = renderedValue;
    return mountedDispose ?? (() => undefined);
  }
  if (renderedValue instanceof DocumentFragment) {
    root.appendChild(renderedValue);
    return mountedDispose ?? (() => undefined);
  }
  if (renderedValue instanceof Node) {
    root.appendChild(renderedValue);
    return mountedDispose ?? (() => undefined);
  }
  root.append(...renderedValue);
  return mountedDispose ?? (() => undefined);
};

const focusRouteContent = (root: Element, selector: string): void => {
  const target = root.querySelector(selector);
  if (target instanceof HTMLElement) {
    target.focus({ preventScroll: true });
  }
};

const managedHeadSelector = `[data-tachyon-head="route"]`;
const maxScrollPositions = 50;

const appendManagedHeadElement = (tagName: "meta" | "link" | "script", attributes: Record<string, string>): void => {
  const safeAttributes = sanitizeHeadAttributes(tagName, attributes, { dropOnUnsafeUrl: tagName === "link" });
  if (!safeAttributes) return;
  const element = document.createElement(tagName);
  element.setAttribute("data-tachyon-head", "route");
  for (const [name, value] of Object.entries(safeAttributes)) {
    element.setAttribute(name, value);
  }
  document.head.appendChild(element);
};

const applyHead = (descriptor: ClientHeadDescriptor | undefined): void => {
  document.head.querySelectorAll(managedHeadSelector).forEach((element) => element.remove());
  if (!descriptor) {
    return;
  }
  if (descriptor.title !== undefined) {
    document.title = descriptor.title;
  }
  for (const meta of descriptor.metas ?? []) {
    appendManagedHeadElement("meta", meta);
  }
  for (const link of descriptor.links ?? []) {
    appendManagedHeadElement("link", link);
  }
  for (const script of descriptor.scripts ?? []) {
    appendManagedHeadElement("script", script);
  }
};

const mergeHead = (heads: readonly ClientHeadDescriptor[]): ClientHeadDescriptor | undefined => {
  if (heads.length === 0) {
    return undefined;
  }
  const title = [...heads].reverse().find((head) => head.title !== undefined)?.title;
  return {
    ...(title === undefined ? {} : { title }),
    metas: heads.flatMap((head) => head.metas ?? []),
    links: heads.flatMap((head) => head.links ?? []),
    scripts: heads.flatMap((head) => head.scripts ?? []),
  };
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

const outletFor = (root: Element): Element | undefined =>
  root.querySelector("[data-tachyon-outlet], [data-tachyon-route-outlet], tachyon-outlet") ?? undefined;

const isModifiedClick = (event: MouseEvent): boolean =>
  event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;

export const createClientRouter = (options: ClientRouterOptions): ClientRouter => {
  const baseUrl = options.baseUrl ?? location.href;
  const routes = compileClientRoutes(options.routes);
  const scrollTo =
    options.scrollTo ??
    ((x: number, y: number) => {
      if (!navigator.userAgent.includes("jsdom")) {
        window.scrollTo(x, y);
      }
    });
  const focusSelector = options.focusSelector ?? "[autofocus],h1,[data-route-focus],main";
  let controller: AbortController | undefined;
  let actionController: AbortController | undefined;
  let actionVersion = 0;
  let navigationGeneration = 0;
  let disposed = false;
  let started = false;
  let currentNavigation: Promise<void> = Promise.resolve();
  let committedView: { target: Element; dispose: () => void } | undefined;
  const cache = new Map<string, unknown>();
  const cacheLimit =
    options.cache === true
      ? 100
      : typeof options.cache === "object"
        ? Number.isFinite(options.cache.maxEntries)
          ? Math.max(0, Math.floor(options.cache.maxEntries ?? 100))
          : 100
        : 0;
  const layoutStates = new Map<ClientRouteDefinition, LayoutState>();
  const prefetchEntries = new Map<string, PrefetchEntry>();
  const eagerlyNavigated = new WeakSet<HTMLAnchorElement>();
  const scrollPositions = new Map<number, { x: number; y: number }>();
  let nextScrollKey = 1;
  const cacheKey = (url: URL): string => `${url.pathname}${url.search}`;
  const isCurrentNavigation = (signal: AbortSignal, generation: number): boolean =>
    !disposed && !signal.aborted && navigationGeneration === generation;
  const disposeCommittedView = (): void => {
    const current = committedView;
    committedView = undefined;
    if (current) runDisposers([current.dispose]);
  };
  const disposeLayoutStates = (): void => {
    const states = Array.from(layoutStates.values());
    layoutStates.clear();
    runDisposers(states.map((state) => state.dispose));
  };
  const writeCache = (key: string, value: unknown): void => {
    if (cacheLimit === 0) return;
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > cacheLimit) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };
  const readCache = (key: string): { hit: boolean; value?: unknown } => {
    if (cacheLimit === 0 || !cache.has(key)) return { hit: false };
    const value = cache.get(key);
    cache.delete(key);
    cache.set(key, value);
    return { hit: true, value };
  };
  for (const entry of options.initialCache ?? []) {
    writeCache(cacheKey(toUrl(entry.href, baseUrl)), entry.data);
  }

  const renderNotFound = (url: URL): void => {
    let cleanupError: unknown;
    let cleanupFailed = false;
    try {
      disposeLayoutStates();
    } catch (error) {
      cleanupError = error;
      cleanupFailed = true;
    }
    try {
      disposeCommittedView();
      const value = options.notFound ? options.notFound({ url }) : rawHtml(`<h1>Not Found</h1>`);
      committedView = { target: options.root, dispose: renderInto(options.root, value) };
    } catch (error) {
      if (cleanupFailed) throw new AggregateError([cleanupError, error], "Route fallback cleanup and render failed.");
      throw error;
    }
    if (cleanupFailed) throw cleanupError;
  };

  const renderError = (url: URL, error: unknown): void => {
    let cleanupError: unknown;
    let cleanupFailed = false;
    try {
      disposeLayoutStates();
    } catch (disposeError) {
      cleanupError = disposeError;
      cleanupFailed = true;
    }
    try {
      disposeCommittedView();
      const value = options.error ? options.error({ url, error }) : rawHtml(`<h1>Navigation Error</h1>`);
      committedView = { target: options.root, dispose: renderInto(options.root, value) };
    } catch (renderErrorValue) {
      if (cleanupFailed) {
        throw new AggregateError([cleanupError, renderErrorValue], "Route error cleanup and render failed.");
      }
      throw renderErrorValue;
    }
    if (cleanupFailed) throw cleanupError;
  };

  const isLoadedClientBranch = (value: unknown): value is LoadedClientBranch =>
    typeof value === "object" &&
    value !== null &&
    loadedClientBranchBrand in value &&
    (value as LoadedClientBranch)[loadedClientBranchBrand] === true;

  const loadData = async (url: URL, match: ClientMatch, signal: AbortSignal): Promise<LoadedClientBranch> => {
    const key = cacheKey(url);
    const cachedEntry = readCache(key);
    const cached = cachedEntry.value;
    if (isLoadedClientBranch(cached)) {
      return cached;
    }
    const hasLeafSeed = cachedEntry.hit;
    const dataByRoute = new Map<ClientRouteDefinition, unknown>();
    for (const route of match.branch) {
      if (signal.aborted) {
        break;
      }
      const data =
        route === match.route && hasLeafSeed
          ? cached
          : route.load
            ? await route.load({ url, params: match.params, signal })
            : undefined;
      dataByRoute.set(route, data);
    }
    const loaded: LoadedClientBranch = {
      [loadedClientBranchBrand]: true,
      dataByRoute,
      leafData: dataByRoute.get(match.route),
    };
    if (!signal.aborted) {
      writeCache(key, loaded);
    }
    return loaded;
  };

  const updateA11y = (url: URL, data: unknown): void => {
    if (options.title) {
      document.title = options.title({ url, data });
    }
    if (options.liveRegion) {
      options.liveRegion.textContent = `Navigated to ${url.pathname}`;
    }
  };

  const updateHead = async (
    url: URL,
    match: ClientMatch,
    loaded: LoadedClientBranch,
    signal: AbortSignal,
    generation: number,
  ): Promise<void> => {
    const heads: ClientHeadDescriptor[] = [];
    for (const route of match.branch) {
      if (!isCurrentNavigation(signal, generation)) {
        return;
      }
      if (route.head) {
        heads.push(await route.head({ url, params: match.params, data: loaded.dataByRoute.get(route), signal }));
      }
    }
    if (isCurrentNavigation(signal, generation)) {
      applyHead(mergeHead(heads));
    }
  };

  const shouldUseViewTransition = (url: URL, match: ClientMatch, data: unknown): boolean => {
    const setting = options.viewTransition;
    if (!setting) {
      return false;
    }
    if (typeof (document as ViewTransitionDocument).startViewTransition !== "function") {
      return false;
    }
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return false;
    }
    return typeof setting === "function" ? setting({ url, params: match.params, data }) : true;
  };

  const commitNavigation = async (
    url: URL,
    match: ClientMatch,
    loaded: LoadedClientBranch,
    rendered: ClientRenderResult,
    navigateOptions: NavigateOptions,
    signal: AbortSignal,
    generation: number,
  ): Promise<void> => {
    if (!isCurrentNavigation(signal, generation)) {
      disposeRenderResult(rendered);
      return;
    }
    const target = routeTargetFor(options.root, match, url, loaded.leafData);
    let committedTarget = target;
    const renderNestedBranch = async (): Promise<void> => {
      const previousStates = new Map(layoutStates);
      const nextStates = new Map<ClientRouteDefinition, LayoutState>();
      const preparedLayoutDisposers: Array<() => void> = [];
      let leafDispose: (() => void) | undefined;
      let leafPrepared = false;
      let committed = false;
      let cleanupAttempted = false;
      let commitTarget: Element | undefined;
      const cleanupPrepared = (): void => {
        if (cleanupAttempted) return;
        cleanupAttempted = true;
        const disposers = [...preparedLayoutDisposers];
        if (leafPrepared && leafDispose) {
          disposers.push(leafDispose);
        } else {
          disposers.push(() => disposeRenderResult(rendered));
        }
        runDisposers(disposers);
      };
      let parentTarget = target;
      const paramsKey = JSON.stringify(match.params);
      const searchKey = url.search;
      try {
        let stagingTarget: Element | undefined;
        for (const layoutRoute of match.branch.slice(0, -1)) {
          const layoutState = previousStates.get(layoutRoute);
          let layoutRoot = layoutState?.root;
          const canReuse =
            !stagingTarget &&
            !!layoutRoot?.isConnected &&
            layoutState?.paramsKey === paramsKey &&
            layoutState?.searchKey === searchKey &&
            (layoutRoute.load === undefined || layoutState?.loaded === loaded);
          if (canReuse && layoutState) {
            nextStates.set(layoutRoute, layoutState);
          } else {
            const layoutValue = await layoutRoute.render({
              url,
              params: match.params,
              data: loaded.dataByRoute.get(layoutRoute),
              signal,
            } as ClientRouteContext);
            if (!isCurrentNavigation(signal, generation)) {
              disposeRenderResult(layoutValue);
              cleanupPrepared();
              return;
            }
            const layoutHost = document.createElement("div");
            let layoutDispose: () => void;
            try {
              layoutDispose = renderInto(layoutHost, layoutValue);
            } catch (error) {
              disposeRenderResult(layoutValue);
              throw error;
            }
            preparedLayoutDisposers.push(layoutDispose);
            layoutRoot = layoutHost.firstElementChild ?? layoutHost;
            if (!stagingTarget) {
              stagingTarget = layoutHost;
              commitTarget = parentTarget;
            }
            else parentTarget.replaceChildren(...Array.from(layoutHost.childNodes));
            const nextState: LayoutState = { root: layoutRoot, loaded, paramsKey, searchKey, dispose: layoutDispose };
            nextStates.set(layoutRoute, nextState);
          }
          if (!layoutRoot) {
            throw new Error(`Nested client route ${layoutRoute.id ?? layoutRoute.path} has no layout root.`);
          }
          const outlet = outletFor(layoutRoot);
          if (!outlet) {
            throw new Error(`Nested client route ${layoutRoute.id ?? layoutRoute.path} must render a route outlet.`);
          }
          parentTarget = outlet;
        }
        if (!isCurrentNavigation(signal, generation)) {
          cleanupPrepared();
          return;
        }
        const leafHost = document.createElement("div");
        try {
          leafDispose = renderInto(leafHost, rendered);
        } catch (error) {
          disposeRenderResult(rendered);
          throw error;
        }
        leafPrepared = true;
        if (stagingTarget) parentTarget.replaceChildren(...Array.from(leafHost.childNodes));
        else {
          stagingTarget = leafHost;
          commitTarget = parentTarget;
        }
        if (!isCurrentNavigation(signal, generation) || !leafDispose) {
          cleanupPrepared();
          return;
        }
        const oldCommitted = committedView;
        const oldStates = Array.from(previousStates.values());
        const retainedStates = new Set(nextStates.values());
        if (!commitTarget) throw new Error("Nested client route did not produce a commit target.");
        commitTarget.replaceChildren(...Array.from(stagingTarget.childNodes));
        layoutStates.clear();
        for (const [route, state] of nextStates) layoutStates.set(route, state);
        committedView = { target: parentTarget, dispose: leafDispose };
        committedTarget = parentTarget;
        committed = true;
        const obsoleteDisposers = oldStates
          .reverse()
          .filter((state) => !retainedStates.has(state))
          .map((state) => state.dispose);
        runDisposers([...(oldCommitted ? [oldCommitted.dispose] : []), ...obsoleteDisposers]);
      } catch (error) {
        if (!committed) {
          try {
            cleanupPrepared();
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], "Nested route preparation and cleanup failed.");
          }
        }
        throw error;
      }
    };
    const commit = async (): Promise<void> => {
      if (!isCurrentNavigation(signal, generation)) {
        disposeRenderResult(rendered);
        return;
      }
      if (match.branch.length > 1) {
        await renderNestedBranch();
      } else {
        if (!isCurrentNavigation(signal, generation)) {
          disposeRenderResult(rendered);
          return;
        }
        const leafHost = document.createElement("div");
        let leafDispose: () => void;
        try {
          leafDispose = renderInto(leafHost, rendered);
        } catch (error) {
          disposeRenderResult(rendered);
          throw error;
        }
        if (!isCurrentNavigation(signal, generation)) {
          leafDispose();
          return;
        }
        const oldCommitted = committedView;
        const oldStates = Array.from(layoutStates.values()).reverse();
        target.replaceChildren(...Array.from(leafHost.childNodes));
        layoutStates.clear();
        committedView = { target, dispose: leafDispose };
        committedTarget = target;
        runDisposers([...(oldCommitted ? [oldCommitted.dispose] : []), ...oldStates.map((state) => state.dispose)]);
      }
      await updateHead(url, match, loaded, signal, generation);
      if (!isCurrentNavigation(signal, generation)) {
        return;
      }
      restoreOrScroll(url, navigateOptions);
      focusRouteContent(committedTarget, focusSelector);
      updateA11y(url, loaded.leafData);
    };
    if (!shouldUseViewTransition(url, match, loaded.leafData)) {
      await commit();
      return;
    }
    const transition = (document as ViewTransitionDocument).startViewTransition?.(commit);
    await (transition?.updateCallbackDone ?? transition?.finished ?? Promise.resolve());
  };

  const scrollKeyFor = (state: unknown): number | undefined => {
    if (!state || typeof state !== "object") {
      return undefined;
    }
    const value = (state as Record<string, unknown>).__tachyonScrollKey;
    return typeof value === "number" ? value : undefined;
  };

  const ensureScrollState = (): number => {
    const existing = scrollKeyFor(history.state);
    if (existing !== undefined) {
      return existing;
    }
    const key = nextScrollKey++;
    history.replaceState(
      { ...(history.state && typeof history.state === "object" ? history.state : {}), __tachyonScrollKey: key },
      "",
      location.href,
    );
    return key;
  };

  const currentScrollPosition = (): { x: number; y: number } => ({
    x: window.scrollX ?? window.pageXOffset ?? 0,
    y: window.scrollY ?? window.pageYOffset ?? 0,
  });

  const rememberScrollPosition = (key: number, position: { x: number; y: number }): void => {
    if (scrollPositions.has(key)) {
      scrollPositions.delete(key);
    }
    scrollPositions.set(key, position);
    while (scrollPositions.size > maxScrollPositions) {
      const oldestKey = scrollPositions.keys().next().value;
      if (oldestKey === undefined) {
        return;
      }
      scrollPositions.delete(oldestKey);
    }
  };

  const saveCurrentScrollPosition = (): void => {
    rememberScrollPosition(ensureScrollState(), currentScrollPosition());
  };

  const writeHistory = (url: URL, navigateOptions: NavigateOptions): void => {
    const state = {
      ...(history.state && typeof history.state === "object" ? history.state : {}),
      __tachyonScrollKey: navigateOptions.restoreScroll
        ? (scrollKeyFor(history.state) ?? nextScrollKey++)
        : nextScrollKey++,
    };
    if (navigateOptions.restoreScroll) {
      return;
    }
    if (navigateOptions.replace) {
      history.replaceState(state, "", url);
    } else if (location.pathname !== url.pathname || location.search !== url.search || location.hash !== url.hash) {
      history.pushState(state, "", url);
    }
  };

  const scrollHashIntoView = (url: URL): boolean => {
    if (!url.hash) {
      return false;
    }
    const id = decodeURIComponent(url.hash.slice(1));
    const namedTarget =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? document.querySelector(`[name="${CSS.escape(id)}"]`)
        : null;
    const target = document.getElementById(id) ?? namedTarget;
    if (target instanceof HTMLElement || target instanceof SVGElement) {
      target.scrollIntoView();
      return true;
    }
    return false;
  };

  const restoreOrScroll = (url: URL, navigateOptions: NavigateOptions): void => {
    if (navigateOptions.restoreScroll) {
      const key = scrollKeyFor(history.state);
      const position = key === undefined ? undefined : scrollPositions.get(key);
      if (key !== undefined && position) {
        rememberScrollPosition(key, position);
      }
      scrollTo(position?.x ?? 0, position?.y ?? 0);
      return;
    }
    if (!scrollHashIntoView(url)) {
      scrollTo(0, 0);
    }
  };

  const prefetch = async (href: string): Promise<void> => {
    if (disposed) return;
    const url = toUrl(href, location.href || baseUrl);
    const match = matchClientRoute(routes, url.pathname);
    if (!match) {
      return;
    }
    const key = cacheKey(url);
    const existing = prefetchEntries.get(key);
    if (existing) {
      await existing.promise;
      return;
    }
    const prefetchController = new AbortController();
    const promise = loadData(url, match, prefetchController.signal).then(() => undefined);
    const entry = { controller: prefetchController, promise };
    prefetchEntries.set(key, entry);
    try {
      await promise;
    } finally {
      if (prefetchEntries.get(key) === entry) prefetchEntries.delete(key);
    }
  };

  const revalidate = async (hrefs?: string | readonly string[]): Promise<void> => {
    if (disposed) return;
    if (!hrefs) {
      cache.clear();
      prefetchEntries.forEach((entry) => entry.controller.abort());
      prefetchEntries.clear();
    } else if (typeof hrefs === "string") {
      const key = cacheKey(toUrl(hrefs, location.href || baseUrl));
      cache.delete(key);
      prefetchEntries.get(key)?.controller.abort();
      prefetchEntries.delete(key);
    } else {
      for (const href of hrefs) {
        const key = cacheKey(toUrl(href, location.href || baseUrl));
        cache.delete(key);
        prefetchEntries.get(key)?.controller.abort();
        prefetchEntries.delete(key);
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
    if (disposed) {
      throw new Error("Client router is disposed.");
    }
    const url = toUrl(href, location.href || baseUrl);
    const match = matchClientRoute(routes, url.pathname);
    if (!match?.route.action) {
      throw new Error(`No action route matched ${url.pathname}.`);
    }
    actionController?.abort();
    const nextActionController = new AbortController();
    actionController = nextActionController;
    const version = ++actionVersion;
    const callerSignal = init.signal;
    const abortFromCaller = (): void => nextActionController.abort(callerSignal?.reason);
    if (callerSignal?.aborted) {
      abortFromCaller();
    } else {
      callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
    }
    const request = new Request(url, { method: init.method ?? "POST", ...init, signal: nextActionController.signal });
    try {
      const response = await match.route.action({
        url,
        params: match.params,
        signal: nextActionController.signal,
        request,
      });
      if (nextActionController.signal.aborted || version !== actionVersion) {
        return response;
      }
      const locationHeader = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && locationHeader) {
        await navigate(locationHeader, { replace: true });
        return response;
      }
      await revalidate(hrefsForAction(url, match, response));
      return response;
    } finally {
      callerSignal?.removeEventListener("abort", abortFromCaller);
      if (actionController === nextActionController) {
        actionController = undefined;
      }
    }
  };

  const navigate = async (href: string, navigateOptions: NavigateOptions = {}): Promise<void> => {
    if (disposed) return;
    controller?.abort();
    actionController?.abort();
    const nextController = new AbortController();
    controller = nextController;
    const generation = ++navigationGeneration;
    const url = toUrl(href, location.href || baseUrl);
    if (!navigateOptions.restoreScroll) {
      saveCurrentScrollPosition();
    }
    if (location.pathname === url.pathname && location.search === url.search && location.hash !== url.hash) {
      if (!isCurrentNavigation(nextController.signal, generation)) return;
      writeHistory(url, navigateOptions);
      restoreOrScroll(url, navigateOptions);
      return;
    }
    const match = matchClientRoute(routes, url.pathname);
    const task = (async () => {
      if (!match) {
        if (!isCurrentNavigation(nextController.signal, generation)) return;
        writeHistory(url, navigateOptions);
        renderNotFound(url);
        restoreOrScroll(url, navigateOptions);
        focusRouteContent(options.root, focusSelector);
        return;
      }
      let loaded: LoadedClientBranch;
      try {
        loaded = await loadData(url, match, nextController.signal);
        if (!isCurrentNavigation(nextController.signal, generation)) {
          return;
        }
        const rendered = await match.route.render({
          url,
          params: match.params,
          data: loaded.leafData,
          signal: nextController.signal,
        });
        if (!isCurrentNavigation(nextController.signal, generation)) {
          disposeRenderResult(rendered);
          return;
        }
        writeHistory(url, navigateOptions);
        await commitNavigation(url, match, loaded, rendered, navigateOptions, nextController.signal, generation);
      } catch (error) {
        if (isCurrentNavigation(nextController.signal, generation)) {
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
    if (url.origin !== location.origin || !matchClientRoute(routes, url.pathname)) {
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
    void navigate(location.pathname + location.search + location.hash, { replace: true, restoreScroll: true });
  };

  return {
    start: async () => {
      if (disposed || started) return;
      started = true;
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
      if (disposed) return;
      if (!href) {
        cache.clear();
        prefetchEntries.forEach((entry) => entry.controller.abort());
        prefetchEntries.clear();
        return;
      }
      const key = cacheKey(toUrl(href, location.href || baseUrl));
      cache.delete(key);
      prefetchEntries.get(key)?.controller.abort();
      prefetchEntries.delete(key);
    },
    settled: () => currentNavigation,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      navigationGeneration++;
      actionVersion++;
      let firstError: unknown;
      let failed = false;
      const attempt = (cleanup: () => void): void => {
        try {
          cleanup();
        } catch (error) {
          if (!failed) firstError = error;
          failed = true;
        }
      };
      attempt(() => controller?.abort());
      attempt(() => actionController?.abort());
      attempt(() => prefetchEntries.forEach((entry) => entry.controller.abort()));
      prefetchEntries.clear();
      cache.clear();
      attempt(disposeLayoutStates);
      attempt(disposeCommittedView);
      scrollPositions.clear();
      currentNavigation = Promise.resolve();
      try {
        options.root.removeEventListener("click", onClick);
        options.root.removeEventListener("pointerdown", onPointerDown);
        options.root.removeEventListener("mousedown", onPointerDown);
        options.root.removeEventListener("pointerover", onPointerOver);
        removeEventListener("popstate", onPopState);
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
      }
      if (failed) throw firstError;
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
