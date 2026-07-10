import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import {
  createWorkersFetchHandler,
  createWorkersHandler,
  type AdapterObservabilityHooks,
  type AdapterFetchHandler,
  type StaticRouteDefinition,
  type WorkersFetchHandlerOptions,
  type RouteAdapterHandlerOptions,
} from "./workers.js";

export type NodeHandlerOptions = RouteAdapterHandlerOptions & {
  staticAssets?: StaticAssetOptions;
  origin?: string | ((request: IncomingMessage) => string);
  trustedHosts?: readonly string[];
  trustProxy?: boolean;
};

export type NodeFetchHandlerOptions = Omit<WorkersFetchHandlerOptions, "fetch"> & {
  fetch: AdapterFetchHandler;
  staticAssets?: StaticAssetOptions;
  origin?: string | ((request: IncomingMessage) => string);
  trustedHosts?: readonly string[];
  trustProxy?: boolean;
};

export type StaticAssetOptions = {
  rootDir: string;
  basePath?: string;
  headers?: HeadersInit;
  fallthroughOnNotFound?: boolean;
};

const mergeHeaders = (base: Headers, extra?: Headers): Headers => {
  const headers = new Headers(base);
  extra?.forEach((value, key) => headers.set(key, value));
  return headers;
};

const contentTypeFor = (file: string): string => {
  if (file.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (file.endsWith(".js") || file.endsWith(".mjs")) {
    return "text/javascript; charset=utf-8";
  }
  if (file.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  if (file.endsWith(".svg")) {
    return "image/svg+xml";
  }
  if (file.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (file.endsWith(".wasm")) {
    return "application/wasm";
  }
  return "application/octet-stream";
};

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

const setNodeHeaders = (response: ServerResponse, headers: Headers): void => {
  const setCookies = headers.getSetCookie();
  headers.forEach((value, key) => {
    if (key.toLowerCase() !== "set-cookie") {
      response.setHeader(key, value);
    }
  });
  if (setCookies.length === 1) {
    response.setHeader("set-cookie", setCookies[0] ?? "");
  } else if (setCookies.length > 1) {
    response.setHeader("set-cookie", setCookies);
  }
};

const writeNodeStaticRoute = (
  route: StaticRouteDefinition,
  request: IncomingMessage,
  response: ServerResponse,
  securityHeaders?: Headers,
): void => {
  response.statusCode = route.status ?? 200;
  setNodeHeaders(response, headersForStaticRoute(route, securityHeaders));
  response.end(request.method === "HEAD" ? undefined : route.body);
};

const withSecurityHeaders = (response: Response, securityHeaders?: Headers): Response => {
  if (!securityHeaders) {
    return response;
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: mergeHeaders(response.headers, securityHeaders),
  });
};

const isFileSystemNotFound = (error: unknown): boolean => {
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
};

const rawPathnameFromRequestUrl = (requestUrl: string | undefined): string => {
  const raw = requestUrl ?? "/";
  const queryStart = raw.search(/[?#]/);
  return queryStart === -1 ? raw : raw.slice(0, queryStart);
};

const rawPathStartsWithBase = (rawPathname: string, basePath: string): boolean => {
  if (basePath === "/") {
    return rawPathname.startsWith("/");
  }
  return rawPathname === basePath || rawPathname.startsWith(`${basePath}/`);
};

const staticAssetTraversalResponse = (
  requestUrl: string | undefined,
  options: StaticAssetOptions,
): Response | undefined => {
  const basePath = options.basePath ?? "/";
  const rawPathname = rawPathnameFromRequestUrl(requestUrl);
  try {
    const decodedPathname = decodeURIComponent(rawPathname);
    if (!rawPathStartsWithBase(rawPathname, basePath) && !rawPathStartsWithBase(decodedPathname, basePath)) {
      return undefined;
    }
    const relativePath = decodedPathname.slice(basePath.length).replace(/^\/+/, "");
    return relativePath.split(/[\\/]/).includes("..") ? new Response("Forbidden", { status: 403 }) : undefined;
  } catch {
    return undefined;
  }
};

export const createStaticAssetHandler =
  (options: StaticAssetOptions): ((request: Request) => Promise<Response | undefined>) =>
  async (request) => {
    const basePath = options.basePath ?? "/";
    const url = new URL(request.url);
    if (basePath !== "/" && url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      return undefined;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      if (options.fallthroughOnNotFound) {
        return undefined;
      }
      return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    }
    let relativePath: string;
    try {
      relativePath = decodeURIComponent(url.pathname.slice(basePath.length)).replace(/^\/+/, "");
    } catch {
      return new Response("Not Found", { status: 404 });
    }
    if (!relativePath) {
      return options.fallthroughOnNotFound ? undefined : new Response("Forbidden", { status: 403 });
    }
    if (relativePath.split(/[\\/]/).some((segment) => segment === ".." || segment.startsWith("."))) {
      return new Response("Forbidden", { status: 403 });
    }
    const root = path.resolve(options.rootDir);
    const file = path.resolve(root, relativePath);
    if (!file.startsWith(`${root}${path.sep}`)) {
      return new Response("Forbidden", { status: 403 });
    }
    try {
      const canonicalRoot = await realpath(root);
      const canonicalFile = await realpath(file);
      if (!canonicalFile.startsWith(`${canonicalRoot}${path.sep}`)) {
        return new Response("Forbidden", { status: 403 });
      }
      const canonicalRelativePath = path.relative(canonicalRoot, canonicalFile);
      if (canonicalRelativePath.split(path.sep).some((segment) => segment.startsWith("."))) {
        return new Response("Forbidden", { status: 403 });
      }
      const info = await stat(canonicalFile);
      if (!info.isFile()) {
        return options.fallthroughOnNotFound ? undefined : new Response("Not Found", { status: 404 });
      }
      const headers = new Headers(options.headers);
      if (!headers.has("content-type")) {
        headers.set("content-type", contentTypeFor(canonicalFile));
      }
      headers.set("content-length", String(info.size));
      return new Response(request.method === "HEAD" ? null : await readFile(canonicalFile), { status: 200, headers });
    } catch (error) {
      if (options.fallthroughOnNotFound && isFileSystemNotFound(error)) {
        return undefined;
      }
      return new Response("Not Found", { status: 404 });
    }
  };

export const writeNodeResponse = async (webResponse: Response, response: ServerResponse): Promise<void> => {
  response.statusCode = webResponse.status;
  setNodeHeaders(response, webResponse.headers);
  const writable = response as ServerResponse & { write?: (chunk: Buffer) => boolean | void };
  if (!webResponse.body || typeof writable.write !== "function") {
    response.end(await webResponse.text());
    return;
  }
  if (typeof response.flushHeaders === "function") {
    response.flushHeaders();
  }
  const reader = webResponse.body.getReader();
  let responseClosed = false;
  let finished = false;
  let cancelPromise: Promise<void> | undefined;
  const onCloseOrError = (): void => {
    if (finished || response.writableEnded) {
      return;
    }
    responseClosed = true;
    cancelPromise = reader.cancel().catch(() => undefined);
  };
  if (typeof response.once === "function") {
    response.once("close", onCloseOrError);
    response.once("error", onCloseOrError);
  }
  try {
    while (!responseClosed) {
      const result = await reader.read();
      if (responseClosed) {
        return;
      }
      if (result.done) {
        finished = true;
        response.end();
        return;
      }
      if (writable.write(Buffer.from(result.value)) === false && typeof response.once === "function") {
        await new Promise<void>((resolve) => {
          const resume = (): void => {
            response.off?.("drain", resume);
            response.off?.("close", resume);
            response.off?.("error", resume);
            resolve();
          };
          response.once("drain", resume);
          response.once("close", resume);
          response.once("error", resume);
        });
      }
    }
  } finally {
    if (typeof response.off === "function") {
      response.off("close", onCloseOrError);
      response.off("error", onCloseOrError);
    }
    await cancelPromise;
  }
};

const requestBody = (request: IncomingMessage): BodyInit | undefined => {
  if (request.method === "GET" || request.method === "HEAD") {
    return undefined;
  }
  return Readable.toWeb(request) as ReadableStream<Uint8Array>;
};

type RequestUrlOptions = Pick<NodeHandlerOptions, "origin" | "trustedHosts" | "trustProxy">;

const firstHeaderValue = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const normalizeOrigin = (origin: string): string => {
  const candidate = origin.includes("://") ? origin : `https://${origin}`;
  return new URL(candidate).origin;
};

const hostName = (host: string): string => host.toLowerCase().replace(/:\d+$/, "");

const isTrustedHost = (host: string, trustedHosts: readonly string[] | undefined): boolean => {
  if (!trustedHosts || trustedHosts.length === 0) {
    return false;
  }
  const normalized = host.toLowerCase();
  const normalizedName = hostName(normalized);
  return trustedHosts.some((trusted) => {
    const candidate = trusted.toLowerCase();
    return normalized === candidate || normalizedName === candidate;
  });
};

const badRequestResponse = (message: string): Response => new Response(message, { status: 400 });

const requestUrl = (request: IncomingMessage, options: RequestUrlOptions = {}): string | Response => {
  const host = firstHeaderValue(request.headers.host) ?? "localhost";
  const hasTrustedHosts = options.trustedHosts !== undefined && options.trustedHosts.length > 0;
  const trustedHost = isTrustedHost(host, options.trustedHosts) ? host : "localhost";
  if (hasTrustedHosts && trustedHost === "localhost") {
    return badRequestResponse("Untrusted Host header");
  }
  const protocol = options.trustProxy
    ? (firstHeaderValue(request.headers["x-forwarded-proto"]) ?? "http").split(",")[0]?.trim() || "http"
    : "http";
  const origin = options.origin
    ? normalizeOrigin(typeof options.origin === "function" ? options.origin(request) : options.origin)
    : `${protocol}://${trustedHost}`;
  return `${origin}${request.url ?? "/"}`;
};

const requestAbortSignal = (request: IncomingMessage, response?: ServerResponse): AbortSignal => {
  const controller = new AbortController();
  const abort = (): void => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };
  request.once("aborted", abort);
  request.once("close", () => {
    if ((request as IncomingMessage & { aborted?: boolean }).aborted) {
      abort();
    }
  });
  if (typeof response?.once === "function") {
    response.once("close", () => {
      if (!response.writableEnded) {
        abort();
      }
    });
  }
  return controller.signal;
};

const webRequestFor = (
  request: IncomingMessage,
  options: RequestUrlOptions = {},
  response?: ServerResponse,
): Request | Response => {
  const url = requestUrl(request, options);
  if (url instanceof Response) {
    return url;
  }
  const body = requestBody(request);
  const init: RequestInit = {
    method: request.method ?? "GET",
    headers: request.headers as HeadersInit,
    signal: requestAbortSignal(request, response),
    ...(body ? { body, duplex: "half" } : {}),
  } as RequestInit;
  return new Request(url, init);
};

const nodeObservability = (
  observability: AdapterObservabilityHooks | undefined,
): AdapterObservabilityHooks | undefined =>
  observability ? { ...observability, adapter: observability.adapter ?? "node" } : undefined;

export const createNodeHandler =
  (options: NodeHandlerOptions) =>
  async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = requestUrl(request, options);
    if (url instanceof Response) {
      await writeNodeResponse(url, response);
      return;
    }
    const staticRoute = findStaticRoute(options.staticRoutes, request.method ?? "GET", new URL(url));
    if (staticRoute) {
      writeNodeStaticRoute(staticRoute, request, response, options.securityHeaders);
      return;
    }
    const webRequest = webRequestFor(request, options, response);
    if (webRequest instanceof Response) {
      await writeNodeResponse(webRequest, response);
      return;
    }
    if (options.staticAssets) {
      const traversal = staticAssetTraversalResponse(request.url, options.staticAssets);
      if (traversal) {
        await writeNodeResponse(withSecurityHeaders(traversal, options.securityHeaders), response);
        return;
      }
      const asset = await createStaticAssetHandler(options.staticAssets)(webRequest);
      if (asset) {
        await writeNodeResponse(withSecurityHeaders(asset, options.securityHeaders), response);
        return;
      }
    }
    const webResponse = await createWorkersHandler({
      ...options,
      observability: nodeObservability(options.observability),
    }).fetch(webRequest);
    await writeNodeResponse(webResponse, response);
  };

export const createNodeFetchHandler = (
  options: NodeFetchHandlerOptions,
): ((request: IncomingMessage, response: ServerResponse) => Promise<void>) => {
  const staticAssetHandler = options.staticAssets ? createStaticAssetHandler(options.staticAssets) : undefined;
  const fetchHandler = createWorkersFetchHandler({
    ...options,
    observability: nodeObservability(options.observability),
    fetch: async (request) => {
      const asset = await staticAssetHandler?.(request);
      return asset ?? options.fetch(request);
    },
  });
  return async (request, response) => {
    const webRequest = webRequestFor(request, options, response);
    if (webRequest instanceof Response) {
      await writeNodeResponse(webRequest, response);
      return;
    }
    if (options.staticAssets) {
      const traversal = staticAssetTraversalResponse(request.url, options.staticAssets);
      if (traversal) {
        await writeNodeResponse(withSecurityHeaders(traversal, options.securityHeaders), response);
        return;
      }
    }
    const webResponse = await fetchHandler.fetch(webRequest);
    await writeNodeResponse(webResponse, response);
  };
};
