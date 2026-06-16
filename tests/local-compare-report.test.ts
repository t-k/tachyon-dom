import { describe, expect, it } from "vitest";
import {
  compareSummaries,
  formatComparisonTable,
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
});
