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
    const source = readFileSync(fixture("tachyon/server.mjs"), "utf8");

    expect(source).not.toContain("await delay(");
    expect(source).not.toContain("fallback: documentShell");
  });

  it("keeps Tachyon benchmark hot paths lean", () => {
    const source = readFileSync(fixture("tachyon/server.mjs"), "utf8");

    expect(source).not.toContain("loader: ({ params })");
    expect(source).toContain("partialCache");
    expect(source).toContain("streamHtml");
    expect(source).toContain("product42Html");
    expect(source).toContain('request.url?.startsWith("/products/42")');
    expect(source).toContain('request.url?.startsWith("/stream")');
  });
});
