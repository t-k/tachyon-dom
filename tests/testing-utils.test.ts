import { describe, expect, it } from "vitest";
import { defineApp } from "../src/app";
import { assertAppHtml, assertRouteParity, renderAppForTest, renderRouteForTest } from "../src/testing";

describe("testing utilities", () => {
  it("renders routes for tests and checks server/client parity", async () => {
    const route = { path: "/", render: () => "<h1>Home</h1>" };

    expect((await renderRouteForTest([route], "/")).html).toBe("<h1>Home</h1>");
    await expect(assertRouteParity([route], [{ path: "/", clientHtml: "<h1>Home</h1>" }])).resolves.toBeUndefined();
    await expect(assertRouteParity([route], [{ path: "/", clientHtml: "<h1>Other</h1>" }])).rejects.toThrow(
      "Route parity mismatch",
    );
  });

  it("renders app definitions for SSR tests", () => {
    const app = defineApp({
      pages: [{ path: "/", fileName: "index.html", template: `<section><h1>{title}</h1></section>`, scope: { title: "Home" } }],
    });

    expect(renderAppForTest(app, "/")).toContain("<h1>Home</h1>");
    expect(() => assertAppHtml(app, "/", ["<main", "<h1>Home</h1>"])).not.toThrow();
    expect(() => assertAppHtml(app, "/", ["Missing"])).toThrow("App HTML assertion failed");
  });
});
