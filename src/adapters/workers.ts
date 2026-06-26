import { renderRoute, renderRouteStream, type RouteDefinition, type RouteRenderOptions } from "../router.js";

export type WorkersAssetsBinding = {
  fetch: (request: Request) => Response | Promise<Response>;
};

export type WorkersAssetOptions<Env> = {
  binding?: WorkersAssetsBinding;
  bindingName?: keyof Env & string;
  basePath?: string;
  headers?: HeadersInit;
  fallthroughStatuses?: readonly number[];
};

export type WorkersHandlerOptions<Env = Record<string, unknown>> = RouteRenderOptions & {
  routes: readonly RouteDefinition[];
  securityHeaders?: Headers;
  streaming?: boolean;
  staticRoutes?: readonly StaticRouteDefinition[];
  assets?: WorkersAssetOptions<Env>;
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
  const headers = extras.reduce((current, extra) => mergeHeaders(current, extra), new Headers(response.headers));
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
  options: WorkersHandlerOptions<Env>,
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
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
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

const responseFor = async <Env>(
  options: WorkersHandlerOptions<Env>,
  request: Request,
  env: Env | undefined,
): Promise<Response> => {
  const staticRoute = findStaticRoute(options.staticRoutes, request.method, new URL(request.url));
  if (staticRoute) {
    return responseForStaticRoute(staticRoute, request, options.securityHeaders);
  }
  const asset = await responseForAsset(options, request, env);
  if (asset) {
    return asset;
  }
  if (options.streaming) {
    const result = await renderRouteStream(options.routes, request, options);
    if (!result.ok) {
      return new Response(result.error.message, { status: result.error.status });
    }
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        for await (const chunk of result.value.chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: result.value.status,
      headers: mergeHeaders(result.value.headers, options.securityHeaders),
    });
  }
  const result = await renderRoute(options.routes, request, options);
  if (!result.ok) {
    return new Response(result.error.message, { status: result.error.status });
  }
  return new Response(result.value.responseBody ?? result.value.html, {
    status: result.value.status,
    headers: mergeHeaders(result.value.headers, options.securityHeaders),
  });
};

export const createWorkersHandler = <Env = Record<string, unknown>>(
  options: WorkersHandlerOptions<Env>,
): { fetch: (request: Request, env?: Env) => Promise<Response> } => ({
  fetch: (request, env) => responseFor(options, request, env),
});
