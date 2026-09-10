import { describe, expect, it } from "vitest";
import {
  analyzeWebStreamRuns,
  formatWebFrameworkRanking,
  scoreWebFrameworkMetrics,
} from "../benchmark/web-framework/report";
import { createWebRunPlan } from "../benchmark/web-framework/workload";
import { attachArtifactManifest } from "../benchmark/shared/artifact-manifest";

describe("web framework benchmark report", () => {
  it("analyzes stream completion ratios across independent contract-v4 runs", () => {
    const samples = Array.from({ length: 20 }, () => ({
      ttfb: 1,
      complete: 21,
      chunkArrivalMs: [1, 21],
    }));
    const frameworks = ["tachyon-dom", "one", "two", "three", "four", "five"];
    const unsignedRuns = Array.from({ length: 12 }, (_, runIndex) => ({
      benchmark: { contractVersion: 5 },
      provenance: {
        git: { commit: "commit", dirty: false, workingTreeSha256: "tree" },
        runtime: { node: "v24", platform: "linux", arch: "x64", osRelease: "test" },
        host: { hostname: "host", cpuModel: "cpu", logicalCpuCount: 8 },
        browser: { name: "chromium", version: "149" },
        dependencies: { playwright: { version: "1" } },
      },
      workload: {
        runId: `run-${runIndex}`,
        runIndex,
        seed: 11,
        frameworkOrder: createWebRunPlan(frameworks, { runId: `run-${runIndex}`, runIndex, seed: 11 }).frameworkOrder,
        smoke: false,
        buildMode: "production",
        durationSeconds: 5,
        connections: 30,
        streamMinimumChunkGapMs: 10,
        frameworks: frameworks.map((name) => ({ name })),
      },
      measurements: {
        metrics: [
          { framework: "tachyon-dom", streamCompleteMs: 19.8, streamWarmups: 5, streamSamples: samples },
          ...frameworks.slice(1).map((framework) => ({
            framework,
            streamCompleteMs: 20,
            streamWarmups: 5,
            streamSamples: samples,
          })),
        ],
      },
    }));
    const signRuns = <T extends Record<string, unknown>>(values: T[]) =>
      values.map((value, index) =>
        attachArtifactManifest(value, {
          pid: 2_000 + index,
          processStartedAt: new Date(index * 1_000).toISOString(),
        }),
      );
    const runs = signRuns(unsignedRuns);
    expect(analyzeWebStreamRuns(runs, { seed: 7, resamples: 1_000 })).toMatchObject({
      ok: false,
      reasons: expect.arrayContaining([expect.stringContaining("stream summary mismatch")]),
    });

    const consistentValues = structuredClone(unsignedRuns);
    for (const run of consistentValues) {
      for (const metric of run.measurements.metrics) metric.streamCompleteMs = 21;
    }
    const consistent = signRuns(consistentValues);
    expect(analyzeWebStreamRuns(consistent, { seed: 7, resamples: 1_000 })).toMatchObject({
      ok: true,
      ratios: Array(12).fill(1),
      analysis: { status: "tie-or-loss", independentRunCount: 12 },
    });

    const incompatible = structuredClone(runs);
    incompatible[1]!.provenance.host.cpuModel = "other cpu";
    expect(analyzeWebStreamRuns(incompatible, { seed: 7, resamples: 1_000 })).toMatchObject({ ok: false });

    const invalidSamples = structuredClone(runs);
    invalidSamples[2]!.measurements.metrics[0]!.streamSamples[0]!.chunkArrivalMs = [1, 5];
    expect(analyzeWebStreamRuns(invalidSamples, { seed: 7, resamples: 1_000 })).toMatchObject({ ok: false });

    const missingDirtyValues = structuredClone(consistentValues);
    for (const run of missingDirtyValues) delete (run.provenance.git as { dirty?: boolean }).dirty;
    expect(analyzeWebStreamRuns(signRuns(missingDirtyValues), { seed: 7, resamples: 1_000 })).toMatchObject({
      ok: false,
    });

    const missingMetricValues = structuredClone(consistentValues);
    for (const run of missingMetricValues) run.measurements.metrics.pop();
    expect(analyzeWebStreamRuns(signRuns(missingMetricValues), { seed: 7, resamples: 1_000 })).toMatchObject({
      ok: false,
    });

    const duplicateMetricValues = structuredClone(consistentValues);
    for (const run of duplicateMetricValues)
      run.measurements.metrics.push(structuredClone(run.measurements.metrics[0]!));
    expect(analyzeWebStreamRuns(signRuns(duplicateMetricValues), { seed: 7, resamples: 1_000 })).toMatchObject({
      ok: false,
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
