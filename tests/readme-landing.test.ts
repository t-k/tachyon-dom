import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (file: string): Promise<string> => readFile(path.join(root, file), "utf8");

describe("README landing page", () => {
  it("leads with the product message, example, generated output, and evidence", async () => {
    const readme = await read("README.md");
    const lines = readme.split("\n");
    const message =
      "Tachyon DOM is an experimental HTML-first compiler that turns static templates into direct DOM updates, using a small fine-grained runtime shared with SSR and streaming targets.";

    expect(lines.length).toBeGreaterThanOrEqual(150);
    expect(lines.length).toBeLessThanOrEqual(200);
    expect(lines.slice(0, 8).join("\n")).toContain(message);
    expect(readme).toContain("## Why Tachyon DOM?");
    expect(readme).toContain("## Quick Example");
    expect(readme).toContain("<button on:click={increment}>{count}</button>");
    expect(readme).toContain('<for each={rows} key={row.id}>');
    expect(readme).toContain("## What the Compiler Emits");
    expect(readme).toContain("__tachyonTextAt");
    expect(readme).toContain("__tachyonMountTextKeyedList");
    expect(readme).toContain("__tachyonCleanupTextKeyedList");
    expect(readme).toContain("## Measured Size");
    expect(readme).toContain("pnpm check:browser-entry");
    const sizes = JSON.parse(await readFile("scripts/browser-bundle-sizes.json", "utf8")) as {
      browserEntryMinifiedBytes: number;
    };
    expect(readme).toContain(`${sizes.browserEntryMinifiedBytes} bytes`);
    expect(readme).toContain("pnpm check:quick-example-size");
    expect(readme).toMatch(/Quick example client bundle: \d+ bytes minified, \d+ bytes Brotli/);
    expect(readme).toContain("## Keyed List Benchmark");
    expect(readme).toContain("pnpm bench:local");
  });

  it("links every detailed topic to an existing document", async () => {
    const readme = await read("README.md");
    const destinations = [
      "docs/getting-started.md",
      "docs/syntax-spec.md",
      "docs/runtime.md",
      "docs/app-vite.md",
      "docs/routing.md",
      "docs/adapters.md",
      "docs/security.md",
      "docs/migrations/whitespace.md",
      "benchmark/README.md",
      "docs/releasing.md",
      "CHANGELOG.md",
    ];

    for (const destination of destinations) {
      expect(readme).toContain(`(${destination})`);
      await expect(access(path.join(root, destination))).resolves.toBeUndefined();
    }
  });

  it("links the current release changelog", async () => {
    const readme = await read("README.md");
    const changelog = await read("CHANGELOG.md");

    expect(readme).toContain("[Changelog](CHANGELOG.md)");
    expect(changelog).toContain("## [0.1.1] - 2026-07-13");
    expect(changelog).toContain("[0.1.1]: https://github.com/t-k/tachyon-dom/compare/v0.1.0...v0.1.1");
  });

  it("keeps reference and migration detail out of the landing page", async () => {
    const readme = await read("README.md");

    expect(readme).not.toContain("HTML whitespace policy migration");
    expect(readme).not.toContain("Public boundary");
    expect(readme).not.toContain("The Lambda adapter derives request URLs");
    expect(readme).not.toContain("The client router in `tachyon-dom/runtime/router` supports");
  });

  it("runs the complete quick example bundle measurement in CI", async () => {
    const packageJson = JSON.parse(await read("package.json")) as { scripts: Record<string, string> };
    const ci = await read(".github/workflows/ci.yml");

    expect(packageJson.scripts["check:quick-example-size"]).toBe(
      "node scripts/verify-quick-example-bundle.mjs",
    );
    expect(ci).toContain("pnpm check:quick-example-size");
  });

  it("keeps displayed bundle sizes synchronized with the measurement contract", async () => {
    const readme = await read("README.md");
    const sizes = JSON.parse(await read("scripts/browser-bundle-sizes.json")) as {
      browserEntryMinifiedBytes: number;
      quickExampleMinifiedBytes: number;
      quickExampleBrotliBytes: number;
    };

    expect(readme).toContain(`${sizes.browserEntryMinifiedBytes} bytes minified`);
    expect(readme).toContain(
      `Quick example client bundle: ${sizes.quickExampleMinifiedBytes} bytes minified, ${sizes.quickExampleBrotliBytes} bytes Brotli`,
    );
  });

  it("points routing security and whitespace references at their current contracts", async () => {
    const routing = await read("docs/routing.md");

    expect(routing).toContain("docs/migrations/whitespace.md");
    expect(routing).not.toContain("README migration table is the normative");
    expect(routing).not.toContain("constructs request URLs from the incoming `Host` and `X-Forwarded-Proto`");
  });

  it("cites a clean production benchmark artifact and its measured ratio", async () => {
    const artifact = "benchmark/local-compare/results/2026-07-13-readme-baseline.json";
    const readme = await read("README.md");
    const result = JSON.parse(await read(artifact)) as {
      schemaVersion: number;
      provenance: { git: { dirty: boolean } };
      workload: { iterations: number; warmup: number; serveMode: string };
      measurements: { tables: { directComparisons: string } };
    };

    expect(result.schemaVersion).toBe(2);
    expect(result.provenance.git.dirty).toBe(false);
    expect(result.workload).toMatchObject({ iterations: 7, warmup: 2, serveMode: "production" });
    expect(readme).toContain(`(${artifact})`);
    expect(readme).toContain("| vanillajs-lite-keyed | 1.8% faster |");
    expect(readme).toContain("| solid-keyed | 0.9% faster |");
    expect(readme).toContain("| marko-keyed | 2.5% slower |");
    expect(readme).toContain("geometric mean of nine operations");
    expect(readme).toContain("Lower execution time is better.");
    expect(result.measurements.tables.directComparisons).toContain(
      "| vanillajs-lite-keyed | tachyon-dom | 0.982x |",
    );
  });
});
