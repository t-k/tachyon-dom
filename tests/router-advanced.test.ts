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
  it.each(["/items/%", "/items/%zz", "/items/%E0%A4%A"])(
    "returns generic 400 for malformed path %s without invoking route callbacks",
    async (pathname) => {
      let callbackCalls = 0;
      const routes: RouteDefinition[] = [
        {
          path: "/items/:id",
          loader: () => {
            callbackCalls += 1;
          },
          render: () => {
            callbackCalls += 1;
            return "item";
          },
          notFound: () => {
            callbackCalls += 1;
            return "custom missing";
          },
        },
      ];

      const buffered = await renderRoute(routes, `https://example.com${pathname}`, {
        notFound: () => {
          callbackCalls += 1;
          return "global missing";
        },
      });
      const streamed = await renderRouteStream(routes, `https://example.com${pathname}`);

      expect(buffered.ok && buffered.value.status).toBe(400);
      expect(buffered.ok && buffered.value.html).toBe("<h1>Bad Request</h1>");
      expect(buffered.ok && buffered.value.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(streamed.ok && streamed.value.status).toBe(400);
      expect(callbackCalls).toBe(0);
    },
  );

  it.each([
    ["nested", "/groups/:group/items/:id", "/groups/team/items/%zz"],
    ["wildcard", "/files/*path", "/files/folder/%zz"],
  ])("preserves 400 for malformed %s route parameters", async (_kind, routePath, pathname) => {
    const result = await renderRoute(
      [{ path: routePath, render: () => "unexpected" }],
      `https://example.com${pathname}`,
    );

    expect(result.ok && result.value.status).toBe(400);
    expect(result.ok && result.value.html).toBe("<h1>Bad Request</h1>");
  });

  it("continues to render valid percent-encoded route parameters", async () => {
    const result = await renderRoute(
      [{ path: "/items/:id", render: ({ params }) => params.id ?? "missing" }],
      "https://example.com/items/part%2Fdetail",
    );

    expect(result.ok && result.value.status).toBe(200);
    expect(result.ok && result.value.html).toBe("part/detail");
  });

  it.each([204, 205, 304])("normalizes bodyless route status %i in buffered and streaming results", async (status) => {
    const routes: RouteDefinition[] = [
      {
        path: "/submit",
        action: () =>
          json(
            { unexpected: true },
            {
              status,
              headers: { "content-length": "19", "transfer-encoding": "chunked", "x-kept": "yes" },
            },
          ),
        render: () => "unused",
      },
    ];
    const request = (): Request => new Request("https://example.com/submit", { method: "POST" });

    const buffered = await renderRoute(routes, request());
    const streamed = await renderRouteStream(routes, request());

    expect(buffered.ok && buffered.value.status).toBe(status);
    expect(buffered.ok && buffered.value.html).toBe("");
    expect(buffered.ok && buffered.value.responseBody).toBeUndefined();
    expect(buffered.ok && buffered.value.headers.get("content-length")).toBe(status === 304 ? "19" : null);
    expect(buffered.ok && buffered.value.headers.get("transfer-encoding")).toBe(status === 304 ? "chunked" : null);
    expect(buffered.ok && buffered.value.headers.get("x-kept")).toBe("yes");
    expect(streamed.ok && streamed.value.status).toBe(status);
    if (!streamed.ok) throw new Error(streamed.error.message);
    let streamedBody = "";
    for await (const chunk of streamed.value.chunks) streamedBody += chunk;
    expect(streamedBody).toBe("");
  });

  it.each([
    ["unmatched", [{ path: "/safe", render: () => "safe" }]],
    ["static literal", [{ path: "/%zz", render: () => "unsafe" }]],
  ] satisfies Array<[string, RouteDefinition[]]>)(
    "rejects malformed encoding before %s route selection",
    async (_kind, routes) => {
      let notFoundCalls = 0;
      const buffered = await renderRoute(routes, "https://example.com/%zz", {
        notFound: () => {
          notFoundCalls += 1;
          return "missing";
        },
      });
      const streamed = await renderRouteStream(routes, "https://example.com/%zz");

      expect(buffered.ok && buffered.value.status).toBe(400);
      expect(buffered.ok && buffered.value.html).toBe("<h1>Bad Request</h1>");
      expect(buffered.ok && buffered.value.error).toEqual({ message: "Invalid path encoding.", status: 400 });
      expect(streamed.ok && streamed.value.status).toBe(400);
      expect(streamed.ok && streamed.value.error).toEqual({ message: "Invalid path encoding.", status: 400 });
      expect(notFoundCalls).toBe(0);
    },
  );

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
      streamLayout: () => ({ before: "<main>", after: "</main>", outlet: "once" }),
      template: ({ data }) => `<h1>${(data as { name: string }).name}</h1>`,
      ErrorBoundary: ({ error }) => `<h1>${error instanceof Error ? error.message : "error"}</h1>`,
      NotFound: ({ url }) => `<h1>Missing ${url.pathname}</h1>`,
    });
    const route = routeFromModule("user", module);
    const result = await renderRoute([route], "https://example.com/users/1");

    expect(result.ok && result.value.html).toBe(`<h1>User 1</h1>`);
    expect(route.streamLayout).toBe(module.streamLayout);
    expect(
      route.error?.({
        error: new Error("boom"),
        request: new Request("https://example.com/users/1"),
        url: new URL("https://example.com/users/1"),
      }),
    ).toBe(`<h1>boom</h1>`);
  });

  it("uses a route module not-found boundary for an unmatched descendant", async () => {
    const route = routeFromModule(
      "users",
      defineRouteModule({
        path: "/users",
        NotFound: ({ url }) => `<h1>Missing ${url.pathname}</h1>`,
        render: () => "users",
      }),
    );

    const result = await renderRoute([route], "https://example.com/users/missing");

    expect(result.ok && result.value).toMatchObject({ status: 404, html: "<h1>Missing /users/missing</h1>" });
  });

  it("marks every not-found rendering path as HTML", async () => {
    const boundary = await renderRoute(
      [{ path: "/users", notFound: () => "<h1>Boundary missing</h1>", render: () => "users" }],
      "https://example.com/users/missing",
    );
    const custom = await renderRoute([], "https://example.com/missing", {
      notFound: () => "<h1>Custom missing</h1>",
    });
    const fallback = await renderRoute([], "https://example.com/missing");

    for (const result of [boundary, custom, fallback]) {
      expect(result.ok).toBe(true);
      expect(result.ok && result.value.status).toBe(404);
      expect(result.ok && result.value.headers.get("content-type")).toBe("text/html; charset=utf-8");
    }
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
    expect(result.ok && result.value.resourceHints).toContain(`<link rel="preload" href="/app-shell.js" as="script">`);
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

  it("streams progressive route chunks without buffering the completed body", async () => {
    let releaseSecond: (() => void) | undefined;
    const secondReady = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let streamCalls = 0;
    const routes: RouteDefinition[] = [
      {
        path: "/progressive",
        loader: () => "Ada",
        headers: { "x-route": "ready" },
        render: ({ data }) => `<h1>buffered ${data}</h1>`,
        stream: async function* ({ data }) {
          streamCalls += 1;
          yield `<h1>${data}</h1>`;
          await secondReady;
          yield "<p>done</p>";
        },
      },
    ];

    const result = await renderRouteStream(routes, "https://example.com/progressive");
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.headers.get("x-route")).toBe("ready");
    expect(streamCalls).toBe(0);
    const iterator = result.value.chunks[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: "<h1>Ada</h1>" });
    expect(streamCalls).toBe(1);
    const pendingSecond = iterator.next();
    await expect(Promise.race([pendingSecond.then(() => "settled"), Promise.resolve("pending")])).resolves.toBe(
      "pending",
    );
    releaseSecond?.();
    await expect(pendingSecond).resolves.toEqual({ done: false, value: "<p>done</p>" });

    const buffered = await renderRoute(routes, "https://example.com/progressive");
    expect(buffered.ok && buffered.value.html).toBe("<h1>buffered Ada</h1>");
    expect(streamCalls).toBe(1);
  });

  it("fails body iteration without appending pre-first or post-first error content", async () => {
    const before = await renderRouteStream(
      [
        {
          path: "/before",
          render: () => "buffered",
          stream: () => ({
            [Symbol.asyncIterator]: () => ({
              next: async () => {
                throw new Error("before-secret");
              },
            }),
          }),
        },
      ],
      "https://example.com/before",
    );
    if (!before.ok) throw new Error(before.error.message);
    expect(before.value.status).toBe(200);
    const beforeIterator = before.value.chunks[Symbol.asyncIterator]();
    await expect(beforeIterator.next()).rejects.toThrow("before-secret");

    const after = await renderRouteStream(
      [
        {
          path: "/after",
          render: () => "buffered",
          stream: async function* () {
            yield "<main>safe";
            throw new Error("after-secret");
          },
        },
      ],
      "https://example.com/after",
    );
    if (!after.ok) throw new Error(after.error.message);
    const iterator = after.value.chunks[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: "<main>safe" });
    await expect(iterator.next()).rejects.toThrow("after-secret");
  });

  it("returns the progressive source iterator when the consumer cancels", async () => {
    let cleaned = 0;
    let secondStarted = false;
    const result = await renderRouteStream(
      [
        {
          path: "/cancel",
          render: () => "buffered",
          stream: async function* () {
            try {
              yield "first";
              secondStarted = true;
              yield "second";
            } finally {
              cleaned += 1;
            }
          },
        },
      ],
      "https://example.com/cancel",
    );
    if (!result.ok) throw new Error(result.error.message);
    const iterator = result.value.chunks[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: "first" });
    await iterator.return?.();
    expect(cleaned).toBe(1);
    expect(secondStarted).toBe(false);
  });

  it("returns an unpulled progressive iterator on cancellation", async () => {
    let nextCalls = 0;
    let returnCalls = 0;
    const result = await renderRouteStream(
      [
        {
          path: "/unpulled-cancel",
          render: () => "buffered",
          stream: () => ({
            [Symbol.asyncIterator]: () => ({
              next: async () => {
                nextCalls += 1;
                return { done: false as const, value: "first" };
              },
              return: async () => {
                returnCalls += 1;
                return { done: true as const, value: undefined };
              },
            }),
          }),
        },
      ],
      "https://example.com/unpulled-cancel",
    );
    if (!result.ok) throw new Error(result.error.message);
    expect(nextCalls).toBe(0);
    const iterator = result.value.chunks[Symbol.asyncIterator]();
    await iterator.return?.();
    expect(nextCalls).toBe(0);
    expect(returnCalls).toBe(1);
  });

  it.each(["done", "return", "error"] as const)(
    "releases the request body when a progressive iterator closes via %s",
    async (mode) => {
      const input = new Request("https://example.com/progressive-body", {
        method: "POST",
        body: "payload",
      });
      const result = await renderRouteStream(
        [
          {
            path: "/progressive-body",
            render: () => "buffered",
            stream: () => ({
              [Symbol.asyncIterator]: () => ({
                next: async () => {
                  if (mode === "error") {
                    throw new Error("stream failed");
                  }
                  return mode === "done"
                    ? { done: true as const, value: undefined }
                    : { done: false as const, value: "chunk" };
                },
                return: async () => ({ done: true as const, value: undefined }),
              }),
            }),
          },
        ],
        input,
      );
      if (!result.ok) throw new Error(result.error.message);
      const iterator = result.value.chunks[Symbol.asyncIterator]();

      if (mode === "return") {
        await iterator.return?.();
      } else if (mode === "error") {
        await expect(iterator.next()).rejects.toThrow("stream failed");
      } else {
        await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
      }

      expect(input.bodyUsed).toBe(true);
    },
  );

  it("forwards route-module streams and never starts them for HEAD", async () => {
    let calls = 0;
    const route = routeFromModule(
      "module-stream",
      defineRouteModule({
        path: "/module-stream",
        render: () => "buffered",
        stream: async function* () {
          calls += 1;
          yield "progressive";
        },
      }),
    );
    const head = await renderRouteStream([route], new Request("https://example.com/module-stream", { method: "HEAD" }));
    if (!head.ok) throw new Error(head.error.message);
    expect(calls).toBe(0);
    const headChunks: string[] = [];
    for await (const chunk of head.value.chunks) headChunks.push(chunk);
    expect(headChunks).toEqual([]);

    const get = await renderRouteStream([route], "https://example.com/module-stream");
    if (!get.ok) throw new Error(get.error.message);
    const getChunks: string[] = [];
    for await (const chunk of get.value.chunks) getChunks.push(chunk);
    expect(getChunks).toEqual(["progressive"]);
    expect(calls).toBe(1);
  });

  it.each([
    ["dynamic", "/users/:id", "/users/42", "loaded:42"],
    ["wildcard", "/files/*path", "/files/a/b", "loaded:a/b"],
  ])("passes loader data to an idless %s progressive route", async (_label, path, requestPath, expected) => {
    const result = await renderRouteStream(
      [
        {
          path,
          loader: ({ params }) => `loaded:${Object.values(params)[0]}`,
          render: () => "buffered",
          stream: async function* ({ data }) {
            yield String(data);
          },
        },
      ],
      `https://example.com${requestPath}`,
    );
    if (!result.ok) throw new Error(result.error.message);
    const chunks: string[] = [];
    for await (const chunk of result.value.chunks) chunks.push(chunk);
    expect(chunks).toEqual([expected]);
  });

  it("does not commit streaming fallbacks before loader metadata is authoritative", async () => {
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
    expect(chunks).toEqual(["<h1>Ready</h1>"]);
    await expect(result.value.final).resolves.toMatchObject({
      headHtml: "",
      stateScript: expect.stringContaining(`data-tachyon-state="route:stream"`),
    });
  });

  it("waits for loader data before exposing streaming response metadata", async () => {
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
    expect(result).toBeUndefined();
    resolveLoader?.("Ready");
    const settled = await pendingResult;
    expect(settled.ok).toBe(true);
    if (!settled.ok) throw new Error(settled.error.message);
    const iterator = settled.value.chunks[Symbol.asyncIterator]();
    expect(loaderStarted).toEqual(["loader"]);
    await expect(iterator.next()).resolves.toEqual({ done: false, value: "<h1>Ready</h1>" });
    await expect(settled.value.final).resolves.toMatchObject({
      status: 200,
      stateScript: expect.stringContaining(`data-tachyon-state="route:stream"`),
    });
  });

  it("does not emit a fallback after authoritative streaming metadata resolves", async () => {
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
    const iterator = result.value.chunks[Symbol.asyncIterator]();
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

  it("commits delayed streaming status and headers before exposing body chunks", async () => {
    const routes: RouteDefinition[] = [
      {
        id: "account",
        path: "/account",
        fallback: "<p>Loading</p>",
        loader: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return "Ada";
        },
        cache: { mode: "no-store" },
        headers: () => {
          const headers = new Headers({
            "content-security-policy": "default-src 'self'",
            vary: "Cookie, Accept-Encoding",
          });
          headers.append("set-cookie", "sid=updated; Path=/; HttpOnly");
          headers.append("set-cookie", "theme=dark; Path=/");
          return headers;
        },
        render: ({ data }) => `<h1>${data}</h1>`,
      },
    ];

    const result = await renderRouteStream(routes, new Request("https://example.com/account"));
    if (!result.ok) throw new Error(result.error.message);

    expect(result.value.status).toBe(200);
    expect(result.value.headers.get("cache-control")).toBe("no-store");
    expect(result.value.headers.get("content-security-policy")).toBe("default-src 'self'");
    expect(result.value.headers.getSetCookie()).toEqual(["sid=updated; Path=/; HttpOnly", "theme=dark; Path=/"]);
    expect(result.value.headers.get("vary")).toBe("Cookie, Accept-Encoding");
    const chunks: string[] = [];
    for await (const chunk of result.value.chunks) chunks.push(chunk);
    expect(chunks).toEqual(["<h1>Ada</h1>"]);
  });

  it("commits delayed streaming redirects before exposing a fallback", async () => {
    const routes: RouteDefinition[] = [
      {
        path: "/private",
        fallback: "<p>Loading</p>",
        loader: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return redirect("/login", { headers: { "set-cookie": "return-to=/private; Path=/" } });
        },
        render: () => "<h1>Private</h1>",
      },
    ];

    const result = await renderRouteStream(routes, new Request("https://example.com/private"));
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.status).toBe(302);
    expect(result.value.headers.get("location")).toBe("/login");
    expect(result.value.headers.get("set-cookie")).toBe("return-to=/private; Path=/");
    const chunks: string[] = [];
    for await (const chunk of result.value.chunks) chunks.push(chunk);
    expect(chunks).toEqual([]);
  });

  it("commits delayed streaming errors before exposing a fallback", async () => {
    const routes: RouteDefinition[] = [
      {
        path: "/failure",
        fallback: "<p>Loading</p>",
        loader: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          throw new Error("loader failed");
        },
        error: () => "<h1>Recovered</h1>",
        render: () => "<h1>Success</h1>",
      },
    ];

    const result = await renderRouteStream(routes, new Request("https://example.com/failure"));
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.status).toBe(500);
    const chunks: string[] = [];
    for await (const chunk of result.value.chunks) chunks.push(chunk);
    expect(chunks).toEqual(["<h1>Recovered</h1>"]);
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
