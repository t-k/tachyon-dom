import { describe, expect, it } from "vitest";
import {
  buildScenarioMatrix,
  compareSummaries,
  formatComparisonTable,
  formatScenarioMatrixTable,
  mean,
  median,
  summarizeScenario,
} from "../benchmark/local-compare/report";

describe("local compare report", () => {
  it("summarizes values with mean and median", () => {
    expect(mean([1, 2, 9])).toBe(4);
    expect(median([9, 1, 2])).toBe(2);
    expect(median([10, 2, 4, 8])).toBe(6);
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
        ratio: 1.5,
        deltaPercent: 50,
        baselineMedian: 12,
        candidateMedian: 18,
      },
    ]);
    expect(formatComparisonTable(rows)).toContain("| create rows | 12.00ms | 18.00ms | 1.500x | +50.0% |");
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
        fastestMean: 8,
        candidateRatioToFastest: 1.5,
      },
    ]);
    expect(formatScenarioMatrixTable(rows, implementations, "tachyon-dom")).toContain(
      "| create rows | 10.00ms | 8.00ms | 12.00ms | 1.500x |",
    );
  });
});
