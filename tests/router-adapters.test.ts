import { Readable } from "node:stream";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createNodeHandler } from "../src/adapters/node";
import { createWorkersHandler } from "../src/adapters/workers";
import { createSecurityHeaders, redirect, type RouteDefinition } from "../src/router";

describe("server adapters", () => {
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

  it("keeps the Workers entry and router runtime free of top-level Node imports", async () => {
    const workersSource = await readFile(path.join(process.cwd(), "src", "adapters", "workers.ts"), "utf8");
    const routerSource = await readFile(path.join(process.cwd(), "src", "router.ts"), "utf8");
    const topLevelNodeImport = /^import\s+(?:type\s+)?[\s\S]*?\s+from\s+["']node:/m;

    expect(workersSource).not.toMatch(topLevelNodeImport);
    expect(routerSource).not.toMatch(topLevelNodeImport);
  });
});
