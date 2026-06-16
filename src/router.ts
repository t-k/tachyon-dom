import { readdir } from "node:fs/promises";
import path from "node:path";
import { err, ok, type Result } from "./result";
import { serializeHydrationState } from "./runtime/hydrate";

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

export type RouteContext<Data = unknown, ActionResult = unknown> = {
  request: Request;
  url: URL;
  params: RouteParams;
  route: RouteDefinition;
  data: Data;
  loaderData: Record<string, unknown>;
  actionResult: ActionResult;
  outlet: string;
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

const routeResponse = (body: string, init: ResponseInit = {}): RouteResponse => ({
  __tachyonRouteResponse: true,
  status: init.status ?? 200,
  headers: new Headers(init.headers),
  body,
});

export const redirect = (location: string, init: ResponseInit & { allowExternal?: boolean } = {}): RouteResponse => {
  if (!init.allowExternal && !location.startsWith("/")) {
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

export const html = (body: string, init: ResponseInit = {}): RouteResponse => {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "text/html; charset=utf-8");
  }
  return routeResponse(body, { ...init, headers });
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
    const nonce = options.nonce ? ` 'nonce-${options.nonce}' 'strict-dynamic'` : "";
    headers.set(
      "content-security-policy",
      `script-src${nonce} 'report-sample'; object-src 'none'; base-uri 'none'; frame-ancestors ${options.frameAncestors ?? "'self'"}; form-action 'self'`,
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
  if (file.endsWith(".tachyon.html")) {
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

export const createFileRouteManifest = (
  files: readonly string[],
  options: { rootDir: string },
): FileRouteManifestEntry[] =>
  files.flatMap((file) => {
    const kind = routeKindForFile(file);
    if (!kind) {
      return [];
    }
    const relative = path.relative(options.rootDir, file).replaceAll(path.sep, "/");
    const withoutExtension = relative.replace(/\.tachyon\.html$/, "").replace(/\.[tj]s$/, "");
    const parts = withoutExtension.split("/");
    const fileName = parts.at(-1) ?? "";
    const routeParts = kind === "module" || kind === "layout" ? parts.slice(0, -1) : parts;
    const pathSegments = routeParts.map(routeSegmentFromFile).filter(Boolean);
    const routePath = pathSegments.length === 0 ? "/" : `/${pathSegments.join("/")}`;
    const idParts = [
      ...routeParts.map(idSegmentFromFile),
      kind === "module" || kind === "layout" ? fileName : "",
    ].filter(Boolean);
    return [{ id: idParts.join("-") || "index", path: routePath, file, kind }];
  });

const collectFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(directory, entry.name);
      return entry.isDirectory() ? await collectFiles(absolute) : [absolute];
    }),
  );
  return files.flat();
};

export const scanFileRoutes = async (rootDir: string): Promise<FileRouteManifestEntry[]> =>
  createFileRouteManifest(await collectFiles(rootDir), { rootDir });

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

type FlatRoute = {
  route: RouteDefinition;
  path: string;
  branch: Array<{ route: RouteDefinition; path: string }>;
};

const flattenRoutes = (
  routes: readonly RouteDefinition[],
  parentPath = "",
  branch: Array<{ route: RouteDefinition; path: string }> = [],
): FlatRoute[] => {
  const flat: FlatRoute[] = [];
  for (const route of routes) {
    const path = joinPaths(parentPath, route.path);
    const nextBranch = [...branch, { route, path }];
    flat.push({ route, path, branch: nextBranch });
    if (route.children) {
      flat.push(...flattenRoutes(route.children, path, nextBranch));
    }
  }
  return flat;
};

export const matchRoute = (
  routes: readonly RouteDefinition[],
  input: string | URL,
): Result<MatchedRoute, RouteError> => {
  const url = typeof input === "string" ? new URL(input, "http://tachyon.local") : input;
  const pathname = url.pathname;
  let fallback: MatchedRoute | undefined;
  for (const candidate of flattenRoutes(routes)) {
    const compiled = compileRoutePath(candidate.path);
    const match = compiled.regex.exec(pathname);
    if (!match) {
      continue;
    }
    const params = Object.fromEntries(
      compiled.names.map((name, index) => [name, decodeURIComponent(match[index + 1] ?? "")]),
    );
    const branch = candidate.branch.map((entry) => ({ ...entry, params }));
    const matched = { route: candidate.route, branch, params, pathname };
    if (compiled.wildcard) {
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

const escapeHtml = (value: unknown): string =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll(`"`, "&quot;");

const renderAttributes = (attrs: Record<string, string>): string =>
  Object.entries(attrs)
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
    .join("");

export const renderHead = (descriptor: RouteHeadDescriptor): string => {
  const chunks: string[] = [];
  if (descriptor.title !== undefined) {
    chunks.push(`<title>${escapeHtml(descriptor.title)}</title>`);
  }
  for (const meta of descriptor.metas ?? []) {
    chunks.push(`<meta${renderAttributes(meta)}>`);
  }
  for (const link of descriptor.links ?? []) {
    chunks.push(`<link${renderAttributes(link)}>`);
  }
  for (const script of descriptor.scripts ?? []) {
    chunks.push(`<script${renderAttributes(script)}></script>`);
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
      return `<link${renderAttributes(attrs)}>`;
    })
    .join("");

export const collectRouteResources = (
  branch: readonly { route: RouteDefinition; path: string; params: RouteParams }[],
  context?: Partial<RouteContext>,
): RouteResource[] => {
  const resources: RouteResource[] = [];
  for (const entry of branch) {
    if (!entry.route.resources) {
      continue;
    }
    const value =
      typeof entry.route.resources === "function"
        ? entry.route.resources({
            request: context?.request ?? new Request("http://tachyon.local/"),
            url: context?.url ?? new URL("http://tachyon.local/"),
            params: context?.params ?? entry.params,
            route: entry.route,
            data: context?.data,
            loaderData: context?.loaderData ?? {},
            actionResult: context?.actionResult,
            outlet: context?.outlet ?? "",
          })
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

export const renderRoute = async (
  routes: readonly RouteDefinition[],
  input: Request | URL | string,
  options: RouteRenderOptions = {},
): Promise<Result<RouteRenderResult, RouteError>> => {
  const request = requestFor(input);
  const url = new URL(request.url);
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
      match: {
        route: { path: "*", render: () => "" },
        branch: [],
        params: {},
        pathname: url.pathname,
      },
    });
  }
  const contentLength = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
  if (options.maxActionBodyBytes !== undefined && contentLength > options.maxActionBodyBytes) {
    return ok({
      status: 413,
      html: "<h1>Payload Too Large</h1>",
      headHtml: "",
      resourceHints: "",
      stateScript: "",
      loaderData: {},
      actionResult: undefined,
      headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
      match: {
        route: { path: "*", render: () => "" },
        branch: [],
        params: {},
        pathname: url.pathname,
      },
    });
  }
  const match = matchRoute(routes, url);
  if (!match.ok) {
    const html = options.notFound ? await options.notFound({ request, url }) : `<h1>Not Found</h1>`;
    return ok({
      status: 404,
      html,
      headHtml: "",
      resourceHints: "",
      stateScript: "",
      loaderData: {},
      actionResult: undefined,
      headers: new Headers(),
      match: {
        route: { path: "*", render: () => html },
        branch: [],
        params: {},
        pathname: url.pathname,
      },
    });
  }
  try {
    let actionResult: unknown;
    const loaderData: Record<string, unknown> = {};
    if (request.method !== "GET" && request.method !== "HEAD" && match.value.route.action) {
      actionResult = await match.value.route.action({
        request,
        url,
        params: match.value.params,
        route: match.value.route,
        loaderData,
        actionResult: undefined,
      });
      if (isRouteResponse(actionResult)) {
        return ok({
          status: actionResult.status,
          html: actionResult.headers.get("content-type")?.startsWith("text/html") ? actionResult.body : "",
          responseBody: actionResult.body,
          headHtml: "",
          resourceHints: "",
          stateScript: "",
          loaderData,
          actionResult,
          headers: actionResult.headers,
          match: match.value,
        });
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
          loaderData,
          actionResult,
        });
        if (isRouteResponse(data)) {
          return ok({
            status: data.status,
            html: data.headers.get("content-type")?.startsWith("text/html") ? data.body : "",
            responseBody: data.body,
            headHtml: "",
            resourceHints: "",
            stateScript: "",
            loaderData,
            actionResult,
            headers: data.headers,
            match: match.value,
          });
        }
        loaderData[id] = data;
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
    const stateScript = Object.entries(loaderData)
      .map(([id, data]) => serializeHydrationState(`route:${id}`, data))
      .join("");
    return ok({
      status: 200,
      html: outlet,
      headHtml: renderHead(mergeHead(heads)),
      resourceHints: renderResourceHints(
        collectRouteResources(match.value.branch, {
          request,
          url,
          params: match.value.params,
          loaderData,
          actionResult,
        }),
      ),
      stateScript,
      loaderData,
      actionResult,
      headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
      match: match.value,
    });
  } catch (error) {
    const boundary = match.value.route.error ?? options.error;
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

export type RouteStreamResult = {
  status: number;
  chunks: AsyncIterable<string>;
  headHtml: string;
  resourceHints: string;
  stateScript: string;
  headers: Headers;
};

export const renderRouteStream = async (
  routes: readonly RouteDefinition[],
  input: Request | URL | string,
  options: RouteRenderOptions = {},
): Promise<Result<RouteStreamResult, RouteError>> => {
  const request = requestFor(input);
  const url = new URL(request.url);
  const match = matchRoute(routes, url);
  if (!match.ok) {
    const rendered = await renderRoute(routes, request, options);
    if (!rendered.ok) {
      return err(rendered.error);
    }
    return ok({
      status: rendered.value.status,
      chunks: (async function* () {
        yield rendered.value.html;
      })(),
      headHtml: rendered.value.headHtml,
      resourceHints: rendered.value.resourceHints,
      stateScript: rendered.value.stateScript,
      headers: rendered.value.headers,
    });
  }
  const chunks = async function* (): AsyncIterable<string> {
    for (const entry of match.value.branch) {
      if (entry.route.fallback) {
        yield entry.route.fallback;
      }
    }
    const rendered = await renderRoute(routes, request, options);
    if (rendered.ok) {
      yield rendered.value.html;
    }
  };
  return ok({
    status: 200,
    chunks: chunks(),
    headHtml: "",
    resourceHints: renderResourceHints(collectRouteResources(match.value.branch)),
    stateScript: "",
    headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
  });
};
