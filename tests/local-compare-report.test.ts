import { describe, expect, it } from "vitest";
import {
  buildAuxiliaryMetricMatrix,
  buildScenarioMatrix,
  compareSummaries,
  evaluateBenchmarkRegressionGate,
  formatAuxiliaryMetricTable,
  formatComparisonTable,
  formatGeomeanComparisonTable,
  formatScenarioMatrixTable,
  geomeanComparison,
  mean,
  median,
  relativeStandardDeviation,
  standardDeviation,
  percentile,
  summarizeAuxiliaryMetric,
  summarizeScenario,
  trimmedMean,
} from "../benchmark/local-compare/report";
import { buildAuthoritativeScenarioRows } from "../benchmark/local-compare/aggregate-report";

describe("local compare report", () => {
  it("reports a confidence-bounded stable scenario win from independent runs", () => {
    const runs = Array.from({ length: 5 }, () => ({
      workload: { candidate: "tachyon-dom", implementations: ["competitor", "tachyon-dom"], trimFraction: 0.2 },
      measurements: {
        summaries: [
          { id: "createRows", label: "create rows", implementation: "competitor", trimmedMean: 10, values: Array(30).fill(10) },
          { id: "createRows", label: "create rows", implementation: "tachyon-dom", trimmedMean: 9.8, values: Array(30).fill(9.8) },
        ],
      },
    }));

    expect(buildAuthoritativeScenarioRows(runs, { seed: 7, resamples: 1_000 })).toEqual([
      {
        id: "createRows",
        label: "create rows",
        status: "meaningful-win",
        medianRatio: 0.98,
        oneSided95UpperBound: 0.98,
        independentRunCount: 5,
        sampleCountPerRun: 30,
      },
    ]);
  });

  it("derives authority ratios from raw values instead of forged summaries", () => {
    const runs = Array.from({ length: 5 }, () => ({
      workload: { candidate: "tachyon-dom", implementations: ["competitor", "tachyon-dom"], trimFraction: 0.2 },
      measurements: {
        summaries: [
          { id: "createRows", label: "create rows", implementation: "competitor", trimmedMean: 20, values: Array(30).fill(20) },
          { id: "createRows", label: "create rows", implementation: "tachyon-dom", trimmedMean: 9, values: Array(30).fill(21) },
        ],
      },
    }));

    expect(buildAuthoritativeScenarioRows(runs, { seed: 7, resamples: 1_000 })[0]).toMatchObject({
      medianRatio: 1.05,
      status: "tie-or-loss",
    });
  });

  it("summarizes values with mean and median", () => {
    expect(mean([1, 2, 9])).toBe(4);
    expect(median([9, 1, 2])).toBe(2);
    expect(median([10, 2, 4, 8])).toBe(6);
    expect(percentile([10, 1, 4, 8, 20], 95)).toBe(20);
    expect(trimmedMean([10, 10, 11, 12, 200])).toBe(11);
    expect(standardDeviation([10, 10, 10])).toBe(0);
    expect(relativeStandardDeviation([10, 10, 10])).toBe(0);
  });

  it("compares Tachyon DOM against the vanillajs-lite baseline", () => {
    const baseline = summarizeScenario("createRows", "create rows", "vanillajs-lite-keyed", [10, 12, 14]);
    const candidate = summarizeScenario("createRows", "create rows", "tachyon-dom", [15, 18, 21]);

    const rows = compareSummaries([baseline, candidate], "vanillajs-lite-keyed", "tachyon-dom");

    expect(rows).toEqual([
      {
        id: "createRows",
        label: "create rows",
        baseline: "vanillajs-lite-keyed",
        candidate: "tachyon-dom",
        baselineMean: 12,
        candidateMean: 18,
        baselineTrimmedMean: 12,
        candidateTrimmedMean: 18,
        ratio: 1.5,
        trimmedRatio: 1.5,
        deltaPercent: 50,
        baselineMedian: 12,
        candidateMedian: 18,
      },
    ]);
    expect(formatComparisonTable(rows)).toContain("| create rows | 12.00ms | 18.00ms | 1.500x | +50.0% |");
  });

  it("summarizes mean and median geomean ratios for direct baseline comparisons", () => {
    const rows = [
      {
        id: "createRows",
        label: "create rows",
        baseline: "solid-keyed",
        candidate: "tachyon-dom",
        baselineMean: 10,
        candidateMean: 5,
        baselineTrimmedMean: 10,
        candidateTrimmedMean: 5,
        ratio: 0.5,
        trimmedRatio: 0.5,
        deltaPercent: -50,
        baselineMedian: 8,
        candidateMedian: 4,
      },
      {
        id: "clearRows",
        label: "clear rows",
        baseline: "solid-keyed",
        candidate: "tachyon-dom",
        baselineMean: 10,
        candidateMean: 20,
        baselineTrimmedMean: 10,
        candidateTrimmedMean: 20,
        ratio: 2,
        trimmedRatio: 2,
        deltaPercent: 100,
        baselineMedian: 8,
        candidateMedian: 16,
      },
    ];

    const summary = geomeanComparison(rows);

    expect(summary).toEqual({
      baseline: "solid-keyed",
      candidate: "tachyon-dom",
      meanGeomeanRatio: 1,
      medianGeomeanRatio: 1,
      trimmedGeomeanRatio: 1,
      losses: ["clear rows 2.000x"],
    });
    expect(formatGeomeanComparisonTable([summary])).toContain(
      "| solid-keyed | tachyon-dom | 1.000x | 1.000x | 1.000x | clear rows 2.000x |",
    );
  });

  it("builds a multi-implementation scenario matrix", () => {
    const summaries = [
      summarizeScenario("createRows", "create rows", "vanillajs-lite-keyed", [10]),
      summarizeScenario("createRows", "create rows", "vanillajs-3-keyed", [8]),
      summarizeScenario("createRows", "create rows", "tachyon-dom", [12]),
    ];
    const implementations = ["vanillajs-lite-keyed", "vanillajs-3-keyed", "tachyon-dom"];

    const rows = buildScenarioMatrix(summaries, implementations, "tachyon-dom");

    expect(rows).toEqual([
      {
        id: "createRows",
        label: "create rows",
        means: {
          "tachyon-dom": 12,
          "vanillajs-3-keyed": 8,
          "vanillajs-lite-keyed": 10,
        },
        relativeStandardDeviations: {
          "tachyon-dom": 0,
          "vanillajs-3-keyed": 0,
          "vanillajs-lite-keyed": 0,
        },
        trimmedMeans: {
          "tachyon-dom": 12,
          "vanillajs-3-keyed": 8,
          "vanillajs-lite-keyed": 10,
        },
        fastestMean: 8,
        fastestTrimmedMean: 8,
        candidateRatioToFastest: 1.5,
        candidateTrimmedRatioToFastest: 1.5,
      },
    ]);
    expect(formatScenarioMatrixTable(rows, implementations, "tachyon-dom")).toContain(
      "| create rows | 10.00ms | 8.00ms | 12.00ms | 1.500x | 0.0% |",
    );
  });

  it("builds an auxiliary metric matrix", () => {
    const summaries = [
      summarizeAuxiliaryMetric("readyHeap", "ready JS heap", "mb", "vanillajs-lite-keyed", 3),
      summarizeAuxiliaryMetric("readyHeap", "ready JS heap", "mb", "vanillajs-3-keyed", 2),
      summarizeAuxiliaryMetric("readyHeap", "ready JS heap", "mb", "tachyon-dom", 4),
    ];
    const implementations = ["vanillajs-lite-keyed", "vanillajs-3-keyed", "tachyon-dom"];

    const rows = buildAuxiliaryMetricMatrix(summaries, implementations, "tachyon-dom");

    expect(rows).toEqual([
      {
        id: "readyHeap",
        label: "ready JS heap",
        unit: "mb",
        values: {
          "tachyon-dom": 4,
          "vanillajs-3-keyed": 2,
          "vanillajs-lite-keyed": 3,
        },
        bestValue: 2,
        candidateRatioToBest: 2,
      },
    ]);
    expect(formatAuxiliaryMetricTable(rows, implementations, "tachyon-dom")).toContain(
      "| ready JS heap | 3.00MB | 2.00MB | 4.00MB | 2.000x |",
    );
  });

  it("evaluates benchmark regression thresholds", () => {
    const operationRows = [
      {
        id: "createRows",
        label: "create rows",
        baseline: "vanillajs-lite-keyed",
        candidate: "tachyon-dom",
        baselineMean: 10,
        candidateMean: 12,
        baselineTrimmedMean: 10,
        candidateTrimmedMean: 12,
        ratio: 1.2,
        trimmedRatio: 1.2,
        deltaPercent: 20,
        baselineMedian: 10,
        candidateMedian: 12,
      },
      {
        id: "swapRows",
        label: "swap rows",
        baseline: "vanillajs-lite-keyed",
        candidate: "tachyon-dom",
        baselineMean: 10,
        candidateMean: 18,
        baselineTrimmedMean: 10,
        candidateTrimmedMean: 18,
        ratio: 1.8,
        trimmedRatio: 1.8,
        deltaPercent: 80,
        baselineMedian: 10,
        candidateMedian: 18,
      },
    ];
    const auxiliaryRows = [
      {
        id: "readyHeap",
        label: "ready JS heap",
        unit: "mb" as const,
        values: { "tachyon-dom": 4, "vanillajs-lite-keyed": 2 },
        bestValue: 2,
        candidateRatioToBest: 2,
      },
    ];

    expect(
      evaluateBenchmarkRegressionGate(operationRows, auxiliaryRows, { maxGeomeanRatio: 1.5, maxMemoryRatio: 2 }),
    ).toEqual({
      ok: true,
      geomeanRatio: Math.sqrt(1.2 * 1.8),
      maxMemoryRatio: 2,
      failures: [],
    });
    expect(
      evaluateBenchmarkRegressionGate(operationRows, auxiliaryRows, { maxGeomeanRatio: 1.4, maxMemoryRatio: 1.5 }),
    ).toEqual({
      ok: false,
      geomeanRatio: Math.sqrt(1.2 * 1.8),
      maxMemoryRatio: 2,
      failures: ["geomean ratio 1.470x exceeds 1.400x", "memory ratio 2.000x exceeds 1.500x"],
    });
  });
});
