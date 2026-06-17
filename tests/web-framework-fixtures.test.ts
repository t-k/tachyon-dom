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

  it("does not give Tachyon a fixture-only stream delay", () => {
    const source = readFileSync(fixture("tachyon/server.ts"), "utf8");

    expect(source).not.toContain("await delay(");
    expect(source).not.toContain("fallback: documentShell");
  });

  it("keeps Tachyon benchmark hot paths lean", () => {
    const source = readFileSync(fixture("tachyon/server.ts"), "utf8");

    expect(source).not.toContain("loader: ({ params })");
    expect(source).toContain("defineStaticRoute");
    expect(source).toContain("staticRoutes");
    expect(source).toContain("createClientRouter");
    expect(source).toContain('target: "#app"');
    expect(source).toContain("staticAssets");
    expect(source).toContain("streamHtml");
    expect(source).toContain("product42Html");
    expect(source).toContain("interactiveHtml");
    expect(source).toContain('route("/products/42", product42Html)');
    expect(source).toContain('route("/interactive", interactiveHtml)');
    expect(source).toContain('route("/stream", streamHtml)');
  });

  it("provides full interactive routes for client bundle measurement", () => {
    expect(readFileSync(fixture("tachyon/server.ts"), "utf8")).toContain('data-action="increment"');
    expect(readFileSync(fixture("marko-run/src/routes/interactive/+page.marko"), "utf8")).toContain("onClick()");
    expect(readFileSync(fixture("solid-start/src/routes/interactive.tsx"), "utf8")).toContain("createSignal");
    expect(readFileSync(fixture("tanstack-start/src/routes/interactive.tsx"), "utf8")).toContain("useState");
    expect(readFileSync(fixture("next/app/interactive/counter.tsx"), "utf8")).toContain('"use client"');
  });
});
