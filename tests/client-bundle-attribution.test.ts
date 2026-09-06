// @vitest-environment node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  attributionForMetafile,
  checkBundleBudget,
  createClientBundleFixtures,
  findForbiddenInputs,
  findUnwantedFeatureInputs,
  runClientBundleAttribution,
  validateFixtureBudgets,
} from "../scripts/client-bundle-attribution.mjs";

describe("client bundle attribution", () => {
  it("records actual bytesInOutput contributions per output", () => {
    expect(
      attributionForMetafile({
        inputs: {
          "dist/runtime/signal.js": { bytes: 100 },
          "dist/runtime/text.js": { bytes: 50 },
        },
        outputs: {
          "out.js": {
            bytes: 200,
            inputs: {
              "dist/runtime/signal.js": { bytesInOutput: 37 },
              "dist/runtime/text.js": { bytesInOutput: 11 },
            },
          },
        },
      }),
    ).toEqual({
      outputs: [
        {
          path: "out.js",
          bytes: 200,
          inputs: [
            { path: "dist/runtime/signal.js", bytesInOutput: 37 },
            { path: "dist/runtime/text.js", bytesInOutput: 11 },
          ],
        },
      ],
      inputs: [
        { path: "dist/runtime/signal.js", bytesInOutput: 37 },
        { path: "dist/runtime/text.js", bytesInOutput: 11 },
      ],
    });
  });

  it("rejects forbidden inputs and budget overruns through explicit policy results", () => {
    expect(findForbiddenInputs(["dist/compiler/index.js", "dist/runtime/signal.js"])).toEqual([
      "dist/compiler/index.js",
    ]);
    expect(
      findUnwantedFeatureInputs([
        { path: "dist/runtime/list.js", bytesInOutput: 12 },
        { path: "dist/runtime/form.js", bytesInOutput: 0 },
      ]),
    ).toEqual([{ path: "dist/runtime/list.js", bytesInOutput: 12 }]);
    expect(
      checkBundleBudget({
        minifiedBytes: 101,
        brotliBytes: 10,
        budget: { maxMinifiedBytes: 100, maxBrotliBytes: 20 },
      }),
    ).toEqual({ ok: false, reason: "minified budget" });
    expect(
      checkBundleBudget({
        minifiedBytes: 100,
        brotliBytes: 21,
        budget: { maxMinifiedBytes: 100, maxBrotliBytes: 20 },
      }),
    ).toEqual({ ok: false, reason: "Brotli budget" });
  });

  it("requires every fixture to have a positive finite budget", () => {
    const fixtures = [{ name: "static" }, { name: "minimal-if" }];

    expect(validateFixtureBudgets({}, fixtures)).toMatchObject({ ok: false, reason: "missing fixture budget" });
    expect(
      validateFixtureBudgets(
        {
          static: { maxMinifiedBytes: 100, maxBrotliBytes: 100 },
          "minimal-if": { maxMinifiedBytes: 0, maxBrotliBytes: Number.POSITIVE_INFINITY },
        },
        fixtures,
      ),
    ).toMatchObject({ ok: false, reason: "invalid fixture budget" });
    expect(
      validateFixtureBudgets(
        {
          static: { maxMinifiedBytes: 100, maxBrotliBytes: 100 },
          "minimal-if": { maxMinifiedBytes: 200, maxBrotliBytes: 200 },
        },
        fixtures,
      ),
    ).toEqual({ ok: true });
  });

  it("fails the attribution runner when an unwanted feature contributes bytes", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "tachyon-client-bundles-policy-"));
    try {
      const fixtures = createClientBundleFixtures().map((fixture) =>
        fixture.name === "minimal-if"
          ? {
              ...fixture,
              entrySource: `${fixture.entrySource}
import { bindControl } from "./dist/runtime/form.js";
export const unwanted = bindControl;
`,
            }
          : fixture,
      );

      await expect(runClientBundleAttribution({ cwd: process.cwd(), artifactRoot, fixtures })).rejects.toThrow(
        /minimal-if.*unwanted feature/i,
      );
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("writes seven attributed fixtures with provenance and unique run artifacts", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "tachyon-client-bundles-"));
    try {
      const first = await runClientBundleAttribution({ cwd: process.cwd(), artifactRoot });
      const second = await runClientBundleAttribution({ cwd: process.cwd(), artifactRoot });

      expect(first.artifactPath).not.toBe(second.artifactPath);
      const report = JSON.parse(await readFile(first.artifactPath, "utf8")) as {
        schemaVersion: number;
        runId: string;
        provenance: {
          head: string;
          lockfileSha256: string;
          node: string;
          pnpm: string;
          esbuild: string;
          zlib: string;
        };
        buildOptions: { define: Record<string, string>; minify: boolean; platform: string };
        fixtures: Array<{
          name: string;
          sourceSha256: string;
          generatedSource: string;
          minifiedBytes: number;
          brotliBytes: number;
          inputs: Array<{ path: string; bytesInOutput: number }>;
          minimalFeaturePolicy?: { ok: boolean; unwantedInputs: string[] };
        }>;
      };

      expect(report.schemaVersion).toBe(1);
      expect(report.runId).toBe(first.runId);
      expect(report.provenance.head).toMatch(/^[a-f0-9]{40}$/);
      expect(report.provenance.lockfileSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(report.provenance.node).toBe(process.version);
      expect(report.provenance.pnpm).toMatch(/^\d+\.\d+\.\d+$/);
      expect(report.provenance.esbuild).toBe("0.28.1");
      expect(report.provenance.zlib).toBe(process.versions.zlib);
      expect(report.buildOptions).toMatchObject({
        define: { __TACHYON_PRODUCTION__: "true" },
        minify: true,
        platform: "browser",
      });
      expect(report.fixtures.map((fixture) => fixture.name)).toEqual([
        "static",
        "signal-only",
        "reactive-text",
        "event-only",
        "text-only-list",
        "minimal-if",
        "composite-quick-example",
      ]);
      for (const fixture of report.fixtures) {
        expect(fixture.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(fixture.generatedSource.length).toBeGreaterThan(0);
        expect(fixture.minifiedBytes).toBeGreaterThan(0);
        expect(fixture.brotliBytes).toBeGreaterThan(0);
        expect(fixture.inputs.some((input) => input.bytesInOutput > 0)).toBe(true);
        expect(fixture.inputs.every((input) => !("brotliBytes" in input))).toBe(true);
      }
      const minimalIf = report.fixtures.find((fixture) => fixture.name === "minimal-if");
      expect(minimalIf).toBeDefined();
      expect(minimalIf?.minimalFeaturePolicy?.ok).toBe(true);
      expect(minimalIf?.minimalFeaturePolicy?.unwantedInputs).toEqual([]);
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });
});
