import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  editLargeScriptScenario,
  exampleSfcSources,
  offsetOnlyScenario,
  perFileTargetsScenario,
  runScenario,
  scriptFromSource,
  sweepThenTargetScenario,
  syntheticScript,
} from "../benchmark/compiler/sfc-transform-cache";
import { sfcScriptTransformCacheLimit } from "../src/compiler/sfc";

// Each scenario uses its own synthetic index range so the module-wide cache
// never carries hits from one test into another.
const scripts = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => syntheticScript(from + index));

describe("sfc transform cache benchmark", () => {
  it("reads every example SFC that carries a script", () => {
    const sources = exampleSfcSources(join(import.meta.dirname, "../examples"));
    const withScript = sources.map(scriptFromSource).filter((script) => script !== undefined);
    expect(sources.length).toBeGreaterThan(withScript.length);
    expect(withScript.length).toBeGreaterThan(10);
  });

  it("hits for every request after the first one per file", () => {
    const result = runScenario("per-file", perFileTargetsScenario(scripts(1_000, 5), 2));
    expect(result.calls).toBe(20);
    expect(result.hits).toBe(15);
    expect(result.hitRate).toBe(0.75);
    expect(result.retainedEntries).toBe(5);
  });

  it("loses the second pass once the sweep exceeds the cache limit", () => {
    const under = runScenario("under", sweepThenTargetScenario(scripts(2_000, 8)));
    expect(under.hits).toBe(8);
    const over = runScenario("over", sweepThenTargetScenario(scripts(3_000, sfcScriptTransformCacheLimit + 1)));
    expect(over.hits).toBe(0);
    expect(over.retainedEntries).toBe(sfcScriptTransformCacheLimit);
  });

  it("misses on every edit and counts the retained key and code text", () => {
    const result = runScenario("edit", editLargeScriptScenario(syntheticScript(4_000), 6));
    expect(result.hits).toBe(0);
    expect(result.retainedEntries).toBe(6);
    expect(result.retainedChars).toBeGreaterThan(6 * syntheticScript(4_000).content.length);
  });

  it("hits when only the script offset changes", () => {
    const result = runScenario("offset", offsetOnlyScenario(syntheticScript(5_000), 4));
    expect(result.hits).toBe(3);
    expect(result.retainedEntries).toBe(1);
    expect(result.microsPerCall).toBeGreaterThan(0);
  });
});
