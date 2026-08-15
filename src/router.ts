import { escapeHtml } from "./html-escape.js";
import { err, ok, type Result } from "./result.js";
import { serializeHydrationState } from "./runtime/hydrate.js";
import { applyHtmlWhitespace, resolveHtmlWhitespacePolicy, type HtmlWhitespacePolicy } from "./html-whitespace.js";
import { validateRedirectTarget } from "./redirect-policy.js";
import { sanitizeHeadAttributes } from "./head-policy.js";
import { closeAsyncIterable, composeSingleOutlet, type SingleOutletSegments } from "./stream-segments.js";

export { fragmentDocument, htmlDocument } from "./router-document.js";
export type { HtmlDocumentOptions, RouteDocumentComposer, RouteDocumentMetadata } from "./router-document.js";

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

export type StreamLayoutSegments = SingleOutletSegments;

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
  /**
   * Streams the deepest matched route after loaders and authoritative metadata resolve.
   * Every string is trusted raw HTML: adapters do not escape or sanitize chunks. Use
   * trustedHtmlChunk(escapeToHtml(value)) for untrusted text and a vetted sanitizer
   * followed by trustedHtmlChunk() for intentionally accepted markup.
   */
  stream?: (context: RouteContext<Data, ActionResult>) => AsyncIterable<string>;
  streamLayout?: (context: RouteContext<Data, ActionResult>) => StreamLayoutSegments | Promise<StreamLayoutSegments>;
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
  bodyKind: "route" | "pass-through" | "bodyless";
  html: string;
  headHtml: string;
  resourceHints: string;
  stateScript: string;
  loaderData: Record<string, unknown>;
  actionResult: unknown;
  match: MatchedRoute;
  headers: Headers;
  responseBody?: string;
  responseChunks?: AsyncIterable<string>;
  webResponse?: Response;
  error?: RouteError;
};

const bodylessStatuses = new Set([204, 205, 304]);

const normalizeBodylessRouteResult = (result: RouteRenderResult, forceBodyless = false): RouteRenderResult => {
  if (!forceBodyless && !bodylessStatuses.has(result.status)) {
    return result;
  }
  const headers = new Headers(result.headers);
  if (result.status === 204 || result.status === 205) {
    headers.delete("content-length");
    headers.delete("transfer-encoding");
  }
  const { responseBody: _responseBody, responseChunks: _responseChunks, webResponse, ...rest } = result;
  return {
    ...rest,
    bodyKind: "bodyless",
    html: "",
    headers,
    ...(webResponse
      ? {
          webResponse: new Response(null, {
            status: webResponse.status,
            statusText: webResponse.statusText,
            headers,
          }),
        }
      : {}),
  };
};

type RouteRenderOptionsBase = {
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
};

export type RouteRenderOptions = RouteRenderOptionsBase & {
  /** Applied only after buffered rendering. Streaming chunks are always preserved. */
  htmlWhitespace?: HtmlWhitespacePolicy;
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
  stream?: RouteDefinition<Data, ActionResult>["stream"];
  streamLayout?: RouteDefinition<Data, ActionResult>["streamLayout"];
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

const userGuardAuthorizationState: unique symbol = Symbol("tachyon.userGuardAuthorizationState");

type UserGuardAuthorizationState = {
  authorized: boolean;
};

type InternalRouteMiddlewareContext = {
  [userGuardAuthorizationState]?: UserGuardAuthorizationState;
};

export type RouteMiddlewareContext = {
  request: Request;
  url: URL;
  env: RouteEnvironment;
  readonly [userGuardAuthorizationState]: UserGuardAuthorizationState;
};

export type RouteMiddleware = (
  context: RouteMiddlewareContext,
) => RouteMiddlewareResult | Promise<RouteMiddlewareResult>;

type RouteExecutionContext = RouteContext & { bindings?: unknown };

type RouteExecutionOptions = Omit<RouteRenderOptionsBase, "csrf" | "middleware"> & {
  bindings?: unknown;
  progressiveBody?: boolean;
  htmlWhitespace?: HtmlWhitespacePolicy;
  csrf?: {
    verify: (context: {
      request: Request;
      url: URL;
      env: RouteEnvironment;
      bindings?: unknown;
    }) => boolean | Promise<boolean>;
  };
  middleware?: readonly ((
    context: RouteMiddlewareContext & { bindings?: unknown },
  ) => RouteMiddlewareResult | Promise<RouteMiddlewareResult>)[];
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

export const redirect = (location: string, init: RedirectOptions = {}): RouteResponse => {
  const decision = validateRedirectTarget(location, init);
  if (!decision.ok) {
    throw new Error(decision.error);
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

/**
 * Converts a factory-created TrustedHtml value into a raw progressive response chunk.
 * Route stream chunks are inserted as HTML without adapter escaping. Escape untrusted
 * text with escapeToHtml(), or sanitize intentional markup with a vetted sanitizer,
 * before calling this helper.
 */
export const trustedHtmlChunk = (value: TrustedHtml): string => trustedHtmlValue(value);

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
): Promise<boolean> => {
  const csrfRequest = callbackRequestSnapshot(request);
  try {
    return await options.verify({ request: csrfRequest, url: new URL(url), env, bindings });
  } finally {
    releaseRequestSnapshot(csrfRequest);
  }
};

const csrfSafeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

const payloadTooLargeResult = (match: MatchedRoute): RouteRenderResult => ({
  status: 413,
  bodyKind: "route",
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
  if (request.bodyUsed || request.body.locked) {
    return undefined;
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

const requestWithinBodyLimit = async (request: Request, maxBytes: number): Promise<Request | undefined> => {
  const contentLength = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
  if (contentLength > maxBytes) {
    return undefined;
  }
  if (request.method === "GET" || request.method === "HEAD") {
    return request;
  }
  return readLimitedRequest(request, maxBytes);
};

const callbackRequestSnapshot = (request: Request): Request => {
  try {
    return request.clone();
  } catch {
    return new Request(request.url, {
      headers: request.headers,
      method: request.method,
      redirect: request.redirect,
      signal: request.signal,
    });
  }
};

const releaseRequestSnapshot = (request: Request): void => {
  if (!request.body || request.body.locked) {
    return;
  }
  void request.body.cancel().catch(() => {
    // The callback may already have consumed or canceled its isolated body.
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

export const requireUser = <User>(
  getUser: (context: { request: Request; url: URL }) => User | undefined | null | Promise<User | undefined | null>,
  options: UserGuardOptions<User> = {},
): RouteMiddleware => {
  const middleware: RouteMiddleware = async (context) => {
    const authorizationState = (context as InternalRouteMiddlewareContext)[userGuardAuthorizationState];
    if (!authorizationState) {
      throw new TypeError("requireUser must receive the complete router-supplied middleware context.");
    }
    const { request, url } = context;
    const user = await getUser({ request, url });
    if (user) {
      await options.onUser?.({ request, url, user });
      authorizationState.authorized = true;
      return;
    }
    if (options.forbidden) {
      return options.forbidden({ request, url });
    }
    return redirect(options.getRedirect?.({ request, url }) ?? options.redirectTo ?? "/login");
  };
  return middleware;
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
  ...(module.stream ? { stream: module.stream } : {}),
  ...(module.streamLayout ? { streamLayout: module.streamLayout } : {}),
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
  try {
    decodeURIComponent(pathname);
  } catch {
    return err(routeError("Invalid path encoding.", 400));
  }
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

const renderAttributes = (
  element: "meta" | "link" | "script",
  attrs: Record<string, string>,
  options: { dropOnUnsafeUrl?: boolean } = {},
): string | undefined => {
  const safeAttributes = sanitizeHeadAttributes(element, attrs, options);
  if (!safeAttributes) return undefined;
  return Object.entries(safeAttributes)
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
    .join("");
};

export const renderHead = (descriptor: RouteHeadDescriptor, options: { nonce?: string } = {}): string => {
  const chunks: string[] = [];
  if (descriptor.title !== undefined) {
    chunks.push(`<title>${escapeHtml(descriptor.title)}</title>`);
  }
  for (const meta of descriptor.metas ?? []) {
    chunks.push(`<meta${renderAttributes("meta", meta) ?? ""}>`);
  }
  for (const link of descriptor.links ?? []) {
    const attrs = renderAttributes("link", link, { dropOnUnsafeUrl: true });
    if (attrs !== undefined) {
      chunks.push(`<link${attrs}>`);
    }
  }
  for (const script of descriptor.scripts ?? []) {
    chunks.push(
      `<script${renderAttributes("script", { ...script, ...(options.nonce && !script.nonce ? { nonce: options.nonce } : {}) }) ?? ""}></script>`,
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
      const rendered = renderAttributes("link", attrs, { dropOnUnsafeUrl: true });
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

const ownAsyncIterable = (source: AsyncIterable<string>, onClose: () => void = () => {}): AsyncIterable<string> => {
  const sourceIterator = source[Symbol.asyncIterator]();
  let finished = false;
  let returned = false;
  let closed = false;
  const notifyClosed = (): void => {
    if (closed) return;
    closed = true;
    onClose();
  };
  const close = async (): Promise<void> => {
    if (finished || returned) {
      notifyClosed();
      return;
    }
    returned = true;
    try {
      await sourceIterator.return?.();
    } finally {
      finished = true;
      notifyClosed();
    }
  };
  const iterator: AsyncIterableIterator<string> = {
    [Symbol.asyncIterator]: () => iterator,
    next: async () => {
      if (finished) return { done: true, value: undefined };
      try {
        const next = await sourceIterator.next();
        if (next.done) {
          finished = true;
          notifyClosed();
        }
        return next;
      } catch (error) {
        await close();
        throw error;
      }
    },
    return: async () => {
      await close();
      return { done: true, value: undefined };
    },
  };
  return iterator;
};

const createProgressiveOutletMarker = (): string => `__tachyon_progressive_outlet_${globalThis.crypto.randomUUID()}__`;

const legacyStreamLayoutSegments = (rendered: string, marker: string): StreamLayoutSegments => {
  const first = rendered.indexOf(marker);
  if (first < 0 || first !== rendered.lastIndexOf(marker)) {
    throw new TypeError(
      "A progressive ancestor layout must preserve exactly one outlet; use streamLayout for explicit composition.",
    );
  }
  return {
    before: rendered.slice(0, first),
    after: rendered.slice(first + marker.length),
    outlet: "once",
  };
};

const validateStreamLayoutSegments = (value: StreamLayoutSegments): StreamLayoutSegments => {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.before !== "string" ||
    typeof value.after !== "string" ||
    (value.outlet !== "once" && value.outlet !== "omit")
  ) {
    throw new TypeError("streamLayout must return string before/after segments and one bounded outlet mode.");
  }
  return value;
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
  if (
    options.maxActionBodyBytes !== undefined &&
    (!Number.isFinite(options.maxActionBodyBytes) ||
      !Number.isInteger(options.maxActionBodyBytes) ||
      options.maxActionBodyBytes < 0)
  ) {
    throw new TypeError("maxActionBodyBytes must be a non-negative finite integer.");
  }
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
    bodyKind: "pass-through",
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
  const webResponseResult = (response: Response, match = emptyMatch()): RouteRenderResult => ({
    status: response.status,
    bodyKind: "pass-through",
    html: "",
    webResponse: response,
    headHtml: "",
    resourceHints: "",
    stateScript: "",
    loaderData: {},
    actionResult: undefined,
    headers: new Headers(response.headers),
    match,
  });
  const finish = (result: RouteRenderResult): Result<RouteRenderResult, RouteError> => {
    releaseRequestSnapshot(request);
    return ok(normalizeBodylessRouteResult(result, request.method === "HEAD"));
  };
  if (options.maxActionBodyBytes !== undefined) {
    const limitedRequest = await requestWithinBodyLimit(request, options.maxActionBodyBytes);
    if (!limitedRequest) {
      return finish(payloadTooLargeResult(emptyMatch()));
    }
    request = limitedRequest;
    url = new URL(request.url);
  }
  if (options.hooks?.onRequest) {
    const hookRequest = callbackRequestSnapshot(request);
    try {
      await options.hooks.onRequest({ request: hookRequest, url: new URL(url) });
    } catch (error) {
      releaseRequestSnapshot(request);
      throw error;
    } finally {
      releaseRequestSnapshot(hookRequest);
    }
  }
  let userGuardAuthorized = false;
  for (const middleware of options.middleware ?? []) {
    const middlewareRequest = callbackRequestSnapshot(request);
    const authorizationState: UserGuardAuthorizationState = { authorized: false };
    const middlewareContext: RouteMiddlewareContext & { bindings?: unknown } = {
      request: middlewareRequest,
      url: new URL(url),
      env,
      bindings,
      [userGuardAuthorizationState]: authorizationState,
    };
    let result: RouteMiddlewareResult;
    try {
      result = await middleware(middlewareContext);
    } catch (error) {
      releaseRequestSnapshot(middlewareRequest);
      releaseRequestSnapshot(request);
      throw error;
    }
    const authorizedByMiddleware = authorizationState.authorized;
    if (isRouteResponse(result)) {
      releaseRequestSnapshot(middlewareRequest);
      return finish(routeResponseResult(result));
    }
    if (isWebResponse(result)) {
      if (request.method === "HEAD" && result.body) {
        await result.body.cancel();
      }
      const rendered = webResponseResult(result);
      releaseRequestSnapshot(middlewareRequest);
      return finish(rendered);
    }
    if (result instanceof Request) {
      if ((userGuardAuthorized || authorizedByMiddleware) && result !== middlewareRequest) {
        releaseRequestSnapshot(middlewareRequest);
        releaseRequestSnapshot(request);
        throw new TypeError("Middleware cannot replace the request after requireUser has authorized it.");
      }
      if (userGuardAuthorized || authorizedByMiddleware) {
        releaseRequestSnapshot(middlewareRequest);
        userGuardAuthorized = true;
        continue;
      }
      const previousRequest = request;
      let nextRequest: Request | undefined;
      if (options.maxActionBodyBytes !== undefined) {
        const limitedRequest = await requestWithinBodyLimit(result, options.maxActionBodyBytes);
        if (!limitedRequest) {
          releaseRequestSnapshot(middlewareRequest);
          if (result !== middlewareRequest) {
            releaseRequestSnapshot(result);
          }
          return finish(payloadTooLargeResult(emptyMatch()));
        }
        if (limitedRequest === result) {
          try {
            nextRequest = result.clone();
          } catch {
            // Handled below after every exposed request branch is released.
          }
        } else {
          nextRequest = limitedRequest;
        }
      } else {
        try {
          nextRequest = result.clone();
        } catch {
          // Handled below after every exposed request branch is released.
        }
      }
      releaseRequestSnapshot(middlewareRequest);
      if (result !== middlewareRequest) {
        releaseRequestSnapshot(result);
      }
      if (!nextRequest) {
        releaseRequestSnapshot(previousRequest);
        throw new TypeError("Middleware returned a Request with an unavailable body.");
      }
      request = nextRequest;
      releaseRequestSnapshot(previousRequest);
      url = new URL(request.url);
    } else {
      releaseRequestSnapshot(middlewareRequest);
    }
    userGuardAuthorized ||= authorizedByMiddleware;
  }
  if (options.allowedMethods && !options.allowedMethods.includes(request.method)) {
    return finish({
      status: 405,
      bodyKind: "route",
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
  const match = matchRoute(routes, url);
  if (!match.ok) {
    if (match.error.status === 400) {
      return finish({
        status: 400,
        bodyKind: "route",
        html: "<h1>Bad Request</h1>",
        headHtml: "",
        resourceHints: "",
        stateScript: "",
        loaderData: {},
        actionResult: undefined,
        headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
        match: emptyMatch(),
        error: match.error,
      });
    }
    const boundary = nearestNotFoundBoundary(routes, url.pathname);
    const html = boundary
      ? await boundary({ request, url })
      : options.notFound
        ? await options.notFound({ request, url })
        : `<h1>Not Found</h1>`;
    return finish({
      status: 404,
      bodyKind: "route",
      html,
      headHtml: "",
      resourceHints: "",
      stateScript: "",
      loaderData: {},
      actionResult: undefined,
      headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
      match: emptyMatch(),
    });
  }
  let progressiveBodyToClose: AsyncIterable<string> | undefined;
  try {
    if (
      options.csrf &&
      !csrfSafeMethods.has(request.method) &&
      !(await verifyCsrf(request, url, env, bindings, options.csrf))
    ) {
      return finish({
        status: 403,
        bodyKind: "route",
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
    if (options.hooks?.onMatch) {
      const hookRequest = callbackRequestSnapshot(request);
      try {
        await options.hooks.onMatch({ request: hookRequest, url: new URL(url), match: match.value });
      } finally {
        releaseRequestSnapshot(hookRequest);
      }
    }
    let actionResult: unknown;
    const loaderData: Record<string, unknown> = {};
    if (!csrfSafeMethods.has(request.method) && match.value.route.action) {
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
      if (options.hooks?.onAction) {
        const hookRequest = callbackRequestSnapshot(request);
        try {
          await options.hooks.onAction({
            request: hookRequest,
            url: new URL(url),
            route: match.value.route,
            result: actionResult,
          });
        } finally {
          releaseRequestSnapshot(hookRequest);
        }
      }
      if (isRouteResponse(actionResult)) {
        return finish({ ...routeResponseResult(actionResult, match.value), loaderData, actionResult });
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
          return finish({ ...routeResponseResult(data, match.value), loaderData, actionResult });
        }
        loaderData[id] = isDeferredData(data) ? await resolveDeferredData(data) : data;
        if (options.hooks?.onLoader) {
          const hookRequest = callbackRequestSnapshot(request);
          try {
            await options.hooks.onLoader({
              request: hookRequest,
              url: new URL(url),
              route: entry.route,
              data: loaderData[id],
            });
          } finally {
            releaseRequestSnapshot(hookRequest);
          }
        }
      }
    }
    const progressiveStream =
      options.progressiveBody === true && request.method !== "HEAD" ? match.value.route.stream : undefined;
    let outlet = "";
    const heads: RouteHeadDescriptor[] = [];
    const deepestEntry = match.value.branch.at(-1);
    const progressiveContext = {
      request,
      url,
      params: match.value.params,
      route: match.value.route,
      env,
      bindings,
      data: deepestEntry ? loaderData[routeId(deepestEntry.route, deepestEntry.path)] : undefined,
      loaderData,
      actionResult,
      outlet: "",
    };
    let responseChunks: AsyncIterable<string> | undefined;
    if (progressiveStream) {
      responseChunks = ownAsyncIterable(progressiveStream(progressiveContext), () => releaseRequestSnapshot(request));
      progressiveBodyToClose = responseChunks;
    }
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
        outlet: progressiveStream ? "" : outlet,
      };
      if (progressiveStream) {
        if (entry.route !== match.value.route) {
          let segments: StreamLayoutSegments;
          if (entry.route.streamLayout) {
            segments = validateStreamLayoutSegments(await entry.route.streamLayout(context));
          } else {
            const marker = createProgressiveOutletMarker();
            let rendered: string;
            try {
              rendered = await entry.route.render({ ...context, outlet: marker });
            } catch {
              throw new TypeError("A progressive ancestor layout failed while rendering.");
            }
            segments = legacyStreamLayoutSegments(rendered, marker);
          }
          responseChunks = await composeSingleOutlet(responseChunks as AsyncIterable<string>, segments);
          progressiveBodyToClose = responseChunks;
        }
      } else {
        outlet = await entry.route.render(context);
      }
      if (entry.route.head) {
        heads.unshift(await entry.route.head(context));
      }
    }
    outlet = applyHtmlWhitespace(outlet, options.htmlWhitespace ?? "preserve-tags");
    if (options.hooks?.onRender) {
      const hookRequest = callbackRequestSnapshot(request);
      try {
        await options.hooks.onRender({ request: hookRequest, url: new URL(url), html: outlet, match: match.value });
      } finally {
        releaseRequestSnapshot(hookRequest);
      }
    }
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
      data: deepestEntry ? loaderData[routeId(deepestEntry.route, deepestEntry.path)] : undefined,
      loaderData,
      actionResult,
      outlet: progressiveStream ? "" : outlet,
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
    const result: RouteRenderResult = {
      status: 200,
      bodyKind: "route",
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
      ...(responseChunks ? { responseChunks } : {}),
    };
    return responseChunks ? ok(normalizeBodylessRouteResult(result)) : finish(result);
  } catch (error) {
    if (progressiveBodyToClose) {
      await closeAsyncIterable(progressiveBodyToClose);
      progressiveBodyToClose = undefined;
    }
    if (options.hooks?.onError) {
      const hookRequest = callbackRequestSnapshot(request);
      try {
        await options.hooks.onError({ request: hookRequest, url: new URL(url), error, match: match.value });
      } finally {
        releaseRequestSnapshot(hookRequest);
      }
    }
    const boundary = [...match.value.branch].reverse().find((entry) => entry.route.error)?.route.error ?? options.error;
    const html = boundary ? await boundary({ request, url, error }) : `<h1>Internal Server Error</h1>`;
    return finish({
      status: 500,
      bodyKind: "route",
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
  bodyKind: "route" | "pass-through" | "bodyless";
  headHtml: string;
  resourceHints: string;
  stateScript: string;
  headers: Headers;
  webResponse?: Response;
  error?: RouteError;
  final: Promise<Pick<RouteRenderResult, "headHtml" | "resourceHints" | "stateScript" | "headers" | "status">>;
};

const renderRouteStreamInternal = async (
  routes: readonly RouteDefinition[],
  input: Request | URL | string,
  options: RouteExecutionOptions = {},
): Promise<Result<RouteStreamResult, RouteError>> => {
  const request = requestFor(input);
  resolveHtmlWhitespacePolicy(options.htmlWhitespace ?? "preserve-tags");
  const streamingOptions = { ...options, htmlWhitespace: "preserve-tags" as const };
  streamingOptions.progressiveBody = true;
  const rendered = await renderRouteInternal(routes, request, streamingOptions);
  if (!rendered.ok) return err(rendered.error);
  const body = rendered.value.bodyKind === "pass-through" ? (rendered.value.responseBody ?? "") : rendered.value.html;
  const bodyKind = request.method === "HEAD" ? "bodyless" : rendered.value.bodyKind;
  const final = {
    status: rendered.value.status,
    headHtml: rendered.value.headHtml,
    resourceHints: rendered.value.resourceHints,
    stateScript: rendered.value.stateScript,
    headers: rendered.value.headers,
  };
  return ok({
    ...final,
    bodyKind,
    ...(rendered.value.webResponse ? { webResponse: rendered.value.webResponse } : {}),
    ...(rendered.value.error ? { error: rendered.value.error } : {}),
    chunks: rendered.value.webResponse
      ? (async function* () {})()
      : (rendered.value.responseChunks ??
        (async function* () {
          if (request.method !== "HEAD" && body) yield body;
        })()),
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
