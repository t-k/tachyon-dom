import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clientBundleFixtures, materializeClientBundleFixture } from "../benchmark/client-bundle/fixtures";
import { buildFixtureProject, collectHtmlAssets, measureBuiltFixture } from "../benchmark/client-bundle/measure";
import { formatClientBundleTable } from "../benchmark/client-bundle/report";

const projectRoot = path.resolve(import.meta.dirname, "..");

describe("client bundle benchmark fixtures", () => {
  it("defines unique interactive fixtures that all render an initial route", () => {
    const names = clientBundleFixtures.map((fixture) => fixture.name);
    expect(names.length).toBeGreaterThanOrEqual(4);
    expect(new Set(names).size).toBe(names.length);
    for (const fixture of clientBundleFixtures) {
      expect(fixture.name).toMatch(/^[a-z0-9-]+$/);
      expect(fixture.description.length).toBeGreaterThan(0);
      expect(fixture.initialPath.startsWith("/")).toBe(true);
      expect(Object.keys(fixture.routes)).toContain("index");
      expect(fixture.clientEntry).toMatch(/\b(?:hydrate|mount)\(/);
      expect(fixture.validate.click.length).toBeGreaterThan(0);
      expect(fixture.validate.expect.text.length).toBeGreaterThan(0);
    }
  });

  it("covers a counter, a keyed list, a form, a conditional, and a multi-route session", () => {
    const names = clientBundleFixtures.map((fixture) => fixture.name);
    expect(names).toEqual(expect.arrayContaining(["counter", "keyed-list", "form", "conditional", "multi-route"]));
  });
});

describe("client bundle asset collection", () => {
  it("resolves module scripts, module preloads, and stylesheets relative to the page", () => {
    const html = `<!doctype html><html><head>
      <link rel="stylesheet" href="../assets/app-abc.css" />
      <link rel="modulepreload" href="../assets/shared-def.js">
      <script type="module" src="../assets/main-123.js"></script>
      <script src="https://example.com/analytics.js"></script>
      <script>inline()</script>
    </head><body></body></html>`;
    expect(collectHtmlAssets(html, "/about/")).toEqual([
      { href: "/assets/app-abc.css", kind: "stylesheet" },
      { href: "/assets/shared-def.js", kind: "modulepreload" },
      { href: "/assets/main-123.js", kind: "script" },
    ]);
  });

  it("keeps root-relative assets and ignores pages without assets", () => {
    expect(collectHtmlAssets(`<script type="module" src="/assets/a.js"></script>`, "/")).toEqual([
      { href: "/assets/a.js", kind: "script" },
    ]);
    expect(collectHtmlAssets(`<main></main>`, "/")).toEqual([]);
  });
});

describe("client bundle report", () => {
  it("renders one row per fixture with raw, gzip, and brotli sizes", () => {
    const table = formatClientBundleTable([
      {
        name: "counter",
        description: "A counter",
        initialPath: "/",
        validated: true,
        html: { rawBytes: 400, gzipBytes: 300, brotliBytes: 250 },
        javascript: { rawBytes: 14_000, gzipBytes: 5_200, brotliBytes: 4_600 },
        stylesheets: { rawBytes: 0, gzipBytes: 0, brotliBytes: 0 },
        initial: { rawBytes: 14_400, gzipBytes: 5_500, brotliBytes: 4_850 },
        assets: [],
      },
    ]);
    expect(table).toContain("| Fixture | JS raw | JS gzip | JS brotli | HTML gzip | Initial gzip | Initial brotli |");
    expect(table).toContain("| counter | 13.67 KiB | 5.08 KiB | 4.49 KiB | 0.29 KiB | 5.37 KiB | 4.74 KiB |");
  });
});

describe("client bundle measurement", () => {
  it("builds the counter fixture as a production app and measures what its initial page fetches", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "tachyon-client-bundle-"));
    try {
      const fixture = clientBundleFixtures.find((candidate) => candidate.name === "counter");
      if (!fixture) throw new Error("Missing counter fixture.");
      const projectDir = await materializeClientBundleFixture(fixture, { workDir, packageRoot: projectRoot });
      const distDir = await buildFixtureProject(projectDir);
      const html = await readFile(path.join(distDir, "index.html"), "utf8");
      expect(html).toContain('<main id="app">');
      const measured = await measureBuiltFixture(distDir, fixture.initialPath);
      expect(measured.assets.filter((asset) => asset.kind === "script")).toHaveLength(1);
      expect(measured.javascript.rawBytes).toBeGreaterThan(1_000);
      expect(measured.javascript.gzipBytes).toBeLessThan(measured.javascript.rawBytes);
      expect(measured.javascript.brotliBytes).toBeLessThan(measured.javascript.rawBytes);
      expect(measured.html.rawBytes).toBe(Buffer.byteLength(html));
      expect(measured.initial.rawBytes).toBe(
        measured.html.rawBytes + measured.javascript.rawBytes + measured.stylesheets.rawBytes,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }, 60_000);
});
