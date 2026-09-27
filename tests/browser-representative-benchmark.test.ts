// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runBrowserRepresentativeBenchmark } from "../benchmark/browser-representative";

describe("production browser representative benchmark", () => {
  it("runs all three paths with matching DOM and preserved keyed identity", async () => {
    const result = await runBrowserRepresentativeBenchmark({ iterations: 1, warmup: 0, itemCount: 8, childCount: 2 });

    expect(Object.keys(result.paths)).toEqual(["keyed-rows", "text-template", "mixed-template"]);
    expect(result.runId).toMatch(/^[a-f0-9-]{36}$/);
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

  it("records operation counts in a separate production-policy counter build", async () => {
    const result = await runBrowserRepresentativeBenchmark({
      iterations: 1,
      warmup: 0,
      itemCount: 8,
      childCount: 1,
      counterDiagnostics: true,
    });

    expect(result.measurementMode).toBe("counter-browser");
    expect(result.paths["text-template"].samples[0]?.noChange.counters?.rowsVisited).toBe(20);
    expect(result.paths["text-template"].samples[0]?.noChange.counters?.rowsCreated ?? 0).toBe(0);
    expect(result.paths["text-template"].samples[0]?.noChange.counters?.structuralNodesVisited ?? 0).toBe(0);
    expect(result.paths["text-template"].samples[0]?.sparseOnePercent.counters?.targetResolutions ?? 0).toBe(0);
    expect(result.paths["mixed-template"].samples[0]?.create.counters?.bindingEvaluations).toBeGreaterThan(0);
    expect(result.paths["mixed-template"].samples[0]?.remove.counters?.rowsRemoved).toBeGreaterThan(0);
    expect(result.paths["keyed-rows"].samples[0]?.create.counters?.rowsVisited ?? 0).toBe(0);
  }, 60_000);

  it("captures main-thread task, style/layout, and paint events in an unscored trace run", async () => {
    const traceDirectory = await mkdtemp(path.join(tmpdir(), "tachyon-template-trace-"));
    try {
      const result = await runBrowserRepresentativeBenchmark({
        iterations: 1,
        warmup: 0,
        itemCount: 8,
        childCount: 1,
        traceDiagnostics: true,
        traceDirectory,
      });
      for (const pathResult of Object.values(result.paths)) {
        expect(pathResult.samples).toHaveLength(1);
        expect(pathResult.trace?.contract).toBe("unscored-cdp-main-thread-event-union");
        expect(pathResult.trace?.operations.noChange.mainThreadTaskMs).toBeGreaterThanOrEqual(0);
        expect(pathResult.trace?.operations.noChange.scriptEventMs).toBeGreaterThanOrEqual(0);
        expect(pathResult.trace?.operations.noChange.styleLayoutMs).toBeGreaterThanOrEqual(0);
        expect(pathResult.trace?.operations.noChange.paintMs).toBeGreaterThanOrEqual(0);
        expect((await readFile(pathResult.trace?.artifactPath ?? "", "utf8")).includes("tachyon:noChange:start")).toBe(
          true,
        );
      }
    } finally {
      await rm(traceDirectory, { recursive: true, force: true });
    }
  }, 60_000);
});
