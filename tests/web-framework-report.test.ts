import { describe, expect, it } from "vitest";
import {
  analyzeWebStreamRuns,
  formatWebFrameworkRanking,
  scoreWebFrameworkMetrics,
} from "../benchmark/web-framework/report";

describe("web framework benchmark report", () => {
  it("analyzes stream completion ratios across independent contract-v4 runs", () => {
    const runs = Array.from({ length: 5 }, (_, runIndex) => ({
      benchmark: { contractVersion: 4 },
      provenance: { git: { dirty: false } },
      workload: { runId: `run-${runIndex}`, frameworkOrder: runIndex % 2 ? ["other", "tachyon-dom"] : ["tachyon-dom", "other"] },
      measurements: {
        metrics: [
          { framework: "tachyon-dom", streamCompleteMs: 19.8, streamWarmups: 5, streamSamples: Array(20).fill({}) },
          { framework: "other", streamCompleteMs: 20, streamWarmups: 5, streamSamples: Array(20).fill({}) },
        ],
      },
    }));
    expect(analyzeWebStreamRuns(runs, { seed: 7, resamples: 1_000 })).toMatchObject({
      ok: true,
      analysis: { status: "meaningful-win", independentRunCount: 5 },
    });
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
