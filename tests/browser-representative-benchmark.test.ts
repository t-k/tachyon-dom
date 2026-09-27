// @vitest-environment node
import { describe, expect, it } from "vitest";
import { runBrowserRepresentativeBenchmark } from "../benchmark/browser-representative";

describe("production browser representative benchmark", () => {
  it("runs all three paths with matching DOM and preserved keyed identity", async () => {
    const result = await runBrowserRepresentativeBenchmark({ iterations: 1, warmup: 0, itemCount: 8, childCount: 2 });

    expect(Object.keys(result.paths)).toEqual(["keyed-rows", "text-template", "mixed-template"]);
    expect(result.controls).toEqual({ iterations: 1, warmup: 0, itemCount: 8, childCount: 2 });
    expect(result.provenance.commit).toMatch(/^[a-f0-9]{40}$/);
    for (const path of Object.values(result.paths)) {
      expect(path.samples).toHaveLength(1);
      expect(path.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(path.samples[0]?.create.syncUpdateMs).toBeGreaterThanOrEqual(0);
      expect(path.samples[0]?.create.settledUpdateMs).toBeGreaterThanOrEqual(path.samples[0]?.create.syncUpdateMs ?? 0);
      expect(path.samples[0]?.swap.preservedRowIdentities).toBe(path.samples[0]?.swap.rowCount);
      expect(path.samples[0]?.noChange.preservedRowIdentities).toBe(path.samples[0]?.noChange.rowCount);
      expect(path.samples[0]?.mutableOnePercent.preservedRowIdentities).toBe(
        path.samples[0]?.mutableOnePercent.rowCount,
      );
      expect(path.samples[0]?.sparseOnePercent.rowCount).toBe(path.samples[0]?.noChange.rowCount);
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

  it("records GC-separated heap and all DOM node types outside the timed samples", async () => {
    const result = await runBrowserRepresentativeBenchmark({
      iterations: 1,
      warmup: 0,
      itemCount: 8,
      childCount: 1,
      memoryDiagnostics: true,
      memoryCycles: 3,
    });

    for (const path of Object.values(result.paths)) {
      expect(path.memory?.mountedHeapBytes).toBeGreaterThan(0);
      expect(path.memory?.mountedNodes.elements).toBeGreaterThan(path.memory?.baselineNodes.elements ?? 0);
      expect(path.memory?.mountedNodes.text).toBeGreaterThan(0);
      expect(path.memory?.mountedNodes.comments).toBeGreaterThanOrEqual(0);
      expect(path.memory?.disposedNodes.elements).toBe(path.memory?.baselineNodes.elements);
      expect(path.memory?.repeatedDisposedNodes).toEqual(path.memory?.disposedNodes);
      expect(path.memory?.repeatedDisposedHeapBytes).toBeGreaterThan(0);
      expect(path.memory?.cycles).toBe(3);
      expect(path.memory?.checkpoints.map((checkpoint) => checkpoint.cycle)).toEqual([1, 2, 3]);
    }
  }, 60_000);
});
