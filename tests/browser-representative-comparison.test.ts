// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  compareBrowserRepresentativeRuns,
  type BrowserRepresentativePair,
} from "../benchmark/browser-representative-compare";
import type {
  BrowserOperation,
  BrowserRepresentativeResult,
  BrowserRepresentativeSample,
} from "../benchmark/browser-representative";

const operation = (syncUpdateMs: number): BrowserOperation => ({
  syncUpdateMs,
  settledUpdateMs: syncUpdateMs + 32,
  rowCount: 100,
  preservedRowIdentities: 100,
  preservedChildIdentities: 200,
});

const sample = (syncUpdateMs: number): BrowserRepresentativeSample => ({
  coldImportMs: syncUpdateMs,
  create: operation(syncUpdateMs),
  append: operation(syncUpdateMs),
  partialUpdate: operation(syncUpdateMs),
  noChange: operation(syncUpdateMs),
  sparseOnePercent: operation(syncUpdateMs),
  sparseTenPercent: operation(syncUpdateMs),
  fullValueUpdate: operation(syncUpdateMs),
  mutableOnePercent: operation(syncUpdateMs),
  swap: operation(syncUpdateMs),
  remove: operation(syncUpdateMs),
  childReorder: operation(syncUpdateMs),
  childEmpty: operation(syncUpdateMs),
  dispose: operation(syncUpdateMs),
});

const run = (commit: string, runId: string, duration: number): BrowserRepresentativeResult => ({
  runId,
  capturedAt: "2026-09-27T00:00:00.000Z",
  measurementMode: "production-browser",
  sampleContract: "fresh-page-cold-import-first-mount-and-warm-operations",
  controls: { iterations: 2, warmup: 1, itemCount: 100, childCount: 2 },
  provenance: {
    commit,
    dirty: false,
    node: "v24.14.0",
    platform: "darwin",
    architecture: "arm64",
    cpuModel: "test CPU",
    esbuild: "0.28.1",
  },
  browserVersion: "test Chromium",
  paths: {
    "keyed-rows": {
      bundleBrotliBytes: 1000,
      bundleSha256: "a".repeat(64),
      samples: [sample(duration), sample(duration)],
    },
    "text-template": {
      bundleBrotliBytes: 2000,
      bundleSha256: "b".repeat(64),
      samples: [sample(duration), sample(duration)],
    },
    "mixed-template": {
      bundleBrotliBytes: 3000,
      bundleSha256: "c".repeat(64),
      samples: [sample(duration), sample(duration)],
    },
  },
});

describe("production browser base/head comparison", () => {
  it("compares each process once per operation and keeps size separate", () => {
    const pairs: BrowserRepresentativePair[] = Array.from({ length: 5 }, (_, index) => ({
      base: run("a".repeat(40), `base-${index}`, 10),
      head: run("b".repeat(40), `head-${index}`, 9),
    }));
    const report = compareBrowserRepresentativeRuns(pairs);

    expect(report.pairCount).toBe(5);
    expect(report.paths["text-template"].operations.noChange.sync.medianRatio).toBeCloseTo(0.9);
    expect(report.paths["text-template"].operations.noChange.sync.status).toBe("meaningful-win");
    expect(report.paths["text-template"].bundleBrotliBytes).toEqual({ base: 2000, head: 2000 });
  });

  it("rejects duplicate processes, dirty input, and changed workload or browser", () => {
    const base = run("a".repeat(40), "same-run", 10);
    const head = run("b".repeat(40), "same-run", 9);
    expect(() => compareBrowserRepresentativeRuns([{ base, head }])).toThrow(/duplicate runId/);

    head.runId = "different-run";
    head.provenance.dirty = true;
    expect(() => compareBrowserRepresentativeRuns([{ base, head }])).toThrow(/dirty/);

    head.provenance.dirty = false;
    head.controls.itemCount = 1000;
    expect(() => compareBrowserRepresentativeRuns([{ base, head }])).toThrow(/controls/);

    head.controls.itemCount = 100;
    head.browserVersion = "different Chromium";
    expect(() => compareBrowserRepresentativeRuns([{ base, head }])).toThrow(/browserVersion/);
  });

  it("does not call one process an authoritative result", () => {
    const report = compareBrowserRepresentativeRuns(
      [{ base: run("a".repeat(40), "base", 10), head: run("b".repeat(40), "head", 8) }],
      { allowDirty: true },
    );
    expect(report.paths["mixed-template"].operations.partialUpdate.sync.status).toBe("inconclusive");
  });

  it("rejects counter-mode timings from the production comparison", () => {
    const base = run("a".repeat(40), "base", 10);
    const head = run("b".repeat(40), "head", 9);
    head.measurementMode = "counter-browser";
    expect(() => compareBrowserRepresentativeRuns([{ base, head }])).toThrow(/Incompatible browser representative contract/);
  });
});
