import { escapeHtml } from "./html-escape.js";
import { err, ok, type Result } from "./result.js";
import { serializeHydrationState } from "./runtime/hydrate.js";
import { applyHtmlWhitespace, type HtmlWhitespacePolicyInput } from "./html-whitespace.js";

export type RouteParams = Record<string, string>;

export type ParamsForPath<Path extends string> = Path extends `${string}:${infer Param}/${infer Rest}`
  ? { [Key in Param | keyof ParamsForPath<`/${Rest}`>]: string }
  : Path extends `${string}:${infer Param}`
    ? { [Key in Param]: string }
    : Path extends `${string}*${infer Param}/${infer Rest}`
      ? { [Key in Param | keyof ParamsForPath<`/${Rest}`>]: string }
      : Path extends `${string}*${infer Param}`
        ? { [Key in Param]: string }
        : {};

export type RouteResource = {
  rel: "stylesheet" | "modulepreload" | "preload" | "prefetch";
  href: string;
  as?: string;
  type?: string;
  crossorigin?: string;
  fetchpriority?: "high" | "low" | "auto";
};

export type RouteHeadDescriptor = {
  title?: string;
  metas?: Array<Record<string, string>>;
  links?: Array<Record<string, string>>;
  scripts?: Array<Record<string, string>>;
};

export type TrustedHtml = {
  __tachyonTrustedHtml: true;
  value: string;
};

export type RouteContext<Data = unknown, ActionResult = unknown> = {
  request: Request;
  url: URL;
  params: RouteParams;
  route: RouteDefinition;
  env: RouteEnvironment;
  data: Data;
  loaderData: Record<string, unknown>;
  actionResult: ActionResult;
  outlet: string;
};

export type RouteEnvironment = Record<string, string | undefined>;

export type RouteCachePolicy = {
  mode?: "public" | "private" | "no-store";
  maxAge?: number;
  sharedMaxAge?: number;
  staleWhileRevalidate?: number;
  staleIfError?: number;
  immutable?: boolean;
  tags?: readonly string[];
};

export type RouteDefinition<Data = unknown, ActionResult = unknown> = {
  id?: string;
  path: string;
  loader?: (context: Omit<RouteContext<Data, ActionResult>, "data" | "outlet">) => Data | Promise<Data>;
  action?: (context: Omit<RouteContext<Data, ActionResult>, "data" | "outlet">) => ActionResult | Promise<ActionResult>;
  head?: (
    descriptor: RouteContext<Data, ActionResult>,
  ) => RouteHeadDescriptor | Promise<RouteHeadDescriptor> | RouteHeadDescriptor;
  resources?: readonly RouteResource[] | ((context: RouteContext<Data, ActionResult>) => readonly RouteResource[]);
  headers?: HeadersInit | ((context: RouteContext<Data, ActionResult>) => HeadersInit | Promise<HeadersInit>);
  cache?:
    | RouteCachePolicy
    | ((context: RouteContext<Data, ActionResult>) => RouteCachePolicy | Promise<RouteCachePolicy>);
  fallback?: string;
  error?: (context: { request: Request; url: URL; error: unknown }) => string | Promise<string>;
  notFound?: (context: { request: Request; url: URL }) => string | Promise<string>;
  render: (context: RouteContext<Data, ActionResult>) => string | Promise<string>;
  children?: RouteDefinition[];
};

export type RouteManifestEntry = {
  id: string;
  path: string;
  parentId?: string;
};

export type FileRouteManifestEntry = {
  id: string;
  path: string;
  file: string;
  kind: "template" | "module" | "layout";
};

export type MatchedRoute = {
  route: RouteDefinition;
  branch: Array<{ route: RouteDefinition; path: string; params: RouteParams }>;
  params: RouteParams;
  pathname: string;
};

export type RouteRenderResult = {
  status: number;
  html: string;
  headHtml: string;
  resourceHints: string;
  stateScript: string;
  loaderData: Record<string, unknown>;
  actionResult: unknown;
  match: MatchedRoute;
  headers: Headers;
  responseBody?: string;
};

export type RouteRenderOptions = {
  notFound?: (context: { request: Request; url: URL }) => string | Promise<string>;
  error?: (context: { request: Request; url: URL; error: unknown }) => string | Promise<string>;
  allowedMethods?: readonly string[];
  maxActionBodyBytes?: number;
  cspNonce?: string;
  csrf?: {
    verify: (context: { request: Request; url: URL; env: RouteEnvironment }) => boolean | Promise<boolean>;
  };
  middleware?: readonly RouteMiddleware[];
  hooks?: RouteHooks;
  env?: RouteEnvironment;
  /** Applied only after buffered rendering. Streaming chunks are always preserved. */
  htmlWhitespace?: HtmlWhitespacePolicyInput;
};

export type RouteError = {
  message: string;
  status: number;
};

export type RouteModule<Data = unknown, ActionResult = unknown> = {
  path?: string;
  loader?: RouteDefinition<Data, ActionResult>["loader"];
  action?: RouteDefinition<Data, ActionResult>["action"];
  head?: RouteDefinition<Data, ActionResult>["head"];
  resources?: RouteDefinition<Data, ActionResult>["resources"];
  headers?: RouteDefinition<Data, ActionResult>["headers"];
  cache?: RouteDefinition<Data, ActionResult>["cache"];
  fallback?: string;
  template?: RouteDefinition<Data, ActionResult>["render"];
  render?: RouteDefinition<Data, ActionResult>["render"];
  ErrorBoundary?: (context: { request: Request; url: URL; error: unknown }) => string | Promise<string>;
  NotFound?: (context: { request: Request; url: URL }) => string | Promise<string>;
  children?: RouteDefinition[];
};

export type RouteResponse = {
  __tachyonRouteResponse: true;
  status: number;
  headers: Headers;
  body: string;
};

export type RouteMiddlewareResult = Request | Response | RouteResponse | void;

export type RouteMiddleware = (context: {
  request: Request;
  url: URL;
  env: RouteEnvironment;
}) => RouteMiddlewareResult | Promise<RouteMiddlewareResult>;

type RouteExecutionContext = RouteContext & { bindings?: unknown };

type RouteExecutionOptions = Omit<RouteRenderOptions, "csrf" | "middleware"> & {
  bindings?: unknown;
  csrf?: {
    verify: (context: {
      request: Request;
      url: URL;
      env: RouteEnvironment;
      bindings?: unknown;
    }) => boolean | Promise<boolean>;
  };
  middleware?: readonly ((context: {
    request: Request;
    url: URL;
    env: RouteEnvironment;
    bindings?: unknown;
  }) => RouteMiddlewareResult | Promise<RouteMiddlewareResult>)[];
};

export type RouteHooks = {
  onRequest?: (context: { request: Request; url: URL }) => void | Promise<void>;
  onMatch?: (context: { request: Request; url: URL; match: MatchedRoute }) => void | Promise<void>;
  onLoader?: (context: { request: Request; url: URL; route: RouteDefinition; data: unknown }) => void | Promise<void>;
  onAction?: (context: { request: Request; url: URL; route: RouteDefinition; result: unknown }) => void | Promise<void>;
  onRender?: (context: { request: Request; url: URL; html: string; match: MatchedRoute }) => void | Promise<void>;
  onError?: (context: { request: Request; url: URL; error: unknown; match?: MatchedRoute }) => void | Promise<void>;
};

export type DeferredData<T extends Record<string, unknown> = Record<string, unknown>> = {
  __tachyonDeferredData: true;
  immediate: Partial<T>;
  pending: Partial<{ [Key in keyof T]: Promise<Awaited<T[Key]>> }>;
};

export type RouteBuildManifest = {
  buildId: string;
  routes: RouteManifestEntry[];
  assets: Record<string, string[]>;
  types: string;
};

export type RoutePreloadEntry = {
  href: string;
  rel: "modulepreload" | "preload" | "prefetch";
  as?: string;
};

export type UserGuardOptions<User> = {
  redirectTo?: string;
  forbidden?: (context: { request: Request; url: URL }) => RouteResponse | Response;
  getRedirect?: (context: { request: Request; url: URL }) => string;
  onUser?: (context: { request: Request; url: URL; user: User }) => void | Promise<void>;
};

const routeError = (message: string, status: number): RouteError => ({ message, status });

const trimSlashes = (value: string): string => value.replace(/^\/+|\/+$/g, "");

const joinPaths = (parent: string, child: string): string => {
  if (child === "*") {
    return "*";
  }
  if (child.startsWith("/")) {
    return child === "/" ? "/" : `/${trimSlashes(child)}`;
  }
  const joined = [trimSlashes(parent), trimSlashes(child)].filter(Boolean).join("/");
  return joined ? `/${joined}` : "/";
};

const routeId = (route: RouteDefinition, path: string): string => route.id ?? path;

const isRouteResponse = (value: unknown): value is RouteResponse =>
  Boolean(
    value &&
    typeof value === "object" &&
    (value as { __tachyonRouteResponse?: unknown }).__tachyonRouteResponse === true,
  );

const isWebResponse = (value: unknown): value is Response => value instanceof Response;

export const isDeferredData = (value: unknown): value is DeferredData =>
  Boolean(
    value && typeof value === "object" && (value as { __tachyonDeferredData?: unknown }).__tachyonDeferredData === true,
  );

const routeResponse = (body: string, init: ResponseInit = {}): RouteResponse => ({
  __tachyonRouteResponse: true,
  status: init.status ?? 200,
  headers: new Headers(init.headers),
  body,
});

export type RedirectOptions = ResponseInit & {
  allowExternal?: boolean;
  allowedOrigins?: readonly string[];
};

const isSafePathRedirect = (location: string): boolean => {
  const controlCharacterPattern = /[\u0000-\u001F\u007F]/;
  if (!location.startsWith("/") || location.startsWith("//") || controlCharacterPattern.test(location)) {
    return false;
  }
  try {
    const decoded = decodeURIComponent(location);
    return !decoded.startsWith("//") && !decoded.includes("\\") && !controlCharacterPattern.test(decoded);
  } catch {
    return false;
  }
};

const isApprovedExternalRedirect = (location: string, allowedOrigins: readonly string[] | undefined): boolean => {
  if (!allowedOrigins || allowedOrigins.length === 0) {
    return false;
  }
  try {
    const url = new URL(location);
    return (url.protocol === "https:" || url.protocol === "http:") && allowedOrigins.includes(url.origin);
  } catch {
    return false;
  }
};

export const redirect = (location: string, init: RedirectOptions = {}): RouteResponse => {
  if (
    !isSafePathRedirect(location) &&
    !(init.allowExternal && isApprovedExternalRedirect(location, init.allowedOrigins))
  ) {
    throw new Error(`Unsafe redirect target: ${location}`);
  }
  const headers = new Headers(init.headers);
  headers.set("location", location);
  return routeResponse("", { ...init, status: init.status ?? 302, headers });
};

export const json = (data: unknown, init: ResponseInit = {}): RouteResponse => {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json; charset=utf-8");
  }
  return routeResponse(JSON.stringify(data), { ...init, headers });
};

const trustedHtmlValues = new WeakSet<TrustedHtml>();

export const unsafeHtml = (value: string): TrustedHtml => {
  const trusted = { __tachyonTrustedHtml: true as const, value };
  trustedHtmlValues.add(trusted);
  return trusted;
};

export const escapeToHtml = (value: unknown): TrustedHtml => unsafeHtml(escapeHtml(value));

const trustedHtmlValue = (value: TrustedHtml | string): string => {
  if (typeof value === "string") {
    return escapeHtml(value);
  }
  if (!trustedHtmlValues.has(value)) {
    throw new Error("TrustedHtml values must be created by tachyon-dom helpers.");
  }
  return value.value;
};

export const html = (body: TrustedHtml, init: ResponseInit = {}): RouteResponse => {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "text/html; charset=utf-8");
  }
  return routeResponse(trustedHtmlValue(body), { ...init, headers });
};

const cacheSeconds = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;

export const cacheControl = (policy: RouteCachePolicy): Headers => {
  const headers = new Headers();
  const directives: string[] = [];
  if (policy.mode === "no-store") {
    directives.push("no-store");
  } else {
    directives.push(policy.mode ?? "private");
    const maxAge = cacheSeconds(policy.maxAge);
    const sharedMaxAge = cacheSeconds(policy.sharedMaxAge);
    const staleWhileRevalidate = cacheSeconds(policy.staleWhileRevalidate);
    const staleIfError = cacheSeconds(policy.staleIfError);
    if (maxAge !== undefined) {
      directives.push(`max-age=${maxAge}`);
    }
    if (sharedMaxAge !== undefined) {
      directives.push(`s-maxage=${sharedMaxAge}`);
    }
    if (staleWhileRevalidate !== undefined) {
      directives.push(`stale-while-revalidate=${staleWhileRevalidate}`);
    }
    if (staleIfError !== undefined) {
      directives.push(`stale-if-error=${staleIfError}`);
    }
    if (policy.immutable) {
      directives.push("immutable");
    }
  }
  headers.set("cache-control", directives.join(", "));
  if (policy.tags && policy.tags.length > 0) {
    headers.set("cache-tag", policy.tags.join(","));
  }
  return headers;
};

export const withCacheHeaders = (response: Response, policy: RouteCachePolicy): Response => {
  const headers = new Headers(response.headers);
  cacheControl(policy).forEach((value, key) => headers.set(key, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};

export const defer = <T extends Record<string, unknown>>(values: T): DeferredData<T> => {
  const immediate: Partial<T> = {};
  const pending: Partial<{ [Key in keyof T]: Promise<Awaited<T[Key]>> }> = {};
  for (const [key, value] of Object.entries(values) as Array<[keyof T, T[keyof T]]>) {
    if (value instanceof Promise) {
      pending[key] = value as Promise<Awaited<T[keyof T]>>;
    } else {
      immediate[key] = value;
    }
  }
  return { __tachyonDeferredData: true, immediate, pending };
};

export const resolveDeferredData = async <T extends Record<string, unknown>>(data: DeferredData<T>): Promise<T> => {
  const resolved: Record<string, unknown> = { ...data.immediate };
  for (const [key, value] of Object.entries(data.pending)) {
    resolved[key] = await value;
  }
  return resolved as T;
};

const escapeScriptJson = (value: string): string => value.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");

const attributeEscapeMap: Record<string, string> = {
  "&": "&amp;",
  '"': "&quot;",
  "<": "&lt;",
};

const escapeAttribute = (value: string): string => value.replace(/[&"<]/g, (char) => attributeEscapeMap[char] ?? char);

export const renderDeferredDataScript = async <T extends Record<string, unknown>>(
  id: string,
  data: DeferredData<T>,
  options: { nonce?: string } = {},
): Promise<string> => {
  const resolved = await resolveDeferredData(data);
  const nonce = options.nonce ? ` nonce="${escapeAttribute(options.nonce)}"` : "";
  return `<script type="application/json" data-tachyon-deferred="${escapeAttribute(id)}"${nonce}>${escapeScriptJson(JSON.stringify(resolved) ?? "null")}</script>`;
};

const verifyCsrf = async (
  request: Request,
  url: URL,
  env: RouteEnvironment,
  bindings: unknown,
  options: NonNullable<RouteExecutionOptions["csrf"]>,
): Promise<boolean> => options.verify({ request, url, env, bindings });

const payloadTooLargeResult = (match: MatchedRoute): RouteRenderResult => ({
  status: 413,
  html: "<h1>Payload Too Large</h1>",
  headHtml: "",
  resourceHints: "",
  stateScript: "",
  loaderData: {},
  actionResult: undefined,
  headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
  match,
});

const readLimitedRequest = async (request: Request, maxBytes: number): Promise<Request | undefined> => {
  if (!request.body) {
    return request;
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    total += result.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(result.value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request.url, {
    body,
    headers: request.headers,
    method: request.method,
    redirect: request.redirect,
    signal: request.signal,
  });
};

const validateCspNonce = (nonce: string): string => {
  if (!/^[A-Za-z0-9+/_=-]+$/.test(nonce)) {
    throw new Error("Invalid CSP nonce.");
  }
  return nonce;
};

const hasControlCharacter = (value: string): boolean => {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
};

const validateFrameAncestors = (value: string): string => {
  if (hasControlCharacter(value) || value.includes(";")) {
    throw new Error("Invalid CSP frame-ancestors.");
  }
  const sources = value.split(/\s+/).filter(Boolean);
  if (
    sources.length === 0 ||
    sources.some((source) => source !== "'self'" && source !== "'none'" && !/^https?:\/\/[^\s;]+$/.test(source))
  ) {
    throw new Error("Invalid CSP frame-ancestors.");
  }
  if (sources.includes("'none'") && sources.length > 1) {
    throw new Error("Invalid CSP frame-ancestors.");
  }
  return sources.join(" ");
};

export const createSecurityHeaders = (
  options: {
    nonce?: string;
    csp?: boolean;
    hsts?: boolean;
    frameAncestors?: string;
  } = {},
): Headers => {
  const headers = new Headers();
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("x-frame-options", "SAMEORIGIN");
  headers.set("permissions-policy", "camera=(), geolocation=(), microphone=()");
  headers.set("cross-origin-opener-policy", "same-origin-allow-popups");
  if (options.hsts) {
    headers.set("strict-transport-security", "max-age=31536000; includeSubDomains; preload");
  }
  if (options.csp) {
    const nonce = options.nonce ? ` 'nonce-${validateCspNonce(options.nonce)}' 'strict-dynamic'` : "";
    const frameAncestors = validateFrameAncestors(options.frameAncestors ?? "'self'");
    headers.set(
      "content-security-policy",
      `script-src${nonce} 'report-sample'; object-src 'none'; base-uri 'none'; frame-ancestors ${frameAncestors}; form-action 'self'`,
    );
  }
  return headers;
};

export const applySecurityHeaders = (response: Response, headers: Headers): Response => {
  const nextHeaders = new Headers(response.headers);
  headers.forEach((value, key) => nextHeaders.set(key, value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: nextHeaders,
  });
};

export const requireUser =
  <User>(
    getUser: (context: { request: Request; url: URL }) => User | undefined | null | Promise<User | undefined | null>,
    options: UserGuardOptions<User> = {},
  ): RouteMiddleware =>
  async ({ request, url }) => {
    const user = await getUser({ request, url });
    if (user) {
      await options.onUser?.({ request, url, user });
      return;
    }
    if (options.forbidden) {
      return options.forbidden({ request, url });
    }
    return redirect(options.getRedirect?.({ request, url }) ?? options.redirectTo ?? "/login");
  };

export const defineRouteModule = <Data = unknown, ActionResult = unknown>(
  module: RouteModule<Data, ActionResult>,
): RouteModule<Data, ActionResult> => module;

export const routeFromModule = <Data = unknown, ActionResult = unknown>(
  id: string,
  module: RouteModule<Data, ActionResult>,
): RouteDefinition<Data, ActionResult> => ({
  id,
  path: module.path ?? "/",
  ...(module.loader ? { loader: module.loader } : {}),
  ...(module.action ? { action: module.action } : {}),
  ...(module.head ? { head: module.head } : {}),
  ...(module.resources ? { resources: module.resources } : {}),
  ...(module.headers ? { headers: module.headers } : {}),
  ...(module.cache ? { cache: module.cache } : {}),
  ...(module.fallback ? { fallback: module.fallback } : {}),
  ...(module.ErrorBoundary ? { error: module.ErrorBoundary } : {}),
  ...(module.NotFound ? { notFound: module.NotFound } : {}),
  render: module.render ?? module.template ?? (() => ""),
  ...(module.children ? { children: module.children } : {}),
});

const routeSegmentFromFile = (segment: string): string => {
  if (segment === "index") {
    return "";
  }
  if (segment.startsWith("[...") && segment.endsWith("]")) {
    return `*${segment.slice(4, -1)}`;
  }
  if (segment.startsWith("[") && segment.endsWith("]")) {
    return `:${segment.slice(1, -1)}`;
  }
  return segment;
};

const idSegmentFromFile = (segment: string): string => {
  if (segment === "index") {
    return "index";
  }
  return segment.replace(/^\[\.\.\.(.+)\]$/, "$1").replace(/^\[(.+)\]$/, "$1");
};

const routeKindForFile = (file: string): FileRouteManifestEntry["kind"] | undefined => {
  if (/\.(?:td|tachyon(?:\.html)?)$/.test(file)) {
    return "template";
  }
  if (/\/route\.[tj]s$/.test(file)) {
    return "module";
  }
  if (/\/layout\.[tj]s$/.test(file)) {
    return "layout";
  }
  return undefined;
};

const normalizeFilePath = (file: string): string => file.replaceAll("\\", "/");

const relativeRouteFile = (file: string, rootDir: string): string => {
  const normalizedFile = normalizeFilePath(file);
  const normalizedRoot = normalizeFilePath(rootDir).replace(/\/+$/, "");
  if (normalizedFile === normalizedRoot) {
    return "";
  }
  if (normalizedFile.startsWith(`${normalizedRoot}/`)) {
    return normalizedFile.slice(normalizedRoot.length + 1);
  }
  return normalizedFile.replace(/^\/+/, "");
};

export const createFileRouteManifest = (
  files: readonly string[],
  options: { rootDir: string },
): FileRouteManifestEntry[] =>
  files.flatMap((file) => {
    const kind = routeKindForFile(file);
    if (!kind) {
      return [];
    }
    const relative = relativeRouteFile(file, options.rootDir);
    const withoutExtension = relative.replace(/\.(?:td|tachyon(?:\.html)?)$/, "").replace(/\.[tj]s$/, "");
    const parts = withoutExtension.split("/");
    const fileName = parts.at(-1) ?? "";
    const routeParts =
      kind === "module" || kind === "layout" || (kind === "template" && fileName === "page")
        ? parts.slice(0, -1)
        : parts;
    const pathSegments = routeParts.map(routeSegmentFromFile).filter(Boolean);
    const routePath = pathSegments.length === 0 ? "/" : `/${pathSegments.join("/")}`;
    const idParts = [
      ...routeParts.map(idSegmentFromFile),
      kind === "module" || kind === "layout" ? fileName : "",
    ].filter(Boolean);
    return [{ id: idParts.join("-") || "index", path: routePath, file, kind }];
  });

export const createRouteManifest = (
  routes: readonly RouteDefinition[],
  parentPath = "",
  parentId?: string,
): RouteManifestEntry[] => {
  const entries: RouteManifestEntry[] = [];
  for (const route of routes) {
    const path = joinPaths(parentPath, route.path);
    const id = routeId(route, path);
    entries.push({ id, path, ...(parentId ? { parentId } : {}) });
    if (route.children) {
      entries.push(...createRouteManifest(route.children, path, id));
    }
  }
  return entries;
};

export const generateRouteTypes = (manifest: readonly Pick<RouteManifestEntry, "id" | "path">[]): string => {
  const lines = [
    `import type { ParamsForPath } from "tachyon-dom/router";`,
    ``,
    `export type RouteTypes = {`,
    ...manifest.map((route) => `  "${route.id}": { path: "${route.path}"; params: ParamsForPath<"${route.path}"> };`),
    `};`,
    ``,
  ];
  return lines.join("\n");
};

export const createRouteBuildManifest = (
  routes: readonly RouteDefinition[],
  options: {
    buildId: string;
    assets?: readonly { routeId: string; files: readonly string[] }[];
  },
): RouteBuildManifest => {
  const manifest = createRouteManifest(routes);
  const assets: Record<string, string[]> = {};
  for (const route of manifest) {
    const definition = flattenRoutes(routes).find((candidate) => routeId(candidate.route, candidate.path) === route.id);
    const staticResources =
      typeof definition?.route.resources === "function" ? [] : (definition?.route.resources ?? []);
    assets[route.id] = staticResources.map((resource) => resource.href);
  }
  for (const entry of options.assets ?? []) {
    assets[entry.routeId] = [...(assets[entry.routeId] ?? []), ...entry.files];
  }
  return {
    buildId: options.buildId,
    routes: manifest,
    assets,
    types: generateRouteTypes(manifest),
  };
};

const routeById = (manifest: readonly Pick<RouteManifestEntry, "id" | "path">[], id: string) =>
  manifest.find((route) => route.id === id);

export const hrefForRoute = (
  manifest: readonly Pick<RouteManifestEntry, "id" | "path">[],
  id: string,
  params: RouteParams = {},
): string => {
  const route = routeById(manifest, id);
  if (!route) {
    throw new Error(`Unknown route id: ${id}`);
  }
  return route.path
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        const value = params[segment.slice(1)];
        if (value === undefined) {
          throw new Error(`Missing route param: ${segment.slice(1)}`);
        }
        return encodeURIComponent(value);
      }
      if (segment.startsWith("*")) {
        const value = params[segment.slice(1)];
        if (value === undefined) {
          throw new Error(`Missing route param: ${segment.slice(1)}`);
        }
        return value.split("/").map(encodeURIComponent).join("/");
      }
      return segment;
    })
    .join("/");
};

export const createHrefBuilder =
  <Manifest extends readonly Pick<RouteManifestEntry, "id" | "path">[]>(manifest: Manifest) =>
  <Id extends Manifest[number]["id"]>(id: Id, params: RouteParams = {}): string =>
    hrefForRoute(manifest, String(id), params);

export const createRoutePreloadPlan = (manifest: RouteBuildManifest, routeId: string): RoutePreloadEntry[] =>
  (manifest.assets[routeId] ?? []).map((href) => {
    if (href.endsWith(".js") || href.endsWith(".mjs")) {
      return { href, rel: "modulepreload" };
    }
    if (href.endsWith(".css")) {
      return { href, rel: "preload", as: "style" };
    }
    return { href, rel: "prefetch" };
  });

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

type FlatRoute = {
  route: RouteDefinition;
  path: string;
  branch: Array<{ route: RouteDefinition; path: string }>;
  order: number;
};

type CompiledRoute = FlatRoute & {
  regex: RegExp;
  names: string[];
  wildcard: boolean;
  specificity: number[];
};

const flattenRoutes = (
  routes: readonly RouteDefinition[],
  parentPath = "",
  branch: Array<{ route: RouteDefinition; path: string }> = [],
  order = { value: 0 },
): FlatRoute[] => {
  const flat: FlatRoute[] = [];
  for (const route of routes) {
    const path = joinPaths(parentPath, route.path);
    const nextBranch = [...branch, { route, path }];
    flat.push({ route, path, branch: nextBranch, order: order.value++ });
    if (route.children) {
      flat.push(...flattenRoutes(route.children, path, nextBranch, order));
    }
  }
  return flat;
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

const compareCompiledRoutes = (left: CompiledRoute, right: CompiledRoute): number => {
  for (let index = 0; index < left.specificity.length; index += 1) {
    const difference = (right.specificity[index] ?? 0) - (left.specificity[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.order - right.order;
};

const compiledRouteCache = new WeakMap<readonly RouteDefinition[], readonly CompiledRoute[]>();

const compiledRoutesFor = (routes: readonly RouteDefinition[]): readonly CompiledRoute[] => {
  const cached = compiledRouteCache.get(routes);
  if (cached) {
    return cached;
  }
  const compiled = flattenRoutes(routes)
    .map((candidate): CompiledRoute => {
      const compiledPath = compileRoutePath(candidate.path);
      return {
        ...candidate,
        names: compiledPath.names,
        regex: compiledPath.regex,
        specificity: routeSpecificity(candidate.path),
        wildcard: compiledPath.wildcard,
      };
    })
    .sort(compareCompiledRoutes);
  compiledRouteCache.set(routes, compiled);
  return compiled;
};

export const matchRoute = (
  routes: readonly RouteDefinition[],
  input: string | URL,
): Result<MatchedRoute, RouteError> => {
  const url = typeof input === "string" ? new URL(input, "http://tachyon.local") : input;
  const pathname = url.pathname;
  let fallback: MatchedRoute | undefined;
  for (const candidate of compiledRoutesFor(routes)) {
    const match = candidate.regex.exec(pathname);
    if (!match) {
      continue;
    }
    const params: RouteParams = {};
    for (const [index, name] of candidate.names.entries()) {
      try {
        params[name] = decodeURIComponent(match[index + 1] ?? "");
      } catch {
        return err(routeError(`Invalid route parameter encoding for ${name}.`, 400));
      }
    }
    const branch = candidate.branch.map((entry) => ({ ...entry, params }));
    const matched = { route: candidate.route, branch, params, pathname };
    if (candidate.wildcard) {
      fallback = matched;
      continue;
    }
    return ok(matched);
  }
  return fallback ? ok(fallback) : err(routeError(`No route matched ${pathname}.`, 404));
};

const requestFor = (input: Request | URL | string): Request => {
  if (input instanceof Request) {
    return input;
  }
  return new Request(input instanceof URL ? input : new URL(input, "http://tachyon.local"));
};

const headAttributeNamePattern = /^[A-Za-z_:][A-Za-z0-9_.:-]*$/;
const urlAttributeNames = new Set(["href", "src", "action", "formaction"]);

const isSafeAttributeUrl = (value: string): boolean => {
  const controlCharacterPattern = /[\u0000-\u001F\u007F]/;
  if (controlCharacterPattern.test(value)) {
    return false;
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    try {
      const decoded = decodeURIComponent(trimmed);
      return !decoded.startsWith("//") && !decoded.includes("\\") && !controlCharacterPattern.test(decoded);
    } catch {
      return false;
    }
  }
  if (trimmed.startsWith("#") || trimmed.startsWith("mailto:")) {
    return true;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

const isSafeHeadAttribute = (name: string, value: string): boolean => {
  const normalized = name.toLowerCase();
  if (!headAttributeNamePattern.test(name) || normalized.startsWith("on")) {
    return false;
  }
  return !urlAttributeNames.has(normalized) || isSafeAttributeUrl(value);
};

const hasUnsafeUrlAttribute = (attrs: Record<string, string>): boolean =>
  Object.entries(attrs).some(([name, value]) => {
    const normalized = name.toLowerCase();
    return urlAttributeNames.has(normalized) && !isSafeAttributeUrl(value);
  });

const renderAttributes = (
  attrs: Record<string, string>,
  options: { dropOnUnsafeUrl?: boolean } = {},
): string | undefined => {
  if (options.dropOnUnsafeUrl && hasUnsafeUrlAttribute(attrs)) {
    return undefined;
  }
  return Object.entries(attrs)
    .filter(([name, value]) => isSafeHeadAttribute(name, value))
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
    .join("");
};

export const renderHead = (descriptor: RouteHeadDescriptor, options: { nonce?: string } = {}): string => {
  const chunks: string[] = [];
  if (descriptor.title !== undefined) {
    chunks.push(`<title>${escapeHtml(descriptor.title)}</title>`);
  }
  for (const meta of descriptor.metas ?? []) {
    chunks.push(`<meta${renderAttributes(meta) ?? ""}>`);
  }
  for (const link of descriptor.links ?? []) {
    const attrs = renderAttributes(link, { dropOnUnsafeUrl: true });
    if (attrs !== undefined) {
      chunks.push(`<link${attrs}>`);
    }
  }
  for (const script of descriptor.scripts ?? []) {
    chunks.push(
      `<script${renderAttributes({ ...script, ...(options.nonce && !script.nonce ? { nonce: options.nonce } : {}) }) ?? ""}></script>`,
    );
  }
  return chunks.join("");
};

export const renderResourceHints = (resources: readonly RouteResource[]): string =>
  resources
    .map((resource) => {
      const attrs: Record<string, string> = { rel: resource.rel, href: resource.href };
      for (const name of ["as", "type", "crossorigin", "fetchpriority"] as const) {
        const value = resource[name];
        if (value !== undefined) {
          attrs[name] = value;
        }
      }
      const rendered = renderAttributes(attrs, { dropOnUnsafeUrl: true });
      return rendered === undefined ? "" : `<link${rendered}>`;
    })
    .join("");

export const collectRouteResources = (
  branch: readonly { route: RouteDefinition; path: string; params: RouteParams }[],
  context?: Partial<RouteContext>,
): RouteResource[] => collectRouteResourcesInternal(branch, context);

const collectRouteResourcesInternal = (
  branch: readonly { route: RouteDefinition; path: string; params: RouteParams }[],
  context?: Partial<RouteExecutionContext>,
): RouteResource[] => {
  const resources: RouteResource[] = [];
  for (const entry of branch) {
    if (!entry.route.resources) {
      continue;
    }
    const id = routeId(entry.route, entry.path);
    const routeData =
      context?.loaderData && Object.hasOwn(context.loaderData, id) ? context.loaderData[id] : context?.data;
    const value =
      typeof entry.route.resources === "function"
        ? entry.route.resources({
            request: context?.request ?? new Request("http://tachyon.local/"),
            url: context?.url ?? new URL("http://tachyon.local/"),
            params: context?.params ?? entry.params,
            route: entry.route,
            env: context?.env ?? {},
            bindings: context?.bindings,
            data: routeData,
            loaderData: context?.loaderData ?? {},
            actionResult: context?.actionResult,
            outlet: context?.outlet ?? "",
          } as RouteExecutionContext)
        : entry.route.resources;
    resources.push(...value);
  }
  return resources;
};

const mergeHead = (heads: readonly RouteHeadDescriptor[]): RouteHeadDescriptor => {
  const title = [...heads].reverse().find((head) => head.title !== undefined)?.title;
  return {
    ...(title === undefined ? {} : { title }),
    metas: heads.flatMap((head) => head.metas ?? []),
    links: heads.flatMap((head) => head.links ?? []),
    scripts: heads.flatMap((head) => head.scripts ?? []),
  };
};

const applyHeaders = (headers: Headers, extra: HeadersInit): void => {
  new Headers(extra).forEach((value, key) => {
    if (key === "set-cookie") {
      headers.append(key, value);
      return;
    }
    headers.set(key, value);
  });
};

const nearestNotFoundBoundary = (
  routes: readonly RouteDefinition[],
  pathname: string,
): RouteDefinition["notFound"] | undefined => {
  const pathnameSegments = trimSlashes(pathname).split("/").filter(Boolean);
  let selected: { depth: number; handler: NonNullable<RouteDefinition["notFound"]> } | undefined;
  for (const candidate of flattenRoutes(routes)) {
    if (!candidate.route.notFound) {
      continue;
    }
    const patternSegments = trimSlashes(candidate.path).split("/").filter(Boolean);
    let matches = patternSegments.length <= pathnameSegments.length;
    for (let index = 0; matches && index < patternSegments.length; index += 1) {
      const pattern = patternSegments[index] as string;
      if (pattern === "*" || pattern.startsWith("*")) {
        break;
      }
      if (!pattern.startsWith(":") && pattern !== pathnameSegments[index]) {
        matches = false;
      }
    }
    if (matches && (!selected || patternSegments.length > selected.depth)) {
      selected = { depth: patternSegments.length, handler: candidate.route.notFound };
    }
  }
  return selected?.handler;
};

const renderRouteInternal = async (
  routes: readonly RouteDefinition[],
  input: Request | URL | string,
  options: RouteExecutionOptions = {},
): Promise<Result<RouteRenderResult, RouteError>> => {
  let request = requestFor(input);
  let url = new URL(request.url);
  const env = options.env ?? {};
  const bindings = options.bindings;
  const emptyMatch = (pathname = url.pathname): MatchedRoute => ({
    route: { path: "*", render: () => "" },
    branch: [],
    params: {},
    pathname,
  });
  const routeResponseResult = (response: RouteResponse, match = emptyMatch()): RouteRenderResult => ({
    status: response.status,
    html: response.headers.get("content-type")?.startsWith("text/html") ? response.body : "",
    responseBody: response.body,
    headHtml: "",
    resourceHints: "",
    stateScript: "",
    loaderData: {},
    actionResult: undefined,
    headers: response.headers,
    match,
  });
  const webResponseResult = async (response: Response, match = emptyMatch()): Promise<RouteRenderResult> => {
    const body = await response.text();
    return {
      status: response.status,
      html: response.headers.get("content-type")?.startsWith("text/html") ? body : "",
      responseBody: body,
      headHtml: "",
      resourceHints: "",
      stateScript: "",
      loaderData: {},
      actionResult: undefined,
      headers: response.headers,
      match,
    };
  };
  await options.hooks?.onRequest?.({ request, url });
  for (const middleware of options.middleware ?? []) {
    const result = await middleware({ request, url, env, bindings });
    if (isRouteResponse(result)) {
      return ok(routeResponseResult(result));
    }
    if (isWebResponse(result)) {
      return ok(await webResponseResult(result));
    }
    if (result instanceof Request) {
      request = result;
      url = new URL(request.url);
    }
  }
  if (options.allowedMethods && !options.allowedMethods.includes(request.method)) {
    return ok({
      status: 405,
      html: "<h1>Method Not Allowed</h1>",
      headHtml: "",
      resourceHints: "",
      stateScript: "",
      loaderData: {},
      actionResult: undefined,
      headers: new Headers({ allow: options.allowedMethods.join(", "), "content-type": "text/html; charset=utf-8" }),
      match: emptyMatch(),
    });
  }
  const contentLength = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
  if (options.maxActionBodyBytes !== undefined && contentLength > options.maxActionBodyBytes) {
    return ok(payloadTooLargeResult(emptyMatch()));
  }
  if (
    options.maxActionBodyBytes !== undefined &&
    request.method !== "GET" &&
    request.method !== "HEAD" &&
    request.body
  ) {
    const limitedRequest = await readLimitedRequest(request, options.maxActionBodyBytes);
    if (!limitedRequest) {
      return ok(payloadTooLargeResult(emptyMatch()));
    }
    request = limitedRequest;
    url = new URL(request.url);
  }
  const match = matchRoute(routes, url);
  if (!match.ok) {
    const boundary = nearestNotFoundBoundary(routes, url.pathname);
    const html = boundary
      ? await boundary({ request, url })
      : options.notFound
        ? await options.notFound({ request, url })
        : `<h1>Not Found</h1>`;
    return ok({
      status: 404,
      html,
      headHtml: "",
      resourceHints: "",
      stateScript: "",
      loaderData: {},
      actionResult: undefined,
      headers: new Headers(),
      match: emptyMatch(),
    });
  }
  try {
    await options.hooks?.onMatch?.({ request, url, match: match.value });
    let actionResult: unknown;
    const loaderData: Record<string, unknown> = {};
    if (request.method !== "GET" && request.method !== "HEAD" && match.value.route.action) {
      if (options.csrf && !(await verifyCsrf(request, url, env, bindings, options.csrf))) {
        return ok({
          status: 403,
          html: "<h1>Forbidden</h1>",
          headHtml: "",
          resourceHints: "",
          stateScript: "",
          loaderData: {},
          actionResult: undefined,
          headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
          match: match.value,
        });
      }
      actionResult = await match.value.route.action({
        request,
        url,
        params: match.value.params,
        route: match.value.route,
        env,
        bindings,
        loaderData,
        actionResult: undefined,
      } as Omit<RouteExecutionContext, "data" | "outlet">);
      await options.hooks?.onAction?.({ request, url, route: match.value.route, result: actionResult });
      if (isRouteResponse(actionResult)) {
        return ok({ ...routeResponseResult(actionResult, match.value), loaderData, actionResult });
      }
    }
    for (const entry of match.value.branch) {
      const id = routeId(entry.route, entry.path);
      if (entry.route.loader) {
        const data = await entry.route.loader({
          request,
          url,
          params: match.value.params,
          route: entry.route,
          env,
          bindings,
          loaderData,
          actionResult,
        } as Omit<RouteExecutionContext, "data" | "outlet">);
        if (isRouteResponse(data)) {
          return ok({ ...routeResponseResult(data, match.value), loaderData, actionResult });
        }
        loaderData[id] = isDeferredData(data) ? await resolveDeferredData(data) : data;
        await options.hooks?.onLoader?.({ request, url, route: entry.route, data: loaderData[id] });
      }
    }
    let outlet = "";
    const heads: RouteHeadDescriptor[] = [];
    for (const entry of [...match.value.branch].reverse()) {
      const id = routeId(entry.route, entry.path);
      const data = loaderData[id];
      const context = {
        request,
        url,
        params: match.value.params,
        route: entry.route,
        env,
        bindings,
        data,
        loaderData,
        actionResult,
        outlet,
      };
      outlet = await entry.route.render(context);
      if (entry.route.head) {
        heads.unshift(await entry.route.head(context));
      }
    }
    outlet = applyHtmlWhitespace(outlet, options.htmlWhitespace ?? "preserve-tags");
    await options.hooks?.onRender?.({ request, url, html: outlet, match: match.value });
    const stateScript = Object.entries(loaderData)
      .map(([id, data]) =>
        serializeHydrationState(`route:${id}`, data, options.cspNonce === undefined ? {} : { nonce: options.cspNonce }),
      )
      .join("");
    const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
    const deepestContext = {
      request,
      url,
      params: match.value.params,
      route: match.value.route,
      env,
      bindings,
      data: loaderData[routeId(match.value.route, match.value.pathname)],
      loaderData,
      actionResult,
      outlet,
    };
    for (const entry of match.value.branch) {
      const id = routeId(entry.route, entry.path);
      const context = { ...deepestContext, route: entry.route, data: loaderData[id] };
      if (entry.route.headers) {
        applyHeaders(
          headers,
          typeof entry.route.headers === "function" ? await entry.route.headers(context) : entry.route.headers,
        );
      }
      if (entry.route.cache) {
        const policy = typeof entry.route.cache === "function" ? await entry.route.cache(context) : entry.route.cache;
        applyHeaders(headers, cacheControl(policy));
      }
    }
    return ok({
      status: 200,
      html: outlet,
      headHtml: renderHead(mergeHead(heads), options.cspNonce === undefined ? {} : { nonce: options.cspNonce }),
      resourceHints: renderResourceHints(
        collectRouteResourcesInternal(match.value.branch, {
          request,
          url,
          params: match.value.params,
          env,
          bindings,
          loaderData,
          actionResult,
        }),
      ),
      stateScript,
      loaderData,
      actionResult,
      headers,
      match: match.value,
    });
  } catch (error) {
    await options.hooks?.onError?.({ request, url, error, match: match.value });
    const boundary = [...match.value.branch].reverse().find((entry) => entry.route.error)?.route.error ?? options.error;
    const html = boundary ? await boundary({ request, url, error }) : `<h1>Internal Server Error</h1>`;
    return ok({
      status: 500,
      html,
      headHtml: "",
      resourceHints: "",
      stateScript: "",
      loaderData: {},
      actionResult: undefined,
      headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
      match: match.value,
    });
  }
};

export const renderRoute = async (
  routes: readonly RouteDefinition[],
  input: Request | URL | string,
  options: RouteRenderOptions = {},
): Promise<Result<RouteRenderResult, RouteError>> => renderRouteInternal(routes, input, options);

/** @internal */
export const renderRouteWithBindings = renderRouteInternal;

export type RouteStreamResult = {
  status: number;
  chunks: AsyncIterable<string>;
  headHtml: string;
  resourceHints: string;
  stateScript: string;
  headers: Headers;
  final: Promise<Pick<RouteRenderResult, "headHtml" | "resourceHints" | "stateScript" | "headers" | "status">>;
};

const renderRouteStreamInternal = async (
  routes: readonly RouteDefinition[],
  input: Request | URL | string,
  options: RouteExecutionOptions = {},
): Promise<Result<RouteStreamResult, RouteError>> => {
  const request = requestFor(input);
  const streamingOptions = { ...options, htmlWhitespace: "preserve-tags" as const };
  const rendered = await renderRouteInternal(routes, request, streamingOptions);
  if (!rendered.ok) return err(rendered.error);
  const body = rendered.value.responseBody ?? rendered.value.html;
  const final = {
    status: rendered.value.status,
    headHtml: rendered.value.headHtml,
    resourceHints: rendered.value.resourceHints,
    stateScript: rendered.value.stateScript,
    headers: rendered.value.headers,
  };
  return ok({
    ...final,
    chunks: (async function* () {
      if (request.method !== "HEAD" && body) yield body;
    })(),
    final: Promise.resolve(final),
  });
};

export const renderRouteStream = async (
  routes: readonly RouteDefinition[],
  input: Request | URL | string,
  options: RouteRenderOptions = {},
): Promise<Result<RouteStreamResult, RouteError>> => renderRouteStreamInternal(routes, input, options);

/** @internal */
export const renderRouteStreamWithBindings = renderRouteStreamInternal;
