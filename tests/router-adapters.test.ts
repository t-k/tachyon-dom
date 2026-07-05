import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createLambdaFetchHandler,
  createLambdaHandler,
  createLambdaStreamingHandler,
  lambdaResponseFromWebResponse,
  requestFromLambdaEvent,
} from "../src/adapters/lambda";
import { createNodeFetchHandler, createNodeHandler, writeNodeResponse } from "../src/adapters/node";
import { createWorkersFetchHandler, createWorkersHandler } from "../src/adapters/workers";
import { createSecurityHeaders, redirect, type RouteDefinition } from "../src/router";

const lambdaEvent = (overrides: Record<string, unknown> = {}) => ({
  version: "2.0",
  routeKey: "$default",
  rawPath: "/",
  rawQueryString: "",
  headers: { host: "lambda.example" },
  requestContext: {
    domainName: "lambda.example",
    http: {
      method: "GET",
      path: "/",
      protocol: "HTTP/1.1",
      sourceIp: "127.0.0.1",
      userAgent: "vitest",
    },
  },
  isBase64Encoded: false,
  ...overrides,
});

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("server adapters", () => {
  it("emits structured request lifecycle events for Workers routes", async () => {
    const events: Array<Record<string, unknown>> = [];
    const handler = createWorkersHandler({
      routes: [{ id: "user-detail", path: "/users/:id", render: ({ params }) => `<h1>${params.id}</h1>` }],
      observability: {
        onRequestStart: (event) => {
          events.push({ type: event.type, method: event.method, path: event.path });
        },
        onRouteMatched: (event) => {
          events.push({
            type: event.type,
            routeId: event.routeId,
            routePattern: event.routePattern,
            path: event.path,
          });
        },
        onResponse: (event) => {
          events.push({
            type: event.type,
            status: event.status,
            routeId: event.routeId,
            routePattern: event.routePattern,
            failedBeforeRouteDispatch: event.failedBeforeRouteDispatch,
            durationIsNumber: typeof event.durationMs === "number",
          });
        },
      },
    });

    const response = await handler.fetch(new Request("https://example.com/users/42"));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<h1>42</h1>");
    expect(events).toEqual([
      { type: "request_start", method: "GET", path: "/users/42" },
      { type: "route_matched", routeId: "user-detail", routePattern: "/users/:id", path: "/users/42" },
      {
        type: "response",
        status: 200,
        routeId: "user-detail",
        routePattern: "/users/:id",
        failedBeforeRouteDispatch: false,
        durationIsNumber: true,
      },
    ]);
  });

  it("emits response events for Workers fetch handlers without route definitions", async () => {
    const responses: Array<Record<string, unknown>> = [];
    const handler = createWorkersFetchHandler({
      fetch: () => new Response("ok", { status: 202 }),
      observability: {
        onResponse: (event) => {
          responses.push({
            type: event.type,
            status: event.status,
            path: event.path,
            routeId: event.routeId,
            failedBeforeRouteDispatch: event.failedBeforeRouteDispatch,
          });
        },
      },
    });

    const response = await handler.fetch(new Request("https://example.com/jobs"));

    expect(response.status).toBe(202);
    expect(responses).toEqual([
      {
        type: "response",
        status: 202,
        path: "/jobs",
        routeId: undefined,
        failedBeforeRouteDispatch: false,
      },
    ]);
  });

  it("marks unmatched Workers requests as failed before route dispatch", async () => {
    const responses: Array<Record<string, unknown>> = [];
    const handler = createWorkersHandler({
      routes: [{ path: "/", render: () => "<h1>Home</h1>" }],
      observability: {
        onResponse: (event) => {
          responses.push({
            status: event.status,
            routeId: event.routeId,
            failedBeforeRouteDispatch: event.failedBeforeRouteDispatch,
          });
        },
      },
    });

    const response = await handler.fetch(new Request("https://example.com/missing"));

    expect(response.status).toBe(404);
    expect(responses).toEqual([{ status: 404, routeId: undefined, failedBeforeRouteDispatch: true }]);
  });

  it("labels Node handler observability events with the Node adapter", async () => {
    const responses: Array<Record<string, unknown>> = [];
    const routes: RouteDefinition[] = [{ id: "node-home", path: "/", render: () => "<h1>Node</h1>" }];
    const req = Readable.from([]) as unknown as NodeJS.ReadableStream & {
      method: string;
      url: string;
      headers: Record<string, string>;
    };
    req.method = "GET";
    req.url = "/";
    req.headers = { host: "example.com" };
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn(),
    };

    await createNodeHandler({
      routes,
      observability: {
        onResponse: (event) => {
          responses.push({
            adapter: event.adapter,
            status: event.status,
            routeId: event.routeId,
          });
        },
      },
    })(req as never, res as never);

    expect(responses).toEqual([{ adapter: "node", status: 200, routeId: "node-home" }]);
  });

  it("adds Lambda invocation metadata to observability events when context is provided", async () => {
    const responses: Array<Record<string, unknown>> = [];
    const handler = createLambdaHandler({
      routes: [{ id: "lambda-home", path: "/", render: () => "<h1>Lambda</h1>" }],
      observability: {
        onResponse: (event) => {
          responses.push({
            adapter: event.adapter,
            runtime: event.runtime,
            status: event.status,
            routeId: event.routeId,
            awsRequestId: event.metadata?.awsRequestId,
            functionName: event.metadata?.functionName,
          });
        },
      },
    });

    const response = await handler(lambdaEvent(), {
      awsRequestId: "aws-request-1",
      functionName: "tachyon-admin",
    });

    expect(response.statusCode).toBe(200);
    expect(responses).toEqual([
      {
        adapter: "lambda",
        runtime: "aws-lambda",
        status: 200,
        routeId: "lambda-home",
        awsRequestId: "aws-request-1",
        functionName: "tachyon-admin",
      },
    ]);
  });

  it("creates a Workers fetch handler with security headers", async () => {
    const routes: RouteDefinition[] = [{ path: "/", render: () => "<h1>Home</h1>" }];
    const handler = createWorkersHandler({
      routes,
      securityHeaders: createSecurityHeaders({ csp: true, nonce: "abc" }),
    });

    const response = await handler.fetch(new Request("https://example.com/"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("'nonce-abc'");
    expect(await response.text()).toBe("<h1>Home</h1>");
  });

  it("creates a Node handler that writes status, headers, and body", async () => {
    const routes: RouteDefinition[] = [{ path: "/", render: () => "<h1>Home</h1>" }];
    const req = Readable.from([]) as unknown as NodeJS.ReadableStream & {
      method: string;
      url: string;
      headers: Record<string, string>;
    };
    req.method = "GET";
    req.url = "/";
    req.headers = { host: "example.com" };
    const chunks: string[] = [];
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn((chunk?: string) => {
        if (chunk) {
          chunks.push(chunk);
        }
      }),
    };

    await createNodeHandler({ routes })(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.setHeader).toHaveBeenCalledWith("content-type", "text/html; charset=utf-8");
    expect(chunks.join("")).toBe("<h1>Home</h1>");
  });

  it("aborts the Node fetch request signal when the client connection closes", async () => {
    const req = new Readable({ read() {} }) as Readable & {
      method: string;
      url: string;
      headers: Record<string, string>;
    };
    req.method = "GET";
    req.url = "/events";
    req.headers = { host: "example.com" };
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn(),
    };
    let signal: AbortSignal | undefined;

    await createNodeFetchHandler({
      fetch: async (request) => {
        signal = request.signal;
        (req as typeof req & { aborted?: boolean }).aborted = true;
        req.emit("close");
        await delay(0);
        return new Response("ok");
      },
    })(req as never, res as never);

    expect(signal?.aborted).toBe(true);
  });

  it("cancels a streamed Node response body when the client connection closes", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(nextController) {
        controller = nextController;
        nextController.enqueue(new TextEncoder().encode("event: ready\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const res = new EventEmitter() as EventEmitter & {
      statusCode: number;
      setHeader: ReturnType<typeof vi.fn>;
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };
    res.statusCode = 200;
    res.setHeader = vi.fn();
    res.end = vi.fn();
    res.write = vi.fn(() => {
      queueMicrotask(() => res.emit("close"));
      return true;
    });
    const writer = writeNodeResponse(new Response(body), res as never);

    try {
      const outcome = await Promise.race([writer.then(() => "done"), delay(20).then(() => "timeout")]);
      expect(outcome).toBe("done");
      expect(cancelled).toBe(true);
      expect(res.end).not.toHaveBeenCalled();
    } finally {
      try {
        controller?.close();
      } catch {
        // Already cancelled by the implementation under test.
      }
      await writer.catch(() => undefined);
    }
  });

  it("preserves multiple Set-Cookie headers in Node fetch responses", async () => {
    const req = Readable.from([]) as unknown as NodeJS.ReadableStream & {
      method: string;
      url: string;
      headers: Record<string, string>;
    };
    req.method = "GET";
    req.url = "/";
    req.headers = { host: "example.com" };
    const headers = new Headers({ "content-type": "text/plain; charset=utf-8" });
    headers.append("set-cookie", "sid=abc; Path=/; HttpOnly");
    headers.append("set-cookie", "theme=dark; Path=/");
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn(),
    };

    await createNodeFetchHandler({
      fetch: () => new Response("ok", { headers }),
    })(req as never, res as never);

    expect(res.setHeader).toHaveBeenCalledWith("set-cookie", ["sid=abc; Path=/; HttpOnly", "theme=dark; Path=/"]);
    expect(res.setHeader).toHaveBeenCalledWith("content-type", "text/plain; charset=utf-8");
  });

  it("rejects untrusted Node Host headers and gates forwarded proto trust", async () => {
    const seenUrls: string[] = [];
    const req = Readable.from([]) as unknown as NodeJS.ReadableStream & {
      method: string;
      url: string;
      headers: Record<string, string>;
    };
    req.method = "GET";
    req.url = "/account";
    req.headers = { host: "evil.example", "x-forwarded-proto": "https" };
    const rejected = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn(),
    };

    await createNodeFetchHandler({
      trustedHosts: ["app.example"],
      fetch: (request) => {
        seenUrls.push(request.url);
        return new Response("ok");
      },
    })(req as never, rejected as never);

    expect(rejected.statusCode).toBe(400);
    expect(seenUrls).toEqual([]);

    req.headers = { host: "app.example", "x-forwarded-proto": "https" };
    const accepted = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn(),
    };

    await createNodeFetchHandler({
      trustedHosts: ["app.example"],
      fetch: (request) => {
        seenUrls.push(request.url);
        return new Response("ok");
      },
    })(req as never, accepted as never);

    expect(seenUrls.at(-1)).toBe("http://app.example/account");

    await createNodeFetchHandler({
      trustProxy: true,
      trustedHosts: ["app.example"],
      fetch: (request) => {
        seenUrls.push(request.url);
        return new Response("ok");
      },
    })(req as never, accepted as never);

    expect(seenUrls.at(-1)).toBe("https://app.example/account");
  });

  it("rejects untrusted Lambda fallback Host headers", () => {
    expect(() =>
      requestFromLambdaEvent(
        lambdaEvent({
          headers: { host: "evil.example" },
          requestContext: { http: { method: "GET", path: "/" } },
        }),
        { trustedHosts: ["app.example"] },
      ),
    ).toThrow("Untrusted Host header");

    const request = requestFromLambdaEvent(
      lambdaEvent({
        headers: { host: "app.example" },
        requestContext: { http: { method: "GET", path: "/" } },
      }),
      { trustedHosts: ["app.example"] },
    );
    expect(request.url).toBe("https://app.example/");
  });

  it("preserves Set-Cookie arrays for Node static routes and assets", async () => {
    const req = Readable.from([]) as unknown as NodeJS.ReadableStream & {
      method: string;
      url: string;
      headers: Record<string, string>;
    };
    req.method = "GET";
    req.url = "/";
    req.headers = { host: "example.com" };
    const routeRes = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn(),
    };

    await createNodeHandler({
      routes: [{ path: "/", render: () => "<h1>Dynamic</h1>" }],
      staticRoutes: [
        {
          path: "/",
          body: "<h1>Static</h1>",
          headers: [
            ["set-cookie", "a=1; Path=/"],
            ["set-cookie", "b=2; Path=/"],
          ],
        },
      ],
    })(req as never, routeRes as never);

    expect(routeRes.setHeader).toHaveBeenCalledWith("set-cookie", ["a=1; Path=/", "b=2; Path=/"]);

    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-node-assets-"));
    try {
      await writeFile(path.join(dir, "app.txt"), "asset");
      req.url = "/app.txt";
      const assetRes = {
        statusCode: 200,
        setHeader: vi.fn(),
        end: vi.fn(),
      };
      await createNodeFetchHandler({
        staticAssets: {
          rootDir: dir,
          headers: [
            ["set-cookie", "asset=1; Path=/"],
            ["set-cookie", "asset2=1; Path=/"],
          ],
        },
        fetch: () => new Response("dynamic"),
      })(req as never, assetRes as never);

      expect(assetRes.setHeader).toHaveBeenCalledWith("set-cookie", ["asset=1; Path=/", "asset2=1; Path=/"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serves static Node routes before the dynamic router", async () => {
    const render = vi.fn(() => "<h1>Dynamic</h1>");
    const routes: RouteDefinition[] = [{ path: "/", render }];
    const req = Readable.from([]) as unknown as NodeJS.ReadableStream & {
      method: string;
      url: string;
      headers: Record<string, string>;
    };
    req.method = "GET";
    req.url = "/";
    req.headers = { host: "example.com" };
    const chunks: string[] = [];
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn((chunk?: string) => {
        if (chunk) {
          chunks.push(chunk);
        }
      }),
    };

    await createNodeHandler({ routes, staticRoutes: [{ path: "/", body: "<h1>Static</h1>" }] })(
      req as never,
      res as never,
    );

    expect(render).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.setHeader).toHaveBeenCalledWith("content-type", "text/html; charset=utf-8");
    expect(res.setHeader).toHaveBeenCalledWith("content-length", "15");
    expect(chunks.join("")).toBe("<h1>Static</h1>");
  });

  it("serves static Workers routes before the dynamic router", async () => {
    const render = vi.fn(() => "<h1>Dynamic</h1>");
    const handler = createWorkersHandler({
      routes: [{ path: "/", render }],
      staticRoutes: [{ path: "/", body: "<h1>Static</h1>" }],
    });

    const response = await handler.fetch(new Request("https://example.com/"));

    expect(render).not.toHaveBeenCalled();
    expect(response.headers.get("content-length")).toBe("15");
    expect(await response.text()).toBe("<h1>Static</h1>");
  });

  it("preserves streaming redirects through Workers responses", async () => {
    const handler = createWorkersHandler({
      routes: [
        {
          path: "/private",
          fallback: "<p>Loading</p>",
          loader: () => redirect("/login"),
          render: () => "<h1>Private</h1>",
        },
      ],
      streaming: true,
    });

    const response = await handler.fetch(new Request("https://example.com/private"));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login");
    expect(await response.text()).toBe("");
  });

  it("serves Cloudflare assets from env binding with security headers", async () => {
    const assetFetch = vi.fn((request: Request) => {
      expect(new URL(request.url).pathname).toBe("/assets/app.js");
      return new Response(`console.log("asset");`, {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      });
    });
    const render = vi.fn(() => "<h1>Dynamic</h1>");
    const handler = createWorkersHandler<{ ASSETS: { fetch: typeof assetFetch } }>({
      routes: [{ path: "/", render }],
      assets: { bindingName: "ASSETS", basePath: "/assets" },
      securityHeaders: createSecurityHeaders({ csp: true, nonce: "asset-nonce" }),
    });

    const response = await handler.fetch(new Request("https://example.com/assets/app.js"), {
      ASSETS: { fetch: assetFetch },
    });

    expect(assetFetch).toHaveBeenCalledOnce();
    expect(render).not.toHaveBeenCalled();
    expect(response.headers.get("content-security-policy")).toContain("'nonce-asset-nonce'");
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await response.text()).toBe(`console.log("asset");`);
  });

  it("falls through to dynamic routes when Cloudflare asset basePath does not match", async () => {
    const assetFetch = vi.fn(() => new Response("asset"));
    const handler = createWorkersHandler<{ ASSETS: { fetch: typeof assetFetch } }>({
      routes: [{ path: "/", render: () => "<h1>Home</h1>" }],
      assets: { bindingName: "ASSETS", basePath: "/assets" },
    });

    const response = await handler.fetch(new Request("https://example.com/"), {
      ASSETS: { fetch: assetFetch },
    });

    expect(assetFetch).not.toHaveBeenCalled();
    expect(await response.text()).toBe("<h1>Home</h1>");
  });

  it("applies security headers to rejected Cloudflare asset methods", async () => {
    const assetFetch = vi.fn(() => new Response("asset"));
    const handler = createWorkersHandler<{ ASSETS: { fetch: typeof assetFetch } }>({
      routes: [{ path: "/", render: () => "<h1>Home</h1>" }],
      assets: { bindingName: "ASSETS", basePath: "/assets" },
      securityHeaders: createSecurityHeaders({ csp: true, nonce: "asset-nonce" }),
    });

    const response = await handler.fetch(new Request("https://example.com/assets/app.js", { method: "POST" }), {
      ASSETS: { fetch: assetFetch },
    });

    expect(assetFetch).not.toHaveBeenCalled();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(response.headers.get("content-security-policy")).toContain("'nonce-asset-nonce'");
  });

  it("applies method guards and security headers to static assets", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-adapter-assets-"));
    try {
      await writeFile(path.join(dir, "app.js"), `console.log("ok");`);
      const handler = createWorkersHandler({
        routes: [{ path: "/", render: () => "<h1>Home</h1>" }],
        assets: { binding: { fetch: () => new Response("unused") }, basePath: "/unmatched" },
        securityHeaders: createSecurityHeaders({ csp: true, nonce: "asset-nonce" }),
      });

      const getResponse = await handler.fetch(new Request("https://example.com/assets/app.js"));
      expect(getResponse.status).toBe(404);

      const makeRequest = (method: string) => {
        const req = Readable.from([]) as unknown as NodeJS.ReadableStream & {
          method: string;
          url: string;
          headers: Record<string, string>;
        };
        req.method = method;
        req.url = "/assets/app.js";
        req.headers = { host: "example.com" };
        return req;
      };
      const nodeHandler = createNodeHandler({
        routes: [{ path: "/", render: () => "<h1>Home</h1>" }],
        staticAssets: { rootDir: dir, basePath: "/assets" },
        securityHeaders: createSecurityHeaders({ csp: true, nonce: "asset-nonce" }),
      });
      const getChunks: string[] = [];
      const getHeaders = new Map<string, string | number | readonly string[]>();
      const getRes = {
        statusCode: 200,
        setHeader: vi.fn((key: string, value: string | number | readonly string[]) => {
          getHeaders.set(key, value);
        }),
        end: vi.fn((chunk?: string) => {
          if (chunk) {
            getChunks.push(chunk);
          }
        }),
      };

      await nodeHandler(makeRequest("GET") as never, getRes as never);

      expect(getRes.statusCode).toBe(200);
      expect(getHeaders.get("content-security-policy")).toContain("'nonce-asset-nonce'");
      expect(getChunks.join("")).toBe(`console.log("ok");`);

      const postHeaders = new Map<string, string | number | readonly string[]>();
      const postRes = {
        statusCode: 200,
        setHeader: vi.fn((key: string, value: string | number | readonly string[]) => {
          postHeaders.set(key, value);
        }),
        end: vi.fn(),
      };

      await nodeHandler(makeRequest("POST") as never, postRes as never);

      expect(postRes.statusCode).toBe(405);
      expect(postHeaders.get("allow")).toBe("GET, HEAD");
      expect(postHeaders.get("content-security-policy")).toContain("'nonce-asset-nonce'");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns not found for malformed static asset percent encoding", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-adapter-assets-"));
    try {
      const req = Readable.from([]) as unknown as NodeJS.ReadableStream & {
        method: string;
        url: string;
        headers: Record<string, string>;
      };
      req.method = "GET";
      req.url = "/assets/%E0%A4%A";
      req.headers = { host: "example.com" };
      const chunks: string[] = [];
      const headers = new Map<string, string | number | readonly string[]>();
      const res = {
        statusCode: 200,
        setHeader: vi.fn((key: string, value: string | number | readonly string[]) => {
          headers.set(key, value);
        }),
        end: vi.fn((chunk?: string) => {
          if (chunk) {
            chunks.push(chunk);
          }
        }),
      };

      await createNodeHandler({
        routes: [{ path: "/", render: () => "<h1>Home</h1>" }],
        staticAssets: { rootDir: dir, basePath: "/assets" },
        securityHeaders: createSecurityHeaders({ csp: true, nonce: "asset-nonce" }),
      })(req as never, res as never);

      expect(res.statusCode).toBe(404);
      expect(headers.get("content-security-policy")).toContain("'nonce-asset-nonce'");
      expect(chunks.join("")).toBe("Not Found");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("pipes Node streaming responses without buffering through end text", async () => {
    const routes: RouteDefinition[] = [
      { path: "/", fallback: "<p>Loading</p>", loader: async () => "Ready", render: ({ data }) => `<h1>${data}</h1>` },
    ];
    const req = Readable.from([]) as unknown as NodeJS.ReadableStream & {
      method: string;
      url: string;
      headers: Record<string, string>;
    };
    req.method = "GET";
    req.url = "/";
    req.headers = { host: "example.com" };
    const chunks: string[] = [];
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      write: vi.fn((chunk: Buffer | string) => {
        chunks.push(String(chunk));
      }),
      end: vi.fn(),
      once: vi.fn((event: string, callback: () => void) => {
        if (event === "finish") {
          callback();
        }
      }),
      emit: vi.fn(),
    };

    await createNodeHandler({ routes, streaming: true })(req as never, res as never);

    expect(res.write).toHaveBeenCalled();
    expect(res.end).toHaveBeenCalledWith();
    expect(chunks.join("")).toBe("<p>Loading</p><h1>Ready</h1>");
  });

  it("creates a Node fetch handler that serves static assets before a standards fetch handler", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-fetch-assets-"));
    try {
      await writeFile(path.join(dir, "app.js"), `console.log("asset");`);
      let fetchCalls = 0;
      const handler = createNodeFetchHandler({
        fetch: async (request) => {
          fetchCalls += 1;
          return new Response(`<h1>${new URL(request.url).pathname}</h1>`, {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        },
        staticAssets: { rootDir: dir, basePath: "/assets" },
        securityHeaders: createSecurityHeaders({ csp: true, nonce: "fetch-nonce" }),
      });
      const makeRequest = (url: string) => {
        const req = Readable.from([]) as unknown as NodeJS.ReadableStream & {
          method: string;
          url: string;
          headers: Record<string, string>;
        };
        req.method = "GET";
        req.url = url;
        req.headers = { host: "example.com" };
        return req;
      };
      const writeResponse = async (url: string) => {
        const chunks: string[] = [];
        const headers = new Map<string, string | number | readonly string[]>();
        const res = {
          statusCode: 200,
          setHeader: (key: string, value: string | number | readonly string[]) => {
            headers.set(key, value);
          },
          end: (chunk?: string) => {
            if (chunk) {
              chunks.push(chunk);
            }
          },
        };
        await handler(makeRequest(url) as never, res as never);
        return { chunks, headers, res };
      };

      const asset = await writeResponse("/assets/app.js");
      const app = await writeResponse("/dashboard");

      expect(fetchCalls).toBe(1);
      expect(asset.res.statusCode).toBe(200);
      expect(asset.headers.get("content-security-policy")).toContain("'nonce-fetch-nonce'");
      expect(asset.chunks.join("")).toBe(`console.log("asset");`);
      expect(app.res.statusCode).toBe(200);
      expect(app.headers.get("content-security-policy")).toContain("'nonce-fetch-nonce'");
      expect(app.chunks.join("")).toBe("<h1>/dashboard</h1>");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls through to a Node fetch handler when root static assets are not found", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-fetch-assets-"));
    try {
      await writeFile(path.join(dir, "app.js"), `console.log("asset");`);
      let fetchCalls = 0;
      const handler = createNodeFetchHandler({
        fetch: async (request) => {
          fetchCalls += 1;
          return new Response(`<h1>${new URL(request.url).pathname}</h1>`, {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        },
        staticAssets: { rootDir: dir, basePath: "/", fallthroughOnNotFound: true },
      });
      const makeRequest = (url: string, method = "GET") => {
        const req = Readable.from([]) as unknown as NodeJS.ReadableStream & {
          method: string;
          url: string;
          headers: Record<string, string>;
        };
        req.method = method;
        req.url = url;
        req.headers = { host: "example.com" };
        return req;
      };
      const writeResponse = async (url: string, method = "GET") => {
        const chunks: string[] = [];
        const res = {
          statusCode: 200,
          setHeader: vi.fn(),
          end: vi.fn((chunk?: string) => {
            if (chunk) {
              chunks.push(chunk);
            }
          }),
        };
        await handler(makeRequest(url, method) as never, res as never);
        return { chunks, res };
      };

      const healthz = await writeResponse("/healthz");
      const home = await writeResponse("/");
      const asset = await writeResponse("/app.js");
      const login = await writeResponse("/login", "POST");

      expect(fetchCalls).toBe(3);
      expect(healthz.res.statusCode).toBe(200);
      expect(healthz.chunks.join("")).toBe("<h1>/healthz</h1>");
      expect(home.res.statusCode).toBe(200);
      expect(home.chunks.join("")).toBe("<h1>/</h1>");
      expect(asset.res.statusCode).toBe(200);
      expect(asset.chunks.join("")).toBe(`console.log("asset");`);
      expect(login.res.statusCode).toBe(200);
      expect(login.chunks.join("")).toBe("<h1>/login</h1>");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serves static Node routes before a standards fetch handler", async () => {
    let fetchCalls = 0;
    const handler = createNodeFetchHandler({
      fetch: () => {
        fetchCalls += 1;
        return new Response("<h1>Dynamic</h1>");
      },
      staticRoutes: [{ path: "/", body: "<h1>Static</h1>" }],
      securityHeaders: createSecurityHeaders({ csp: true, nonce: "static-fetch-nonce" }),
    });
    const req = Readable.from([]) as unknown as NodeJS.ReadableStream & {
      method: string;
      url: string;
      headers: Record<string, string>;
    };
    req.method = "GET";
    req.url = "/";
    req.headers = { host: "example.com" };
    const chunks: string[] = [];
    const headers = new Map<string, string | number | readonly string[]>();
    const res = {
      statusCode: 200,
      setHeader: (key: string, value: string | number | readonly string[]) => {
        headers.set(key, value);
      },
      end: (chunk?: string) => {
        if (chunk) {
          chunks.push(chunk);
        }
      },
    };

    await handler(req as never, res as never);

    expect(fetchCalls).toBe(0);
    expect(res.statusCode).toBe(200);
    expect(headers.get("content-security-policy")).toContain("'nonce-static-fetch-nonce'");
    expect(headers.get("content-length")).toBe("15");
    expect(chunks.join("")).toBe("<h1>Static</h1>");
  });

  it("converts Lambda HTTP API v2 events into Web requests", async () => {
    const request = requestFromLambdaEvent(
      lambdaEvent({
        rawPath: "/submit",
        rawQueryString: "debug=1",
        cookies: ["session=abc", "theme=dark"],
        headers: { "content-type": "text/plain", host: "client.example" },
        requestContext: {
          domainName: "public.example",
          http: {
            method: "POST",
            path: "/submit",
            protocol: "HTTP/1.1",
            sourceIp: "127.0.0.1",
            userAgent: "vitest",
          },
        },
        body: "hello",
      }),
    );

    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://public.example/submit?debug=1");
    expect(request.headers.get("cookie")).toBe("session=abc; theme=dark");
    expect(request.headers.get("content-type")).toBe("text/plain");
    expect(await request.text()).toBe("hello");
  });

  it("creates a Lambda handler that returns buffered SSR responses with security headers", async () => {
    const handler = createLambdaHandler({
      routes: [{ path: "/", render: () => "<h1>Lambda</h1>" }],
      securityHeaders: createSecurityHeaders({ csp: true, nonce: "lambda-nonce" }),
    });

    const response = await handler(lambdaEvent());

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(response.headers["content-security-policy"]).toContain("'nonce-lambda-nonce'");
    expect(response.isBase64Encoded).toBe(false);
    expect(response.body).toBe("<h1>Lambda</h1>");
  });

  it("creates a Lambda fetch handler that adapts HTTP API events without route definitions", async () => {
    let seenRequest: Request | undefined;
    const handler = createLambdaFetchHandler({
      origin: "admin.example",
      fetch: async (request) => {
        seenRequest = request;
        return new Response(`<h1>${new URL(request.url).pathname}</h1>`, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
      securityHeaders: createSecurityHeaders({ csp: true, nonce: "lambda-fetch-nonce" }),
    });

    const response = await handler(
      lambdaEvent({
        rawPath: "/admin",
        rawQueryString: "debug=1",
      }),
    );

    expect(seenRequest?.url).toBe("https://admin.example/admin?debug=1");
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-security-policy"]).toContain("'nonce-lambda-fetch-nonce'");
    expect(response.body).toBe("<h1>/admin</h1>");
  });

  it("maps Set-Cookie headers to Lambda cookies and base64 encodes binary responses", async () => {
    const cookieResponse = await lambdaResponseFromWebResponse(
      new Response("ok", {
        status: 201,
        headers: [
          ["content-type", "text/plain; charset=utf-8"],
          ["set-cookie", "sid=abc; Path=/; HttpOnly"],
          ["x-test", "yes"],
        ],
      }),
    );

    expect(cookieResponse.statusCode).toBe(201);
    expect(cookieResponse.headers["x-test"]).toBe("yes");
    expect(cookieResponse.headers["set-cookie"]).toBeUndefined();
    expect(cookieResponse.cookies).toEqual(["sid=abc; Path=/; HttpOnly"]);
    expect(cookieResponse.body).toBe("ok");
    expect(cookieResponse.isBase64Encoded).toBe(false);

    const bytes = Uint8Array.from([0, 255, 1]);
    const binaryResponse = await lambdaResponseFromWebResponse(
      new Response(bytes, { headers: { "content-type": "application/octet-stream" } }),
    );

    expect(binaryResponse.isBase64Encoded).toBe(true);
    expect(binaryResponse.body).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("base64 encodes Lambda responses that already have content encoding", async () => {
    const bytes = Uint8Array.from([31, 139, 8, 0]);
    const response = await lambdaResponseFromWebResponse(
      new Response(bytes, {
        headers: {
          "content-encoding": "gzip",
          "content-type": "text/html; charset=utf-8",
        },
      }),
    );

    expect(response.isBase64Encoded).toBe(true);
    expect(response.body).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("streams Lambda responses through awslambda metadata and chunk writes", async () => {
    const chunks: string[] = [];
    const from = vi.fn((stream: { write: (chunk: string | Uint8Array) => void; end: () => void }) => stream);
    const runtime = {
      streamifyResponse: vi.fn((handler) => handler),
      HttpResponseStream: { from },
    };
    const stream = {
      write: vi.fn((chunk: string | Uint8Array) => {
        chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      }),
      end: vi.fn(),
    };
    const handler = createLambdaStreamingHandler(
      {
        routes: [
          {
            path: "/",
            fallback: "<p>Loading</p>",
            loader: async () => "Ready",
            render: ({ data }) => `<h1>${data}</h1>`,
          },
        ],
        streaming: true,
        securityHeaders: createSecurityHeaders({ csp: true, nonce: "stream-nonce" }),
      },
      runtime,
    ) as (event: ReturnType<typeof lambdaEvent>, responseStream: typeof stream, context: unknown) => Promise<void>;

    await handler(lambdaEvent(), stream, {});

    expect(runtime.streamifyResponse).toHaveBeenCalledOnce();
    expect(from).toHaveBeenCalledWith(
      stream,
      expect.objectContaining({
        statusCode: 200,
        headers: expect.objectContaining({
          "content-security-policy": expect.stringContaining("'nonce-stream-nonce'"),
          "content-type": "text/html; charset=utf-8",
        }),
      }),
    );
    expect(chunks.join("")).toBe("<p>Loading</p><h1>Ready</h1>");
    expect(stream.end).toHaveBeenCalledOnce();
  });

  it("keeps the Workers entry and router runtime free of top-level Node imports", async () => {
    const workersSource = await readFile(path.join(process.cwd(), "src", "adapters", "workers.ts"), "utf8");
    const routerSource = await readFile(path.join(process.cwd(), "src", "router.ts"), "utf8");
    const topLevelNodeImport = /^import\s+(?:type\s+)?[\s\S]*?\s+from\s+["']node:/m;

    expect(workersSource).not.toMatch(topLevelNodeImport);
    expect(routerSource).not.toMatch(topLevelNodeImport);
    expect(routerSource).not.toContain("node:");
  });
});
