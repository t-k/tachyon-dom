import {
  renderRoute,
  renderRouteStream,
  type MatchedRoute,
  type RouteDefinition,
  type RouteContext,
  type RouteCachePolicy,
  type RouteEnvironment,
  type RouteHeadDescriptor,
  type RouteResource,
  type RouteHooks,
  type RouteRenderOptions,
} from "../router.js";

export type WorkersAssetsBinding = {
  fetch: (request: Request) => Response | Promise<Response>;
};

export type AdapterFetchHandler = (request: Request) => Response | Promise<Response>;

export type AdapterObservabilityMetadata = Record<string, string | number | boolean | undefined>;

export type AdapterRequestStartEvent = {
  type: "request_start";
  request: Request;
  method: string;
  path: string;
  adapter: string;
  runtime?: string;
  metadata?: AdapterObservabilityMetadata;
  startedAt: number;
};

export type AdapterRouteMatchedEvent = {
  type: "route_matched";
  request: Request;
  method: string;
  path: string;
  adapter: string;
  runtime?: string;
  metadata?: AdapterObservabilityMetadata;
  routeId: string;
  routePattern: string;
  matchedRoute: MatchedRoute;
  startedAt: number;
};

export type AdapterResponseEvent = {
  type: "response";
  request: Request;
  method: string;
  path: string;
  adapter: string;
  runtime?: string;
  metadata?: AdapterObservabilityMetadata;
  status: number;
  routeId?: string;
  routePattern?: string;
  failedBeforeRouteDispatch: boolean;
  durationMs: number;
  startedAt: number;
};

export type AdapterErrorEvent = {
  type: "error";
  request: Request;
  method: string;
  path: string;
  adapter: string;
  runtime?: string;
  metadata?: AdapterObservabilityMetadata;
  error: unknown;
  routeId?: string;
  routePattern?: string;
  failedBeforeRouteDispatch: boolean;
  durationMs: number;
  startedAt: number;
};

export type AdapterObservabilityHooks = {
  adapter?: string;
  runtime?: string;
  metadata?: AdapterObservabilityMetadata;
  onRequestStart?: (event: AdapterRequestStartEvent) => void | Promise<void>;
  onRouteMatched?: (event: AdapterRouteMatchedEvent) => void | Promise<void>;
  onResponse?: (event: AdapterResponseEvent) => void | Promise<void>;
  onError?: (event: AdapterErrorEvent) => void | Promise<void>;
};

export type WorkersAssetOptions<Env> = {
  binding?: WorkersAssetsBinding;
  bindingName?: keyof Env & string;
  basePath?: string;
  headers?: HeadersInit;
  fallthroughStatuses?: readonly number[];
};

export type WorkersRouteContext<Env, Data = unknown, ActionResult = unknown> = Omit<
  RouteContext<Data, ActionResult>,
  "bindings" | "route"
> & {
  bindings: Env;
  route: WorkersRouteDefinition<Env, Data, ActionResult>;
};

export type WorkersRouteDefinition<Env, Data = unknown, ActionResult = unknown> = Omit<
  RouteDefinition<Data, ActionResult>,
  "action" | "cache" | "children" | "head" | "headers" | "loader" | "render" | "resources"
> & {
  loader?: (
    context: Omit<WorkersRouteContext<Env, Data, ActionResult>, "data" | "outlet">,
  ) => Data | Promise<Data>;
  action?: (
    context: Omit<WorkersRouteContext<Env, Data, ActionResult>, "data" | "outlet">,
  ) => ActionResult | Promise<ActionResult>;
  head?: (
    context: WorkersRouteContext<Env, Data, ActionResult>,
  ) => RouteHeadDescriptor | Promise<RouteHeadDescriptor>;
  resources?:
    | readonly RouteResource[]
    | ((context: WorkersRouteContext<Env, Data, ActionResult>) => readonly RouteResource[]);
  headers?: HeadersInit | ((context: WorkersRouteContext<Env, Data, ActionResult>) => HeadersInit | Promise<HeadersInit>);
  cache?:
    | RouteCachePolicy
    | ((context: WorkersRouteContext<Env, Data, ActionResult>) => RouteCachePolicy | Promise<RouteCachePolicy>);
  render: (context: WorkersRouteContext<Env, Data, ActionResult>) => string | Promise<string>;
  children?: WorkersRouteDefinition<Env>[];
};

export type WorkersRouteMiddleware<Env> = (context: {
  request: Request;
  url: URL;
  env: RouteEnvironment;
  bindings: Env;
}) => ReturnType<NonNullable<RouteRenderOptions["middleware"]>[number]>;

export type WorkersHandlerOptions<Env = Record<string, unknown>> = Omit<
  RouteRenderOptions,
  "bindings" | "middleware"
> & {
  routes: readonly WorkersRouteDefinition<Env, any, any>[];
  middleware?: readonly WorkersRouteMiddleware<Env>[];
  securityHeaders?: Headers;
  streaming?: boolean;
  staticRoutes?: readonly StaticRouteDefinition[];
  assets?: WorkersAssetOptions<Env>;
  observability?: AdapterObservabilityHooks | undefined;
};

export type RouteAdapterHandlerOptions = RouteRenderOptions & {
  routes: readonly RouteDefinition[];
  securityHeaders?: Headers;
  streaming?: boolean;
  staticRoutes?: readonly StaticRouteDefinition[];
  assets?: WorkersAssetOptions<Record<string, unknown>>;
  observability?: AdapterObservabilityHooks | undefined;
};

export type WorkersFetchHandlerOptions<Env = Record<string, unknown>> = {
  fetch: AdapterFetchHandler;
  securityHeaders?: Headers;
  staticRoutes?: readonly StaticRouteDefinition[];
  assets?: WorkersAssetOptions<Env>;
  observability?: AdapterObservabilityHooks | undefined;
};

export type StaticRouteDefinition = {
  path: string;
  body: string;
  status?: number;
  headers?: HeadersInit;
  methods?: readonly string[];
};

const mergeHeaders = (base: Headers, extra?: Headers): Headers => {
  const headers = new Headers(base);
  extra?.forEach((value, key) => headers.set(key, value));
  return headers;
};

const withExtraHeaders = (response: Response, ...extras: Array<Headers | undefined>): Response => {
  let headers = new Headers(response.headers);
  for (const extra of extras) {
    headers = mergeHeaders(headers, extra);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

export const defineStaticRoute = (route: StaticRouteDefinition): StaticRouteDefinition => route;

const findStaticRoute = (
  routes: readonly StaticRouteDefinition[] | undefined,
  method: string,
  url: URL,
): StaticRouteDefinition | undefined =>
  routes?.find((route) => {
    const methods = route.methods ?? ["GET", "HEAD"];
    const path = route.path.includes("?") ? `${url.pathname}${url.search}` : url.search ? "" : url.pathname;
    return methods.includes(method) && route.path === path;
  });

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

const headersForStaticRoute = (route: StaticRouteDefinition, extra?: Headers): Headers => {
  const headers = mergeHeaders(new Headers(route.headers), extra);
  if (!headers.has("content-type")) {
    headers.set("content-type", "text/html; charset=utf-8");
  }
  if (!headers.has("content-length")) {
    headers.set("content-length", String(byteLength(route.body)));
  }
  return headers;
};

const responseForStaticRoute = (route: StaticRouteDefinition, request: Request, securityHeaders?: Headers): Response =>
  new Response(request.method === "HEAD" ? null : route.body, {
    status: route.status ?? 200,
    headers: headersForStaticRoute(route, securityHeaders),
  });

const now = (): number => globalThis.performance?.now() ?? Date.now();

const routePatternFor = (match: MatchedRoute): string => match.branch.at(-1)?.path ?? match.pathname;

const routeIdFor = (match: MatchedRoute): string => match.route.id ?? routePatternFor(match);

type AdapterRequestState = {
  request: Request;
  method: string;
  path: string;
  adapter: string;
  runtime?: string;
  metadata?: AdapterObservabilityMetadata;
  startedAt: number;
  routeId?: string;
  routePattern?: string;
};

const createRequestState = (
  request: Request,
  observability: AdapterObservabilityHooks | undefined,
): AdapterRequestState => {
  const url = new URL(request.url);
  return {
    request,
    method: request.method,
    path: url.pathname,
    adapter: observability?.adapter ?? "workers",
    ...(observability?.runtime ? { runtime: observability.runtime } : {}),
    ...(observability?.metadata ? { metadata: observability.metadata } : {}),
    startedAt: now(),
  };
};

const emitRequestStart = async (
  observability: AdapterObservabilityHooks | undefined,
  state: AdapterRequestState,
): Promise<void> => {
  await observability?.onRequestStart?.({ type: "request_start", ...state });
};

const emitRouteMatched = async (
  observability: AdapterObservabilityHooks | undefined,
  state: AdapterRequestState,
  match: MatchedRoute,
): Promise<void> => {
  const routePattern = routePatternFor(match);
  state.routeId = routeIdFor(match);
  state.routePattern = routePattern;
  await observability?.onRouteMatched?.({
    type: "route_matched",
    ...state,
    routeId: state.routeId,
    routePattern,
    matchedRoute: match,
  });
};

const emitResponse = async (
  observability: AdapterObservabilityHooks | undefined,
  state: AdapterRequestState,
  response: Response,
  failedBeforeRouteDispatch: boolean,
): Promise<void> => {
  await observability?.onResponse?.({
    type: "response",
    ...state,
    status: response.status,
    failedBeforeRouteDispatch,
    durationMs: now() - state.startedAt,
  });
};

const emitError = async (
  observability: AdapterObservabilityHooks | undefined,
  state: AdapterRequestState,
  error: unknown,
  failedBeforeRouteDispatch: boolean,
): Promise<void> => {
  await observability?.onError?.({
    type: "error",
    ...state,
    error,
    failedBeforeRouteDispatch,
    durationMs: now() - state.startedAt,
  });
};

const routeObservabilityHooks = (
  hooks: RouteHooks | undefined,
  observability: AdapterObservabilityHooks | undefined,
  state: AdapterRequestState,
): RouteHooks | undefined => {
  if (!observability) {
    return hooks;
  }
  return {
    ...hooks,
    onMatch: async (context) => {
      await hooks?.onMatch?.(context);
      await emitRouteMatched(observability, state, context.match);
    },
    onError: async (context) => {
      await hooks?.onError?.(context);
      await emitError(observability, state, context.error, false);
    },
  };
};

const normalizeBasePath = (basePath: string | undefined): string | undefined => {
  if (!basePath || basePath === "/") {
    return basePath;
  }
  return basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
};

const matchesBasePath = (pathname: string, basePath: string | undefined): boolean => {
  const normalized = normalizeBasePath(basePath);
  return !normalized || normalized === "/" || pathname === normalized || pathname.startsWith(`${normalized}/`);
};

const isWorkersAssetsBinding = (value: unknown): value is WorkersAssetsBinding =>
  Boolean(value && typeof value === "object" && typeof (value as { fetch?: unknown }).fetch === "function");

const resolveAssetsBinding = <Env>(
  options: WorkersAssetOptions<Env> | undefined,
  env: Env | undefined,
): WorkersAssetsBinding | undefined => {
  if (!options) {
    return undefined;
  }
  if (options.binding) {
    return options.binding;
  }
  const bindingName = options.bindingName ?? ("ASSETS" as keyof Env & string);
  const candidate = env && typeof env === "object" ? (env as Record<string, unknown>)[bindingName] : undefined;
  return isWorkersAssetsBinding(candidate) ? candidate : undefined;
};

const responseForAsset = async <Env>(
  options: Pick<WorkersHandlerOptions<Env>, "assets" | "securityHeaders">,
  request: Request,
  env: Env | undefined,
): Promise<Response | undefined> => {
  const assetOptions = options.assets;
  if (!assetOptions) {
    return undefined;
  }
  const url = new URL(request.url);
  if (!matchesBasePath(url.pathname, assetOptions.basePath)) {
    return undefined;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return withExtraHeaders(
      new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } }),
      options.securityHeaders,
    );
  }
  const binding = resolveAssetsBinding(assetOptions, env);
  if (!binding) {
    return undefined;
  }
  const response = await binding.fetch(request);
  const fallthroughStatuses = assetOptions.fallthroughStatuses ?? (assetOptions.basePath ? [] : [404]);
  if (fallthroughStatuses.includes(response.status)) {
    return undefined;
  }
  return withExtraHeaders(response, new Headers(assetOptions.headers), options.securityHeaders);
};

export const workersStreamFromChunks = (chunks: AsyncIterable<string>): ReadableStream<Uint8Array> => {
  const iterator = chunks[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(next.value));
    },
    async cancel() {
      await iterator.return?.();
    },
  });
};

const responseFor = async <Env>(
  options: WorkersHandlerOptions<Env>,
  request: Request,
  env: Env | undefined,
): Promise<Response> => {
  const state = createRequestState(request, options.observability);
  await emitRequestStart(options.observability, state);
  const staticRoute = findStaticRoute(options.staticRoutes, request.method, new URL(request.url));
  if (staticRoute) {
    state.routeId = staticRoute.path;
    state.routePattern = staticRoute.path;
    const response = responseForStaticRoute(staticRoute, request, options.securityHeaders);
    await emitResponse(options.observability, state, response, false);
    return response;
  }
  try {
    const asset = await responseForAsset(options, request, env);
    if (asset) {
      const response = asset;
      await emitResponse(options.observability, state, response, false);
      return response;
    }
    const hooks = routeObservabilityHooks(options.hooks, options.observability, state);
    const renderOptions: RouteRenderOptions = {
      ...options,
      bindings: env,
      middleware: options.middleware,
      ...(hooks ? { hooks } : {}),
    } as RouteRenderOptions;
    if (options.streaming) {
      const result = await renderRouteStream(options.routes as readonly RouteDefinition[], request, renderOptions);
      if (!result.ok) {
        const response = new Response(result.error.message, { status: result.error.status });
        await emitResponse(options.observability, state, response, true);
        return response;
      }
      const stream = workersStreamFromChunks(result.value.chunks);
      const response = new Response(stream, {
        status: result.value.status,
        headers: mergeHeaders(result.value.headers, options.securityHeaders),
      });
      await emitResponse(options.observability, state, response, state.routeId === undefined);
      return response;
    }
    const result = await renderRoute(options.routes as readonly RouteDefinition[], request, renderOptions);
    if (!result.ok) {
      const response = new Response(result.error.message, { status: result.error.status });
      await emitResponse(options.observability, state, response, true);
      return response;
    }
    const response = new Response(result.value.responseBody ?? result.value.html, {
      status: result.value.status,
      headers: mergeHeaders(result.value.headers, options.securityHeaders),
    });
    await emitResponse(options.observability, state, response, state.routeId === undefined);
    return response;
  } catch (error) {
    await emitError(options.observability, state, error, state.routeId === undefined);
    throw error;
  }
};

const responseForFetch = async <Env>(
  options: WorkersFetchHandlerOptions<Env>,
  request: Request,
  env: Env | undefined,
): Promise<Response> => {
  const state = createRequestState(request, options.observability);
  await emitRequestStart(options.observability, state);
  const staticRoute = findStaticRoute(options.staticRoutes, request.method, new URL(request.url));
  if (staticRoute) {
    state.routeId = staticRoute.path;
    state.routePattern = staticRoute.path;
    const response = responseForStaticRoute(staticRoute, request, options.securityHeaders);
    await emitResponse(options.observability, state, response, false);
    return response;
  }
  try {
    const asset = await responseForAsset(options, request, env);
    if (asset) {
      await emitResponse(options.observability, state, asset, false);
      return asset;
    }
    const response = withExtraHeaders(await options.fetch(request), options.securityHeaders);
    await emitResponse(options.observability, state, response, false);
    return response;
  } catch (error) {
    await emitError(options.observability, state, error, state.routeId === undefined);
    throw error;
  }
};

export function createWorkersHandler<Env = Record<string, unknown>>(
  options: WorkersHandlerOptions<Env>,
): { fetch: (request: Request, env?: Env) => Promise<Response> };
export function createWorkersHandler(
  options: RouteAdapterHandlerOptions,
): { fetch: (request: Request, env?: unknown) => Promise<Response> };
export function createWorkersHandler(
  options: WorkersHandlerOptions<unknown> | RouteAdapterHandlerOptions,
): { fetch: (request: Request, env?: unknown) => Promise<Response> } {
  return {
    fetch: (request, env) => responseFor(options as WorkersHandlerOptions<unknown>, request, env),
  };
}

export const createWorkersFetchHandler = <Env = Record<string, unknown>>(
  options: WorkersFetchHandlerOptions<Env>,
): { fetch: (request: Request, env?: Env) => Promise<Response> } => ({
  fetch: (request, env) => responseForFetch(options, request, env),
});
