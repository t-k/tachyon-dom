// @vitest-environment node
import { describe, expect, it } from "vitest";
import { runBrowserRepresentativeBenchmark } from "../benchmark/browser-representative";

describe("production browser representative benchmark", () => {
  it("runs all three paths with matching DOM and preserved keyed identity", async () => {
    const result = await runBrowserRepresentativeBenchmark({ iterations: 1, warmup: 0, itemCount: 8, childCount: 2 });

    expect(Object.keys(result.paths)).toEqual(["keyed-rows", "text-template", "mixed-template"]);
    for (const path of Object.values(result.paths)) {
      expect(path.samples).toHaveLength(1);
      expect(path.samples[0]?.create.syncUpdateMs).toBeGreaterThanOrEqual(0);
      expect(path.samples[0]?.create.settledUpdateMs).toBeGreaterThanOrEqual(path.samples[0]?.create.syncUpdateMs ?? 0);
      expect(path.samples[0]?.swap.preservedRowIdentities).toBe(path.samples[0]?.swap.rowCount);
      expect(path.samples[0]?.dispose.rowCount).toBe(0);
    }
    expect(result.paths["mixed-template"].samples[0]?.interaction).toEqual({
      inputValue: "typed",
      modelLabel: "typed",
      clickCount: 1,
      handlerRunsAfterDispose: 0,
    });
    expect(result.paths["text-template"].bundleBrotliBytes).toBeGreaterThan(0);
    expect(result.paths["mixed-template"].bundleBrotliBytes).toBeGreaterThan(0);
  }, 60_000);
});
