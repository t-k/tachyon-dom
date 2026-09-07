// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkFeatureMeasurements,
  renderFeatureTable,
  updateFeatureDocumentation,
  validateFeatureReport,
} from "../scripts/browser-feature-report.mjs";
import { runBrowserFeatureBudgets } from "../scripts/verify-browser-feature-budgets.mjs";
import { checkBundleBudget } from "../scripts/client-bundle-attribution.mjs";

const names = ["runtime/list", "runtime/form", "runtime/conditional", "runtime/router"];
const report = () => ({
  schemaVersion: 1,
  provenance: {
    commit: "abc123",
    dirty: false,
    node: "v24",
    esbuild: "0.25",
    minify: true,
    define: { __TACHYON_PRODUCTION__: "true" },
    compression: "node:brotli-default",
  },
  fixtures: names.map((name) => ({ name, inputHash: "a".repeat(64), minifiedBytes: 100, brotliBytes: 50 })),
});

describe("browser feature measurement documentation", () => {
  it("rejects the previous conditional size range independently for both budgets", async () => {
    const budgets = JSON.parse(await readFile("scripts/browser-feature-budgets.json", "utf8"));
    expect(
      checkBundleBudget({ minifiedBytes: 35000, brotliBytes: 4759, budget: budgets["runtime/conditional"] }).ok,
    ).toBe(false);
    expect(
      checkBundleBudget({ minifiedBytes: 14172, brotliBytes: 10000, budget: budgets["runtime/conditional"] }).ok,
    ).toBe(false);
  });
  it("renders deterministic fixture-specific measurements and preserves surrounding text", () => {
    const input = report();
    const table = renderFeatureTable(input);
    expect(table).toContain("| runtime/conditional | 100 | 50 |");
    expect(table).toContain("browser-feature-sizes.json");
    const source = "Before\n<!-- browser-feature-sizes:start -->\nold\n<!-- browser-feature-sizes:end -->\nAfter\n";
    const updated = updateFeatureDocumentation(source, input);
    expect(updated).toBe(
      `Before\n<!-- browser-feature-sizes:start -->\n${table}\n<!-- browser-feature-sizes:end -->\nAfter\n`,
    );
    expect(updateFeatureDocumentation(updated, input)).toBe(updated);
    const changed = report();
    changed.fixtures[0]!.minifiedBytes++;
    expect(updateFeatureDocumentation(updated, changed)).not.toBe(updated);
  });
  it("rejects stale input hashes or measurements but ignores volatile checkout provenance", () => {
    const baseline = report();
    const current = report();
    current.provenance.commit = "different";
    current.provenance.dirty = true;
    expect(() => checkFeatureMeasurements(baseline, current)).not.toThrow();
    current.fixtures[0]!.inputHash = "b".repeat(64);
    expect(() => checkFeatureMeasurements(baseline, current)).toThrow(/Stale/);
    current.fixtures[0]!.inputHash = baseline.fixtures[0]!.inputHash;
    current.fixtures[0]!.brotliBytes++;
    expect(() => checkFeatureMeasurements(baseline, current)).toThrow(/Stale/);
  });

  it("rejects reproducibility condition changes while tolerating Node patch releases", () => {
    const baseline = report();
    const patched = report();
    patched.provenance.node = "v24.99.1";
    expect(() => checkFeatureMeasurements(baseline, patched)).not.toThrow();

    const nextMajor = report();
    nextMajor.provenance.node = "v25.0.0";
    expect(() => checkFeatureMeasurements(baseline, nextMajor)).toThrow(/build condition/i);

    const rebuilt = report();
    rebuilt.provenance.esbuild = "0.26";
    expect(() => checkFeatureMeasurements(baseline, rebuilt)).toThrow(/build condition.*esbuild/i);
  });
  it("rejects missing, duplicate, foreign, malformed, and nonproduction measurements", () => {
    expect(() => validateFeatureReport(report())).not.toThrow();
    for (const mutate of [
      (r: ReturnType<typeof report>) => {
        r.fixtures.pop();
      },
      (r: ReturnType<typeof report>) => {
        r.fixtures[0]!.name = "minimal-if";
      },
      (r: ReturnType<typeof report>) => {
        r.fixtures[0]!.name = r.fixtures[1]!.name;
      },
      (r: ReturnType<typeof report>) => {
        r.fixtures[0]!.brotliBytes = -1;
      },
      (r: ReturnType<typeof report>) => {
        r.provenance.minify = false;
      },
      (r: ReturnType<typeof report>) => {
        r.provenance.commit = "";
      },
    ]) {
      const input = report();
      mutate(input);
      expect(() => validateFeatureReport(input)).toThrow();
    }
    expect(() => validateFeatureReport({})).toThrow();
    expect(() => updateFeatureDocumentation("No markers", report())).toThrow();
  });
});

const featureBudgets = async () =>
  JSON.parse(await readFile("scripts/browser-feature-budgets.json", "utf8")) as Record<
    string,
    { maxMinifiedBytes: number; maxBrotliBytes: number }
  >;

const withArtifactRoot = async (prefix: string, run: (artifactRoot: string) => Promise<void>) => {
  const artifactRoot = await mkdtemp(join(tmpdir(), prefix));
  try {
    await run(artifactRoot);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
};

const savedReports = async (artifactRoot: string) => {
  const directories = (await readdir(artifactRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return Promise.all(
    directories.map(
      async (directory) =>
        JSON.parse(await readFile(join(artifactRoot, directory, "report.json"), "utf8")) as {
          validation: { ok: boolean; error?: string };
          fixtures: Array<{ name: string }>;
        },
    ),
  );
};

describe("browser feature budget runner", () => {
  it("saves a measurement report and rejects each budget failure independently", async () => {
    const base = await featureBudgets();
    const overrun = (name: string, field: "maxMinifiedBytes" | "maxBrotliBytes") => ({
      ...base,
      [name]: { ...base[name]!, [field]: 1 },
    });
    const cases = [
      { reason: /minified budget/, budgets: overrun("runtime/conditional", "maxMinifiedBytes") },
      { reason: /Brotli budget/, budgets: overrun("runtime/conditional", "maxBrotliBytes") },
      {
        reason: /Missing valid browser feature budget/,
        budgets: Object.fromEntries(Object.entries(base).filter(([name]) => name !== "runtime/conditional")),
      },
    ];

    for (const { reason, budgets } of cases) {
      await withArtifactRoot("tachyon-feature-budget-", async (artifactRoot) => {
        await expect(runBrowserFeatureBudgets({ artifactRoot, budgets })).rejects.toThrow(reason);
        const [saved, ...rest] = await savedReports(artifactRoot);
        expect(rest).toEqual([]);
        expect(saved?.validation.ok).toBe(false);
        expect(saved?.validation.error).toMatch(reason);
      });
    }
  }, 120_000);

  it("propagates a browser feature budget failure through the real command line", async () => {
    await withArtifactRoot("tachyon-feature-budget-cli-", async (artifactRoot) => {
      const base = await featureBudgets();
      const budgetsPath = join(artifactRoot, "budgets.json");
      await writeFile(
        budgetsPath,
        JSON.stringify({ ...base, "runtime/conditional": { maxMinifiedBytes: 1, maxBrotliBytes: 1 } }),
      );

      const result = spawnSync(
        process.execPath,
        ["scripts/verify-browser-feature-budgets.mjs", "--artifact-root", artifactRoot, "--budgets", budgetsPath],
        { cwd: process.cwd(), encoding: "utf8" },
      );

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/runtime\/conditional feature bundle exceeds/);
      const [saved] = await savedReports(artifactRoot);
      expect(saved?.validation.ok).toBe(false);
      expect(saved?.fixtures.map((fixture) => fixture.name)).toContain("runtime/conditional");
    });
  }, 120_000);

  it("fails the documentation command line on stale docs, malformed JSON, and missing fixtures", async () => {
    await withArtifactRoot("tachyon-feature-docs-", async (directory) => {
      const baselinePath = join(directory, "sizes.json");
      const docsPath = join(directory, "runtime.md");
      await writeFile(baselinePath, JSON.stringify(report()));
      await writeFile(
        docsPath,
        "Before\n<!-- browser-feature-sizes:start -->\nstale\n<!-- browser-feature-sizes:end -->\nAfter\n",
      );
      const run = (...args: string[]) =>
        spawnSync(
          process.execPath,
          ["scripts/browser-feature-report.mjs", "--baseline", baselinePath, "--docs", docsPath, ...args],
          { cwd: process.cwd(), encoding: "utf8" },
        );

      const stale = run();
      expect(stale.status).not.toBe(0);
      expect(stale.stderr).toMatch(/Stale runtime documentation/);

      expect(run("--write").status).toBe(0);
      expect(await readFile(docsPath, "utf8")).toContain("| runtime/conditional | 100 | 50 |");
      expect(run().status).toBe(0);

      await writeFile(baselinePath, "{ not json");
      expect(run().status).not.toBe(0);

      const missingFixture = report();
      missingFixture.fixtures.pop();
      await writeFile(baselinePath, JSON.stringify(missingFixture));
      const invalid = run();
      expect(invalid.status).not.toBe(0);
      expect(invalid.stderr).toMatch(/Invalid browser feature measurement report/);
    });
  }, 60_000);
});
