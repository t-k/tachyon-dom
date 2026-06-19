import { Readable } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createNodeHandler, createWorkersHandler } from "../src/adapters";
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

  it("applies method guards and security headers to static assets", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-adapter-assets-"));
    try {
      await writeFile(path.join(dir, "app.js"), `console.log("ok");`);
      const handler = createWorkersHandler({
        routes: [{ path: "/", render: () => "<h1>Home</h1>" }],
        staticAssets: { rootDir: dir, basePath: "/assets" },
        securityHeaders: createSecurityHeaders({ csp: true, nonce: "asset-nonce" }),
      });

      const getResponse = await handler.fetch(new Request("https://example.com/assets/app.js"));
      expect(getResponse.status).toBe(200);
      expect(getResponse.headers.get("content-security-policy")).toContain("'nonce-asset-nonce'");
      expect(await getResponse.text()).toBe(`console.log("ok");`);

      const postResponse = await handler.fetch(new Request("https://example.com/assets/app.js", { method: "POST" }));
      expect(postResponse.status).toBe(405);
      expect(postResponse.headers.get("allow")).toBe("GET, HEAD");
      expect(postResponse.headers.get("content-security-policy")).toContain("'nonce-asset-nonce'");
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
});
