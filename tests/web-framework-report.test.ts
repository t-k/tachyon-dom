import { describe, expect, it } from "vitest";
import {
  analyzeWebStreamRuns,
  formatWebFrameworkRanking,
  scoreWebFrameworkMetrics,
} from "../benchmark/web-framework/report";

describe("web framework benchmark report", () => {
  it("analyzes stream completion ratios across independent contract-v4 runs", () => {
    const samples = Array.from({ length: 20 }, () => ({
      ttfb: 1,
      complete: 21,
      chunkArrivalMs: [1, 21],
    }));
    const runs = Array.from({ length: 5 }, (_, runIndex) => ({
      benchmark: { contractVersion: 4 },
      provenance: {
        git: { commit: "commit", dirty: false, workingTreeSha256: "tree" },
        runtime: { node: "v24", platform: "linux", arch: "x64", osRelease: "test" },
        host: { hostname: "host", cpuModel: "cpu", logicalCpuCount: 8 },
        browser: { name: "chromium", version: "149" },
        dependencies: { playwright: { version: "1" } },
      },
      workload: {
        runId: `run-${runIndex}`,
        frameworkOrder: runIndex % 2 ? ["other", "tachyon-dom"] : ["tachyon-dom", "other"],
        smoke: false,
        buildMode: "production",
        durationSeconds: 5,
        connections: 30,
        streamMinimumChunkGapMs: 10,
        frameworks: ["tachyon-dom", "other"],
      },
      measurements: {
        metrics: [
          { framework: "tachyon-dom", streamCompleteMs: 19.8, streamWarmups: 5, streamSamples: samples },
          { framework: "other", streamCompleteMs: 20, streamWarmups: 5, streamSamples: samples },
        ],
      },
    }));
    expect(analyzeWebStreamRuns(runs, { seed: 7, resamples: 1_000 })).toMatchObject({
      ok: true,
      analysis: { status: "meaningful-win", independentRunCount: 5 },
    });

    const incompatible = structuredClone(runs);
    incompatible[1]!.provenance.host.cpuModel = "other cpu";
    expect(analyzeWebStreamRuns(incompatible, { seed: 7, resamples: 1_000 })).toMatchObject({ ok: false });

    const invalidSamples = structuredClone(runs);
    invalidSamples[2]!.measurements.metrics[0]!.streamSamples[0]!.chunkArrivalMs = [1, 5];
    expect(analyzeWebStreamRuns(invalidSamples, { seed: 7, resamples: 1_000 })).toMatchObject({ ok: false });
  });

  it("ranks frameworks by normalized throughput and latency geomean", () => {
    const rows = scoreWebFrameworkMetrics([
      {
        framework: "slow",
        staticRequestsPerSecond: 100,
        staticLatencyP95Ms: 20,
        dynamicRequestsPerSecond: 100,
        dynamicLatencyP95Ms: 20,
        streamTtfbMs: 20,
        streamCompleteMs: 40,
        streamWarmups: 5,
        streamSamples: [],
        clientNavigationMs: 20,
        clientBundleBytes: 20_480,
      },
      {
        framework: "fast",
        staticRequestsPerSecond: 200,
        staticLatencyP95Ms: 10,
        dynamicRequestsPerSecond: 200,
        dynamicLatencyP95Ms: 10,
        streamTtfbMs: 10,
        streamCompleteMs: 20,
        streamWarmups: 5,
        streamSamples: [],
        clientNavigationMs: 10,
        clientBundleBytes: 10_240,
      },
    ]);

    expect(rows[0]?.framework).toBe("fast");
    expect(rows[0]?.rank).toBe(1);
    expect(rows[0]?.score).toBe(1);
    expect(rows[1]?.score).toBeGreaterThan(1);
    expect(formatWebFrameworkRanking(rows)).toContain("| 1 | fast | 1.000x |");
    expect(formatWebFrameworkRanking(rows)).toContain("10.0KiB");
  });
});
