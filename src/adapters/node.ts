import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import {
  createWorkersFetchHandler,
  createWorkersHandler,
  type AdapterFetchHandler,
  type StaticRouteDefinition,
  type WorkersFetchHandlerOptions,
  type WorkersHandlerOptions,
} from "./workers.js";

export type NodeHandlerOptions = WorkersHandlerOptions & {
  staticAssets?: StaticAssetOptions;
};

export type NodeFetchHandlerOptions = Omit<WorkersFetchHandlerOptions, "fetch"> & {
  fetch: AdapterFetchHandler;
  staticAssets?: StaticAssetOptions;
};

export type StaticAssetOptions = {
  rootDir: string;
  basePath?: string;
  headers?: HeadersInit;
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

const writeNodeStaticRoute = (
  route: StaticRouteDefinition,
  request: IncomingMessage,
  response: ServerResponse,
  securityHeaders?: Headers,
): void => {
  response.statusCode = route.status ?? 200;
  headersForStaticRoute(route, securityHeaders).forEach((value, key) => response.setHeader(key, value));
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

export const createStaticAssetHandler =
  (options: StaticAssetOptions): ((request: Request) => Promise<Response | undefined>) =>
  async (request) => {
    const basePath = options.basePath ?? "/";
    const url = new URL(request.url);
    if (basePath !== "/" && url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      return undefined;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    }
    let relativePath: string;
    try {
      relativePath = decodeURIComponent(url.pathname.slice(basePath.length)).replace(/^\/+/, "");
    } catch {
      return new Response("Not Found", { status: 404 });
    }
    if (!relativePath || relativePath.split("/").includes("..")) {
      return new Response("Forbidden", { status: 403 });
    }
    const root = path.resolve(options.rootDir);
    const file = path.resolve(root, relativePath);
    if (!file.startsWith(`${root}${path.sep}`)) {
      return new Response("Forbidden", { status: 403 });
    }
    try {
      const info = await stat(file);
      if (!info.isFile()) {
        return new Response("Not Found", { status: 404 });
      }
      const headers = new Headers(options.headers);
      if (!headers.has("content-type")) {
        headers.set("content-type", contentTypeFor(file));
      }
      headers.set("content-length", String(info.size));
      return new Response(request.method === "HEAD" ? null : await readFile(file), { status: 200, headers });
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  };

export const writeNodeResponse = async (webResponse: Response, response: ServerResponse): Promise<void> => {
  response.statusCode = webResponse.status;
  webResponse.headers.forEach((value, key) => response.setHeader(key, value));
  const writable = response as ServerResponse & { write?: (chunk: Buffer) => void };
  if (!webResponse.body || typeof writable.write !== "function") {
    response.end(await webResponse.text());
    return;
  }
  const reader = webResponse.body.getReader();
  while (true) {
    const result = await reader.read();
    if (result.done) {
      response.end();
      return;
    }
    writable.write(Buffer.from(result.value));
  }
};

const requestBody = (request: IncomingMessage): BodyInit | undefined => {
  if (request.method === "GET" || request.method === "HEAD") {
    return undefined;
  }
  return Readable.toWeb(request) as ReadableStream<Uint8Array>;
};

const requestUrl = (request: IncomingMessage): string => {
  const host = request.headers.host ?? "localhost";
  const protocol = request.headers["x-forwarded-proto"] ?? "http";
  return `${Array.isArray(protocol) ? protocol[0] : protocol}://${host}${request.url ?? "/"}`;
};

const webRequestFor = (request: IncomingMessage): Request => {
  const body = requestBody(request);
  const init: RequestInit = {
    method: request.method ?? "GET",
    headers: request.headers as HeadersInit,
    ...(body ? { body, duplex: "half" } : {}),
  } as RequestInit;
  return new Request(requestUrl(request), init);
};

export const createNodeHandler =
  (options: NodeHandlerOptions) =>
  async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const staticRoute = findStaticRoute(options.staticRoutes, request.method ?? "GET", new URL(requestUrl(request)));
    if (staticRoute) {
      writeNodeStaticRoute(staticRoute, request, response, options.securityHeaders);
      return;
    }
    const webRequest = webRequestFor(request);
    if (options.staticAssets) {
      const asset = await createStaticAssetHandler(options.staticAssets)(webRequest);
      if (asset) {
        await writeNodeResponse(withSecurityHeaders(asset, options.securityHeaders), response);
        return;
      }
    }
    const webResponse = await createWorkersHandler(options).fetch(webRequest);
    await writeNodeResponse(webResponse, response);
  };

export const createNodeFetchHandler = (
  options: NodeFetchHandlerOptions,
): ((request: IncomingMessage, response: ServerResponse) => Promise<void>) => {
  const staticAssetHandler = options.staticAssets ? createStaticAssetHandler(options.staticAssets) : undefined;
  const fetchHandler = createWorkersFetchHandler({
    ...options,
    fetch: async (request) => {
      const asset = await staticAssetHandler?.(request);
      return asset ?? options.fetch(request);
    },
  });
  return async (request, response) => {
    const webRequest = webRequestFor(request);
    const webResponse = await fetchHandler.fetch(webRequest);
    await writeNodeResponse(webResponse, response);
  };
};
