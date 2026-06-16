import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { renderRoute, renderRouteStream, type RouteDefinition, type RouteRenderOptions } from "./router";

export type HandlerOptions = RouteRenderOptions & {
  routes: readonly RouteDefinition[];
  securityHeaders?: Headers;
  streaming?: boolean;
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

export const createStaticAssetHandler =
  (options: StaticAssetOptions): ((request: Request) => Promise<Response | undefined>) =>
  async (request) => {
    const basePath = options.basePath ?? "/";
    const url = new URL(request.url);
    if (basePath !== "/" && url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      return undefined;
    }
    const relativePath = decodeURIComponent(url.pathname.slice(basePath.length)).replace(/^\/+/, "");
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
      return new Response(await readFile(file), { status: 200, headers });
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  };

const responseFor = async (options: HandlerOptions, request: Request): Promise<Response> => {
  if (options.staticAssets) {
    const asset = await createStaticAssetHandler(options.staticAssets)(request);
    if (asset) {
      return asset;
    }
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

export const createWorkersHandler = (options: HandlerOptions): { fetch: (request: Request) => Promise<Response> } => ({
  fetch: (request) => responseFor(options, request),
});

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

export const createNodeHandler =
  (options: HandlerOptions) =>
  async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const body = requestBody(request);
    const init: RequestInit = {
      method: request.method ?? "GET",
      headers: request.headers as HeadersInit,
      ...(body ? { body, duplex: "half" } : {}),
    } as RequestInit;
    const webRequest = new Request(requestUrl(request), init);
    const webResponse = await responseFor(options, webRequest);
    response.statusCode = webResponse.status;
    webResponse.headers.forEach((value, key) => response.setHeader(key, value));
    response.end(await webResponse.text());
  };
