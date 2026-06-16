import { err, ok, type Result } from "./result";
import { serializeHydrationState } from "./runtime/hydrate";

export type RouteParams = Record<string, string>;

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
  render: (context: RouteContext<Data, ActionResult>) => string | Promise<string>;
  children?: RouteDefinition[];
};

export type RouteManifestEntry = {
  id: string;
  path: string;
  parentId?: string;
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
  stateScript: string;
  loaderData: Record<string, unknown>;
  actionResult: unknown;
  match: MatchedRoute;
};

export type RouteRenderOptions = {
  notFound?: (context: { request: Request; url: URL }) => string | Promise<string>;
  error?: (context: { request: Request; url: URL; error: unknown }) => string | Promise<string>;
};

export type RouteError = {
  message: string;
  status: number;
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
  const match = matchRoute(routes, url);
  if (!match.ok) {
    const html = options.notFound ? await options.notFound({ request, url }) : `<h1>Not Found</h1>`;
    return ok({
      status: 404,
      html,
      headHtml: "",
      stateScript: "",
      loaderData: {},
      actionResult: undefined,
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
    }
    for (const entry of match.value.branch) {
      const id = routeId(entry.route, entry.path);
      if (entry.route.loader) {
        loaderData[id] = await entry.route.loader({
          request,
          url,
          params: match.value.params,
          route: entry.route,
          loaderData,
          actionResult,
        });
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
      stateScript,
      loaderData,
      actionResult,
      match: match.value,
    });
  } catch (error) {
    const html = options.error ? await options.error({ request, url, error }) : `<h1>Internal Server Error</h1>`;
    return ok({
      status: 500,
      html,
      headHtml: "",
      stateScript: "",
      loaderData: {},
      actionResult: undefined,
      match: match.value,
    });
  }
};
