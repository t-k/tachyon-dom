import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  applySecurityHeaders,
  collectRouteResources,
  createFileRouteManifest,
  createHrefBuilder,
  createSecurityHeaders,
  defineRouteModule,
  escapeToHtml,
  generateRouteTypes,
  html,
  json,
  redirect,
  renderHead,
  renderResourceHints,
  renderRoute,
  renderRouteStream,
  routeFromModule,
  unsafeHtml,
  type ParamsForPath,
  type RouteDefinition,
} from "../src/router";
import { scanFileRoutes } from "../src/router-node";
import { renderRouteForTest } from "../src/testing";

describe("advanced router features", () => {
  it("creates file-based route manifests from route files", async () => {
    const files = [
      "/app/src/routes/index.tachyon.html",
      "/app/src/routes/about.td",
      "/app/src/routes/users/[id].tachyon.html",
      "/app/src/routes/blog/[...slug].td",
      "/app/src/routes/admin/route.ts",
      "/app/src/routes/admin/layout.ts",
      "/app/src/routes/shop/[id]/page.td",
      "/app/src/routes/news/[...slug]/page.td",
    ];

    expect(createFileRouteManifest(files, { rootDir: "/app/src/routes" })).toEqual([
      { id: "index", path: "/", file: "/app/src/routes/index.tachyon.html", kind: "template" },
      { id: "about", path: "/about", file: "/app/src/routes/about.td", kind: "template" },
      { id: "users-id", path: "/users/:id", file: "/app/src/routes/users/[id].tachyon.html", kind: "template" },
      { id: "blog-slug", path: "/blog/*slug", file: "/app/src/routes/blog/[...slug].td", kind: "template" },
      { id: "admin-route", path: "/admin", file: "/app/src/routes/admin/route.ts", kind: "module" },
      { id: "admin-layout", path: "/admin", file: "/app/src/routes/admin/layout.ts", kind: "layout" },
      { id: "shop-id", path: "/shop/:id", file: "/app/src/routes/shop/[id]/page.td", kind: "template" },
      { id: "news-slug", path: "/news/*slug", file: "/app/src/routes/news/[...slug]/page.td", kind: "template" },
    ]);

    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-routes-"));
    try {
      await mkdir(path.join(dir, "users"), { recursive: true });
      await writeFile(path.join(dir, "index.td"), `<main>Home</main>`);
      await writeFile(path.join(dir, "users", "[id].td"), `<main>User</main>`);
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

  it("uses a route module not-found boundary for an unmatched descendant", async () => {
    const route = routeFromModule("users", defineRouteModule({
      path: "/users",
      NotFound: ({ url }) => `<h1>Missing ${url.pathname}</h1>`,
      render: () => "users",
    }));

    const result = await renderRoute([route], "https://example.com/users/missing");

    expect(result.ok && result.value).toMatchObject({ status: 404, html: "<h1>Missing /users/missing</h1>" });
  });

  it("selects the deepest dynamic not-found boundary for an unmatched nested descendant", async () => {
    const routes: RouteDefinition[] = [
      {
        path: "/app",
        render: ({ outlet }) => `<main>${outlet}</main>`,
        notFound: () => "app missing",
        children: [
          {
            path: "users/:id",
            render: () => "user",
            notFound: ({ url }) => `user missing ${url.pathname}`,
          },
        ],
      },
    ];

    const nested = await renderRoute(routes, "https://example.com/app/users/42/settings/profile");
    const parent = await renderRoute(routes, "https://example.com/app/other/missing");

    expect(nested.ok && nested.value).toMatchObject({
      status: 404,
      html: "user missing /app/users/42/settings/profile",
    });
    expect(parent.ok && parent.value).toMatchObject({ status: 404, html: "app missing" });
  });

  it("uses a root boundary without confusing segment prefixes and lets wildcard routes match normally", async () => {
    const routes: RouteDefinition[] = [
      { path: "/", render: () => "home", notFound: () => "root missing" },
      { path: "/user", render: () => "user", notFound: () => "user missing" },
      { path: "/docs/*slug", render: ({ params }) => `docs:${params.slug}`, notFound: () => "docs missing" },
    ];

    const unrelated = await renderRoute(routes, "https://example.com/users/missing");
    const wildcard = await renderRoute(routes, "https://example.com/docs/guides/start");

    expect(unrelated.ok && unrelated.value).toMatchObject({ status: 404, html: "root missing" });
    expect(wildcard.ok && wildcard.value).toMatchObject({ status: 200, html: "docs:guides/start" });
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

  it("passes route-local loader data to dynamic resource functions", async () => {
    const routes: RouteDefinition[] = [
      {
        id: "app",
        path: "/app",
        loader: () => ({ asset: "/app-shell.js" }),
        resources: ({ data }) => [{ href: (data as { asset: string }).asset, rel: "modulepreload" }],
        render: ({ outlet }) => `<main>${outlet}</main>`,
        children: [
          {
            id: "user",
            path: "users/:id",
            loader: ({ params }) => ({ asset: `/users/${params.id}.js` }),
            resources: ({ data, loaderData }) => [
              { href: (data as { asset: string }).asset, rel: "modulepreload" },
              { href: (loaderData.app as { asset: string }).asset, rel: "preload", as: "script" },
            ],
            render: ({ data }) => `<h1>${(data as { asset: string }).asset}</h1>`,
          },
        ],
      },
    ];

    const result = await renderRoute(routes, "https://example.com/app/users/42");

    expect(result.ok && result.value.resourceHints).toContain(`<link rel="modulepreload" href="/app-shell.js">`);
    expect(result.ok && result.value.resourceHints).toContain(`<link rel="modulepreload" href="/users/42.js">`);
    expect(result.ok && result.value.resourceHints).toContain(
      `<link rel="preload" href="/app-shell.js" as="script">`,
    );
  });

  it("matches named wildcard route params from file-route catchalls", async () => {
    const routes: RouteDefinition[] = [
      {
        id: "blog",
        path: "/blog/*slug",
        render: ({ params }) => `<h1>${params.slug}</h1>`,
      },
    ];
    const result = await renderRoute(routes, "https://example.com/blog/2026/launch");

    expect(result.ok && result.value.html).toBe("<h1>2026/launch</h1>");
  });

  it("prefers static routes over dynamic routes regardless of declaration order", async () => {
    const routes: RouteDefinition[] = [
      { id: "user", path: "/users/:id", render: ({ params }) => `<h1>User ${params.id}</h1>` },
      { id: "new-user", path: "/users/new", render: () => "<h1>New user</h1>" },
    ];
    const result = await renderRoute(routes, "https://example.com/users/new");

    expect(result.ok && result.value.html).toBe("<h1>New user</h1>");
  });

  it("supports typed route params at compile time", () => {
    type Params = ParamsForPath<"/users/:id/files/*path">;
    expectTypeOf<Params>().toEqualTypeOf<{ id: string; path: string }>();

    const href = createHrefBuilder([
      { id: "home", path: "/" },
      { id: "user", path: "/users/:id" },
    ] as const);
    expectTypeOf<Parameters<typeof href>[0]>().toEqualTypeOf<"home" | "user">();
  });

  it("short-circuits redirect/json/escaped html route responses", async () => {
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
      [{ path: "/raw", loader: () => html(escapeToHtml("<h1>Raw</h1>")), render: () => "never" }],
      "https://example.com/raw",
    );
    expect(htmlResult.ok && htmlResult.value.html).toBe("&lt;h1&gt;Raw&lt;/h1&gt;");
  });

  it("requires explicit unsafeHtml for raw HTML route responses", async () => {
    const htmlResult = await renderRoute(
      [{ path: "/raw", loader: () => html(unsafeHtml("<h1>Raw</h1>")), render: () => "never" }],
      "https://example.com/raw",
    );
    expect(htmlResult.ok && htmlResult.value.html).toBe("<h1>Raw</h1>");
  });

  it("propagates CSP nonces to head scripts and hydration state", async () => {
    expect(renderHead({ scripts: [{ src: "/app.js", type: "module" }] }, { nonce: "n-1" })).toBe(
      `<script src="/app.js" type="module" nonce="n-1"></script>`,
    );
    const result = await renderRoute(
      [{ id: "home", path: "/", loader: () => ({ ok: true }), render: () => "<h1>Home</h1>" }],
      "https://example.com/",
      { cspNonce: "n-1" },
    );
    expect(result.ok && result.value.stateScript).toContain(`nonce="n-1"`);
  });

  it("generates route type declarations from a manifest", () => {
    expect(
      generateRouteTypes([
        { id: "home", path: "/" },
        { id: "user", path: "/users/:id" },
      ]),
    ).toContain(`"user": { path: "/users/:id"; params: ParamsForPath<"/users/:id"> }`);
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
    await expect(result.value.final).resolves.toMatchObject({
      headHtml: "",
      stateScript: expect.stringContaining(`data-tachyon-state="route:stream"`),
    });
  });

  it("emits streaming route fallback before loader data resolves", async () => {
    let resolveLoader: ((value: string) => void) | undefined;
    const loaderStarted: string[] = [];
    const routes: RouteDefinition[] = [
      {
        id: "stream",
        path: "/stream",
        fallback: "<p>Loading</p>",
        loader: () => {
          loaderStarted.push("loader");
          return new Promise<string>((resolve) => {
            resolveLoader = resolve;
          });
        },
        render: ({ data }) => `<h1>${data}</h1>`,
      },
    ];

    const pendingResult = renderRouteStream(routes, "https://example.com/stream");
    const result = await Promise.race([
      pendingResult,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 25)),
    ]);
    expect(result).not.toBeUndefined();
    if (!result) {
      resolveLoader?.("Ready");
      await pendingResult;
      throw new Error("renderRouteStream waited for loader data before returning.");
    }
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    const iterator = result.value.chunks[Symbol.asyncIterator]();
    const firstChunk = await Promise.race([
      iterator.next(),
      Promise.resolve().then(() => ({ done: false as const, value: "loader still pending" })),
    ]);

    expect(loaderStarted).toEqual(["loader"]);
    expect(firstChunk).toEqual({ done: false, value: "<p>Loading</p>" });
    resolveLoader?.("Ready");
    await expect(iterator.next()).resolves.toEqual({ done: false, value: "<h1>Ready</h1>" });
    await expect(result.value.final).resolves.toMatchObject({
      status: 200,
      stateScript: expect.stringContaining(`data-tachyon-state="route:stream"`),
    });
  });

  it("preserves streaming route redirects without emitting fallbacks", async () => {
    const routes: RouteDefinition[] = [
      {
        id: "private",
        path: "/private",
        fallback: "<p>Loading</p>",
        loader: () => redirect("/login"),
        render: () => "<h1>Private</h1>",
      },
    ];

    const result = await renderRouteStream(routes, "https://example.com/private");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    const chunks: string[] = [];
    for await (const chunk of result.value.chunks) {
      chunks.push(chunk);
    }

    expect(result.value.status).toBe(302);
    expect(result.value.headers.get("location")).toBe("/login");
    expect(chunks).toEqual([]);
    await expect(result.value.final).resolves.toMatchObject({ status: 302 });
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

    const oversizedWithoutLength = await renderRoute(
      routes,
      new Request("https://example.com/submit", {
        method: "POST",
        body: "too large",
      }),
      { maxActionBodyBytes: 4 },
    );
    expect(oversizedWithoutLength.ok && oversizedWithoutLength.value).toMatchObject({
      status: 413,
      html: "<h1>Payload Too Large</h1>",
    });
  });
});
