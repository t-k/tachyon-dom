import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  applySecurityHeaders,
  collectRouteResources,
  createFileRouteManifest,
  createSecurityHeaders,
  defineRouteModule,
  html,
  json,
  redirect,
  renderResourceHints,
  renderRoute,
  renderRouteStream,
  routeFromModule,
  scanFileRoutes,
  type ParamsForPath,
  type RouteDefinition,
} from "../src/router";
import { renderRouteForTest } from "../src/testing";

describe("advanced router features", () => {
  it("creates file-based route manifests from route files", async () => {
    const files = [
      "/app/src/routes/index.tachyon.html",
      "/app/src/routes/about.tachyon.html",
      "/app/src/routes/users/[id].tachyon.html",
      "/app/src/routes/blog/[...slug].tachyon.html",
      "/app/src/routes/admin/route.ts",
      "/app/src/routes/admin/layout.ts",
    ];

    expect(createFileRouteManifest(files, { rootDir: "/app/src/routes" })).toEqual([
      { id: "index", path: "/", file: "/app/src/routes/index.tachyon.html", kind: "template" },
      { id: "about", path: "/about", file: "/app/src/routes/about.tachyon.html", kind: "template" },
      { id: "users-id", path: "/users/:id", file: "/app/src/routes/users/[id].tachyon.html", kind: "template" },
      { id: "blog-slug", path: "/blog/*slug", file: "/app/src/routes/blog/[...slug].tachyon.html", kind: "template" },
      { id: "admin-route", path: "/admin", file: "/app/src/routes/admin/route.ts", kind: "module" },
      { id: "admin-layout", path: "/admin", file: "/app/src/routes/admin/layout.ts", kind: "layout" },
    ]);

    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-routes-"));
    try {
      await mkdir(path.join(dir, "users"), { recursive: true });
      await writeFile(path.join(dir, "index.tachyon.html"), `<main>Home</main>`);
      await writeFile(path.join(dir, "users", "[id].tachyon.html"), `<main>User</main>`);
      expect((await scanFileRoutes(dir)).map((route) => route.path)).toEqual(["/", "/users/:id"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("adapts route module conventions into route definitions", async () => {
    const module = defineRouteModule({
      path: "/users/:id",
      loader: ({ params }) => ({ name: `User ${params.id}` }),
      head: ({ data }) => ({ title: (data as { name: string }).name }),
      template: ({ data }) => `<h1>${(data as { name: string }).name}</h1>`,
      ErrorBoundary: ({ error }) => `<h1>${error instanceof Error ? error.message : "error"}</h1>`,
      NotFound: ({ url }) => `<h1>Missing ${url.pathname}</h1>`,
    });
    const route = routeFromModule("user", module);
    const result = await renderRoute([route], "https://example.com/users/1");

    expect(result.ok && result.value.html).toBe(`<h1>User 1</h1>`);
    expect(
      route.error?.({
        error: new Error("boom"),
        request: new Request("https://example.com/users/1"),
        url: new URL("https://example.com/users/1"),
      }),
    ).toBe(`<h1>boom</h1>`);
  });

  it("collects preload resources from matched route branches", async () => {
    const routes: RouteDefinition[] = [
      {
        id: "app",
        path: "/app",
        resources: [{ href: "/app.css", rel: "stylesheet" }],
        render: ({ outlet }) => `<main>${outlet}</main>`,
        children: [
          {
            id: "user",
            path: "users/:id",
            resources: [
              { href: "/user.js", rel: "modulepreload" },
              { href: "/avatar.jpg", rel: "preload", as: "image", fetchpriority: "high" },
            ],
            render: () => `<h1>User</h1>`,
          },
        ],
      },
    ];
    const result = await renderRoute(routes, "https://example.com/app/users/1");

    expect(result.ok && result.value.resourceHints).toContain(`<link rel="modulepreload" href="/user.js">`);
    expect(result.ok && result.value.resourceHints).toContain(
      `<link rel="preload" href="/avatar.jpg" as="image" fetchpriority="high">`,
    );
    expect(renderResourceHints(collectRouteResources(result.ok ? result.value.match.branch : []))).toContain(
      `<link rel="stylesheet" href="/app.css">`,
    );
  });

  it("supports typed route params at compile time", () => {
    type Params = ParamsForPath<"/users/:id/files/*path">;
    expectTypeOf<Params>().toEqualTypeOf<{ id: string; path: string }>();
  });

  it("short-circuits redirect/json/html route responses", async () => {
    const redirectResult = await renderRoute(
      [{ path: "/login", action: () => redirect("/dashboard"), render: () => "never" }],
      new Request("https://example.com/login", { method: "POST" }),
    );
    expect(redirectResult.ok && redirectResult.value).toMatchObject({ status: 302, html: "" });
    expect(redirectResult.ok && redirectResult.value.headers.get("location")).toBe("/dashboard");

    const jsonResult = await renderRoute(
      [{ path: "/api", loader: () => json({ ok: true }), render: () => "never" }],
      "https://example.com/api",
    );
    expect(jsonResult.ok && jsonResult.value.responseBody).toBe(`{"ok":true}`);
    expect(jsonResult.ok && jsonResult.value.headers.get("content-type")).toBe("application/json; charset=utf-8");

    const htmlResult = await renderRoute(
      [{ path: "/raw", loader: () => html("<h1>Raw</h1>"), render: () => "never" }],
      "https://example.com/raw",
    );
    expect(htmlResult.ok && htmlResult.value.html).toBe("<h1>Raw</h1>");
  });

  it("renders streaming route fallbacks before loader content", async () => {
    const routes: RouteDefinition[] = [
      {
        id: "stream",
        path: "/stream",
        fallback: "<p>Loading</p>",
        loader: async () => "Ready",
        render: ({ data }) => `<h1>${data}</h1>`,
      },
    ];

    const result = await renderRouteStream(routes, "https://example.com/stream");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    const chunks: string[] = [];
    for await (const chunk of result.value.chunks) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(["<p>Loading</p>", "<h1>Ready</h1>"]);
  });

  it("applies security headers and route test utilities", async () => {
    const headers = createSecurityHeaders({ nonce: "abc123", csp: true, hsts: true });
    expect(headers.get("content-security-policy")).toContain(`script-src 'nonce-abc123' 'strict-dynamic'`);
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    const response = applySecurityHeaders(new Response("ok"), headers);
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");

    expect(() => redirect("https://evil.example")).toThrow("Unsafe redirect target");

    const rendered = await renderRouteForTest([{ id: "home", path: "/", render: () => "<h1>Home</h1>" }], "/");
    expect(rendered.html).toBe("<h1>Home</h1>");
  });

  it("guards route methods and oversized action bodies", async () => {
    const routes: RouteDefinition[] = [{ path: "/submit", action: () => ({ ok: true }), render: () => "ok" }];
    const method = await renderRoute(routes, new Request("https://example.com/submit", { method: "DELETE" }), {
      allowedMethods: ["GET", "POST"],
    });
    expect(method.ok && method.value).toMatchObject({ status: 405, html: "<h1>Method Not Allowed</h1>" });
    expect(method.ok && method.value.headers.get("allow")).toBe("GET, POST");

    const oversized = await renderRoute(
      routes,
      new Request("https://example.com/submit", {
        method: "POST",
        body: "too large",
        headers: { "content-length": "9" },
      }),
      { maxActionBodyBytes: 4 },
    );
    expect(oversized.ok && oversized.value).toMatchObject({ status: 413, html: "<h1>Payload Too Large</h1>" });
  });
});
