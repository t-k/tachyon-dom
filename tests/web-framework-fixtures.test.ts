import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const fixture = (...segments: string[]): string => path.join(root, "benchmark/web-framework/fixtures", ...segments);

describe("web framework benchmark fixtures", () => {
  it("uses Marko Run dynamic route directory syntax", () => {
    expect(existsSync(fixture("marko-run/src/routes/products/$id/+page.marko"))).toBe(true);
    expect(existsSync(fixture("marko-run/src/routes/products/[id]/+page.marko"))).toBe(false);
  });

  it("uses an explicit deferred stream payload in the Tachyon fixture", () => {
    const source = readFileSync(fixture("tachyon/server.ts"), "utf8");

    expect(source).toContain("fallback:");
    expect(source).toContain("await delay(");
    expect(source).toContain("streaming: true");
  });

  it("uses delayed production streaming primitives in every framework fixture", () => {
    const sources = [
      readFileSync(fixture("tachyon/server.ts"), "utf8"),
      readFileSync(fixture("next/app/stream/page.tsx"), "utf8"),
      readFileSync(fixture("solid-start/src/routes/stream/index.tsx"), "utf8"),
      readFileSync(fixture("tanstack-start/src/routes/stream.tsx"), "utf8"),
      readFileSync(fixture("marko-run/src/routes/stream/+page.marko"), "utf8"),
      readFileSync(fixture("mreact-app-router/app/stream/page.tsx"), "utf8"),
    ];

    for (const source of sources) {
      expect(source).toMatch(/(?:delay|setTimeout)/);
      expect(source).toContain("20");
      expect(source).toContain('data-stream="shell"');
      expect(source).toContain('data-stream="done"');
    }
    expect(sources[1]).toContain("<Suspense");
    expect(sources[2]).toContain("createAsync");
    expect(sources[3]).toContain("<Await");
    expect(sources[4]).toContain("<await|resolvedItems|");
    expect(readFileSync(fixture("marko-run/src/routes/stream/+handler.ts"), "utf8")).toContain(
      "new ReadableStream",
    );
    expect(sources[5]).toContain("defer(");
  });

  it("versions corrected benchmark results and rejects buffered stream fixtures", () => {
    const source = readFileSync(path.join(root, "benchmark/web-framework/run-web-framework-benchmark.ts"), "utf8");

    expect(source).toContain("WEB_FRAMEWORK_CONTRACT_VERSION");
    expect(source).toContain("validateDynamicRouteSemantics");
    expect(source).toContain("measureStreamSemantics");
    expect(source).toContain('legacyDynamicAndStreamRankings: "non-authoritative"');
  });

  it("uses request-time Tachyon routing for the dynamic benchmark scenario", () => {
    const source = readFileSync(fixture("tachyon/server.ts"), "utf8");

    expect(source).toContain('path: "/products/:id"');
    expect(source).toContain("render: ({ params }) => documentShell(productBody(params.id)");
    expect(source).toContain("defineStaticRoute");
    expect(source).toContain("staticRoutes");
    expect(source).toContain("createClientRouter");
    expect(source).toContain('target: "#app"');
    expect(source).toContain("staticAssets");
    expect(source).toContain("streamShell");
    expect(source).toContain("interactiveHtml");
    expect(source).toContain('route("/interactive", interactiveHtml)');
  });

  it("provides full interactive routes for client bundle measurement", () => {
    expect(readFileSync(fixture("tachyon/server.ts"), "utf8")).toContain('data-action="increment"');
    expect(readFileSync(fixture("marko-run/src/routes/interactive/+page.marko"), "utf8")).toContain("onClick()");
    expect(readFileSync(fixture("solid-start/src/routes/interactive.tsx"), "utf8")).toContain("createSignal");
    expect(readFileSync(fixture("tanstack-start/src/routes/interactive.tsx"), "utf8")).toContain("useState");
    expect(readFileSync(fixture("next/app/interactive/counter.tsx"), "utf8")).toContain('"use client"');
  });

  it("includes mreact in the web framework benchmark runner", () => {
    const source = readFileSync(path.join(root, "benchmark/web-framework/run-web-framework-benchmark.ts"), "utf8");

    expect(source).toContain('name: "mreact-app-router"');
    expect(source).toContain("benchmark/web-framework/fixtures/mreact-app-router");
  });

  it("keeps the repo-local mreact fixture aligned with benchmark routes", () => {
    const mreactApp = fixture("mreact-app-router/app");

    expect(existsSync(path.join(mreactApp, "products/$id/page.tsx"))).toBe(true);
    expect(existsSync(path.join(mreactApp, "dashboard/users/page.tsx"))).toBe(true);
    expect(existsSync(path.join(mreactApp, "dashboard/orders/page.tsx"))).toBe(true);
    expect(existsSync(path.join(mreactApp, "interactive/page.tsx"))).toBe(true);
    expect(existsSync(path.join(mreactApp, "stream/page.tsx"))).toBe(true);

    expect(readFileSync(path.join(mreactApp, "page.tsx"), "utf8")).toContain('data-route="home"');
    expect(readFileSync(path.join(mreactApp, "page.tsx"), "utf8")).toContain("Static route");
    expect(readFileSync(path.join(mreactApp, "dashboard/users/page.tsx"), "utf8")).toContain('data-nav="orders"');
    expect(readFileSync(path.join(mreactApp, "interactive/page.tsx"), "utf8")).toContain('data-action="increment"');
    expect(readFileSync(path.join(mreactApp, "interactive/page.tsx"), "utf8")).toContain("data-count");
  });

  it("uses published mreact packages for the repo-local mreact fixture", () => {
    const packageJson = readFileSync(fixture("mreact-app-router/package.json"), "utf8");

    expect(packageJson).toContain("@reckona/mreact");
    expect(packageJson).toContain("@reckona/mreact-router");
    expect(packageJson).not.toContain("workspace:");
    expect(packageJson).not.toContain("../mreact");
  });
});
