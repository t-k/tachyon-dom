import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createStaticAssetHandler } from "../src/adapters/node";
import {
  cacheControl,
  createHrefBuilder,
  createRouteBuildManifest,
  createRoutePreloadPlan,
  defer,
  hrefForRoute,
  renderDeferredDataScript,
  resolveDeferredData,
  renderRoute,
  withCacheHeaders,
  type RouteDefinition,
} from "../src/router";

describe("router platform features", () => {
  it("serves static assets without allowing path traversal", async () => {
    const dir = path.join(tmpdir(), `tachyon-assets-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(path.join(dir, "app.js"), `console.log("ok");`);
      const handler = createStaticAssetHandler({ rootDir: dir, basePath: "/assets" });

      const served = await handler(new Request("https://x.test/assets/app.js"));
      expect(served?.status).toBe(200);
      expect(served?.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      await expect(served?.text()).resolves.toBe(`console.log("ok");`);

      const traversal = await handler(new Request("https://x.test/assets/%2F..%2Fsecret.txt"));
      expect(traversal?.status).toBe(403);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls through for unsupported methods while keeping static asset rejections", async () => {
    const dir = path.join(tmpdir(), `tachyon-assets-${Date.now()}-fallthrough`);
    await mkdir(path.join(dir, "folder"), { recursive: true });
    try {
      const handler = createStaticAssetHandler({ rootDir: dir, basePath: "/", fallthroughOnNotFound: true });

      await expect(handler(new Request("https://x.test/healthz"))).resolves.toBeUndefined();

      const malformed = await handler(new Request("https://x.test/%E0%A4%A"));
      expect(malformed?.status).toBe(404);
      await expect(malformed?.text()).resolves.toBe("Not Found");

      const traversal = await handler(new Request("https://x.test/%2F..%2Fsecret.txt"));
      expect(traversal?.status).toBe(403);
      await expect(traversal?.text()).resolves.toBe("Forbidden");

      await expect(handler(new Request("https://x.test/app.js", { method: "POST" }))).resolves.toBeUndefined();

      await expect(handler(new Request("https://x.test/folder"))).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("creates a route build manifest with route assets and types", async () => {
    const routes: RouteDefinition[] = [
      { id: "home", path: "/", resources: [{ rel: "stylesheet", href: "/app.css" }], render: () => "home" },
      { id: "user", path: "/users/:id", render: () => "user" },
    ];
    const manifest = createRouteBuildManifest(routes, {
      buildId: "b1",
      assets: [{ routeId: "user", files: ["/user.js"] }],
    });

    expect(manifest.routes.map((route) => route.id)).toEqual(["home", "user"]);
    expect(manifest.assets.user).toEqual(["/user.js"]);
    expect(manifest.types).toContain(`ParamsForPath<"/users/:id">`);
  });

  it("builds typed hrefs and route preload plans from manifests", () => {
    const routes: RouteDefinition[] = [
      { id: "home", path: "/", resources: [{ rel: "stylesheet", href: "/app.css" }], render: () => "home" },
      { id: "user", path: "/users/:id", render: () => "user" },
    ];
    const manifest = createRouteBuildManifest(routes, {
      buildId: "b1",
      assets: [{ routeId: "user", files: ["/user.js", "/user.css"] }],
    });
    const href = createHrefBuilder(manifest.routes);

    expect(href("user", { id: "42" })).toBe("/users/42");
    expect(hrefForRoute(manifest.routes, "user", { id: "a b" })).toBe("/users/a%20b");
    expect(createRoutePreloadPlan(manifest, "user")).toEqual([
      { href: "/user.js", rel: "modulepreload" },
      { href: "/user.css", rel: "preload", as: "style" },
    ]);
  });

  it("runs route middleware and observability hooks around rendering", async () => {
    const events: string[] = [];
    const routes: RouteDefinition[] = [{ id: "rewritten", path: "/rewritten", render: () => "<h1>Done</h1>" }];
    const result = await renderRoute(routes, "https://x.test/original", {
      middleware: [
        ({ request }) => {
          events.push("middleware");
          return new Request(new URL("/rewritten", request.url), request);
        },
      ],
      hooks: {
        onMatch: ({ match }) => {
          events.push(`match:${match.route.id}`);
        },
        onRender: ({ html }) => {
          events.push(`render:${html}`);
        },
      },
    });

    expect(result.ok && result.value.html).toBe("<h1>Done</h1>");
    expect(events).toEqual(["middleware", "match:rewritten", "render:<h1>Done</h1>"]);
  });

  it("passes environment variables to middleware, loaders, render, headers, and cache policies", async () => {
    const routes: RouteDefinition[] = [
      {
        id: "home",
        path: "/",
        headers: ({ env }) => ({ "x-runtime": env.RUNTIME_NAME ?? "unknown" }),
        cache: ({ env }) => ({ mode: "public", maxAge: 60, sharedMaxAge: Number(env.PAGE_S_MAXAGE ?? 120) }),
        loader: ({ env }) => env.RUNTIME_NAME,
        render: ({ data, env }) => `<h1>${data}:${env.RUNTIME_NAME}</h1>`,
      },
    ];
    const seen: string[] = [];
    const result = await renderRoute(routes, "https://x.test/", {
      env: { RUNTIME_NAME: "edge", PAGE_S_MAXAGE: "300" },
      middleware: [
        ({ env }) => {
          seen.push(env.RUNTIME_NAME ?? "");
        },
      ],
    });

    expect(result.ok && result.value.html).toBe("<h1>edge:edge</h1>");
    expect(result.ok && result.value.headers.get("x-runtime")).toBe("edge");
    expect(result.ok && result.value.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=300");
    expect(seen).toEqual(["edge"]);
  });

  it("creates cache and revalidation headers for route responses", () => {
    expect(
      cacheControl({ mode: "public", maxAge: 60, staleWhileRevalidate: 30, tags: ["home"] }).get("cache-control"),
    ).toBe("public, max-age=60, stale-while-revalidate=30");
    expect(cacheControl({ mode: "public", maxAge: Number.NaN, sharedMaxAge: -1 }).get("cache-control")).toBe("public");
    const response = withCacheHeaders(new Response("ok"), { mode: "no-store" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("defaults an unspecified route cache policy to private", () => {
    expect(cacheControl({ maxAge: 60 }).get("cache-control")).toBe("private, max-age=60");
  });

  it("resolves deferred loader data independently from route rendering", async () => {
    const deferred = defer({ title: "Now", comments: Promise.resolve(["A", "B"]) });

    expect(deferred.immediate).toEqual({ title: "Now" });
    await expect(resolveDeferredData(deferred)).resolves.toEqual({ title: "Now", comments: ["A", "B"] });
    await expect(renderDeferredDataScript("route:post", deferred, { nonce: "n1" })).resolves.toContain(
      `data-tachyon-deferred="route:post" nonce="n1"`,
    );
  });
});
