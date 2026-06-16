import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createStaticAssetHandler } from "../src/adapters";
import { createRouteBuildManifest, defer, resolveDeferredData, renderRoute, type RouteDefinition } from "../src/router";

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

  it("resolves deferred loader data independently from route rendering", async () => {
    const deferred = defer({ title: "Now", comments: Promise.resolve(["A", "B"]) });

    expect(deferred.immediate).toEqual({ title: "Now" });
    await expect(resolveDeferredData(deferred)).resolves.toEqual({ title: "Now", comments: ["A", "B"] });
  });
});
