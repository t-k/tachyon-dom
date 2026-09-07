// @vitest-environment node
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  checkFeatureMeasurements,
  renderFeatureTable,
  updateFeatureDocumentation,
  validateFeatureReport,
} from "../scripts/browser-feature-report.mjs";
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
  it("rejects stale input hashes or measurements but ignores provenance-only changes", () => {
    const baseline = report();
    const current = report();
    current.provenance.commit = "different";
    expect(() => checkFeatureMeasurements(baseline, current)).not.toThrow();
    current.fixtures[0]!.inputHash = "b".repeat(64);
    expect(() => checkFeatureMeasurements(baseline, current)).toThrow(/Stale/);
    current.fixtures[0]!.inputHash = baseline.fixtures[0]!.inputHash;
    current.fixtures[0]!.brotliBytes++;
    expect(() => checkFeatureMeasurements(baseline, current)).toThrow(/Stale/);
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
