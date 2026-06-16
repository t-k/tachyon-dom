export type ImplementationName = "tachyon-dom" | "vanillajs-lite-keyed";

export type ScenarioSummary = {
  id: string;
  label: string;
  implementation: ImplementationName;
  values: readonly number[];
  mean: number;
  median: number;
};

export type ComparisonRow = {
  id: string;
  label: string;
  baselineMean: number;
  candidateMean: number;
  ratio: number;
  deltaPercent: number;
  baselineMedian: number;
  candidateMedian: number;
};

export const mean = (values: readonly number[]): number => {
  if (values.length === 0) {
    return Number.NaN;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
};

export const median = (values: readonly number[]): number => {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] as number;
  }
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
};

export const summarizeScenario = (
  id: string,
  label: string,
  implementation: ImplementationName,
  values: readonly number[],
): ScenarioSummary => ({
  id,
  label,
  implementation,
  values,
  mean: mean(values),
  median: median(values),
});

export const compareSummaries = (
  summaries: readonly ScenarioSummary[],
  baseline: ImplementationName,
  candidate: ImplementationName,
): ComparisonRow[] => {
  const rows: ComparisonRow[] = [];
  const byKey = new Map(summaries.map((summary) => [`${summary.implementation}:${summary.id}`, summary]));
  const candidateSummaries = summaries.filter((summary) => summary.implementation === candidate);

  for (const candidateSummary of candidateSummaries) {
    const baselineSummary = byKey.get(`${baseline}:${candidateSummary.id}`);
    if (!baselineSummary) {
      continue;
    }
    const ratio = candidateSummary.mean / baselineSummary.mean;
    rows.push({
      id: candidateSummary.id,
      label: candidateSummary.label,
      baselineMean: baselineSummary.mean,
      candidateMean: candidateSummary.mean,
      ratio,
      deltaPercent: (ratio - 1) * 100,
      baselineMedian: baselineSummary.median,
      candidateMedian: candidateSummary.median,
    });
  }

  return rows;
};

const formatMilliseconds = (value: number): string => `${value.toFixed(2)}ms`;

const formatPercent = (value: number): string => `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;

export const formatComparisonTable = (rows: readonly ComparisonRow[]): string => {
  const lines = ["| Scenario | vanillajs-lite mean | Tachyon DOM mean | Ratio | Delta |", "|---|---:|---:|---:|---:|"];
  for (const row of rows) {
    lines.push(
      `| ${row.label} | ${formatMilliseconds(row.baselineMean)} | ${formatMilliseconds(row.candidateMean)} | ${row.ratio.toFixed(3)}x | ${formatPercent(row.deltaPercent)} |`,
    );
  }
  return lines.join("\n");
};
