export type ImplementationName = string;

export type ScenarioSummary = {
  id: string;
  label: string;
  implementation: ImplementationName;
  values: readonly number[];
  mean: number;
  median: number;
  min: number;
  max: number;
  p95: number;
};

export type ComparisonRow = {
  id: string;
  label: string;
  baseline: ImplementationName;
  candidate: ImplementationName;
  baselineMean: number;
  candidateMean: number;
  ratio: number;
  deltaPercent: number;
  baselineMedian: number;
  candidateMedian: number;
};

export type ScenarioMatrixRow = {
  id: string;
  label: string;
  means: Record<ImplementationName, number>;
  fastestMean: number;
  candidateRatioToFastest: number;
};

export type AuxiliaryMetricUnit = "ms" | "mb" | "count" | "kib";

export type AuxiliaryMetricSummary = {
  id: string;
  label: string;
  unit: AuxiliaryMetricUnit;
  implementation: ImplementationName;
  value: number;
};

export type AuxiliaryMetricMatrixRow = {
  id: string;
  label: string;
  unit: AuxiliaryMetricUnit;
  values: Record<ImplementationName, number>;
  bestValue: number;
  candidateRatioToBest: number;
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

export const percentile = (values: readonly number[], percentileValue: number): number => {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1));
  return sorted[index] as number;
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
  min: values.length === 0 ? Number.NaN : Math.min(...values),
  max: values.length === 0 ? Number.NaN : Math.max(...values),
  p95: percentile(values, 95),
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
      baseline,
      candidate,
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

export const buildScenarioMatrix = (
  summaries: readonly ScenarioSummary[],
  implementations: readonly ImplementationName[],
  candidate: ImplementationName,
): ScenarioMatrixRow[] => {
  const byKey = new Map(summaries.map((summary) => [`${summary.implementation}:${summary.id}`, summary]));
  const scenarioOrder = summaries
    .filter((summary) => summary.implementation === candidate)
    .map((summary) => ({ id: summary.id, label: summary.label }));

  return scenarioOrder.map((scenario) => {
    const means: Record<ImplementationName, number> = {};
    for (const implementation of implementations) {
      means[implementation] = byKey.get(`${implementation}:${scenario.id}`)?.mean ?? Number.NaN;
    }
    const fastestMean = Math.min(...Object.values(means).filter(Number.isFinite));
    const candidateMean = means[candidate] ?? Number.NaN;
    return {
      ...scenario,
      means,
      fastestMean,
      candidateRatioToFastest: candidateMean / fastestMean,
    };
  });
};

export const summarizeAuxiliaryMetric = (
  id: string,
  label: string,
  unit: AuxiliaryMetricUnit,
  implementation: ImplementationName,
  value: number,
): AuxiliaryMetricSummary => ({
  id,
  label,
  unit,
  implementation,
  value,
});

export const buildAuxiliaryMetricMatrix = (
  summaries: readonly AuxiliaryMetricSummary[],
  implementations: readonly ImplementationName[],
  candidate: ImplementationName,
): AuxiliaryMetricMatrixRow[] => {
  const byKey = new Map(summaries.map((summary) => [`${summary.implementation}:${summary.id}`, summary]));
  const metricOrder = summaries
    .filter((summary) => summary.implementation === candidate)
    .map((summary) => ({ id: summary.id, label: summary.label, unit: summary.unit }));

  return metricOrder.map((metric) => {
    const values: Record<ImplementationName, number> = {};
    for (const implementation of implementations) {
      values[implementation] = byKey.get(`${implementation}:${metric.id}`)?.value ?? Number.NaN;
    }
    const bestValue = Math.min(...Object.values(values).filter(Number.isFinite));
    const candidateValue = values[candidate] ?? Number.NaN;
    return {
      ...metric,
      values,
      bestValue,
      candidateRatioToBest: candidateValue / bestValue,
    };
  });
};

const formatMilliseconds = (value: number): string => `${value.toFixed(2)}ms`;

const formatPercent = (value: number): string => `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;

const formatMetricValue = (value: number, unit: AuxiliaryMetricUnit): string => {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  if (unit === "ms") {
    return formatMilliseconds(value);
  }
  if (unit === "mb") {
    return `${value.toFixed(2)}MB`;
  }
  if (unit === "kib") {
    return `${value.toFixed(2)}KiB`;
  }
  return `${Math.round(value)}`;
};

export const formatComparisonTable = (rows: readonly ComparisonRow[]): string => {
  const lines = ["| Scenario | Baseline | Candidate | Ratio | Delta |", "|---|---:|---:|---:|---:|"];
  for (const row of rows) {
    lines.push(
      `| ${row.label} | ${formatMilliseconds(row.baselineMean)} | ${formatMilliseconds(row.candidateMean)} | ${row.ratio.toFixed(3)}x | ${formatPercent(row.deltaPercent)} |`,
    );
  }
  return lines.join("\n");
};

export const formatScenarioMatrixTable = (
  rows: readonly ScenarioMatrixRow[],
  implementations: readonly ImplementationName[],
  candidate: ImplementationName,
): string => {
  const header = [
    "Scenario",
    ...implementations.map((implementation) => `${implementation} mean`),
    `${candidate} vs fastest`,
  ];
  const lines = [`| ${header.join(" | ")} |`, `|---${"|---:".repeat(implementations.length + 1)}|`];
  for (const row of rows) {
    lines.push(
      `| ${row.label} | ${implementations
        .map((implementation) => formatMilliseconds(row.means[implementation] ?? Number.NaN))
        .join(" | ")} | ${row.candidateRatioToFastest.toFixed(3)}x |`,
    );
  }
  return lines.join("\n");
};

export const formatAuxiliaryMetricTable = (
  rows: readonly AuxiliaryMetricMatrixRow[],
  implementations: readonly ImplementationName[],
  candidate: ImplementationName,
): string => {
  const header = ["Metric", ...implementations.map((implementation) => `${implementation}`), `${candidate} vs best`];
  const lines = [`| ${header.join(" | ")} |`, `|---${"|---:".repeat(implementations.length + 1)}|`];
  for (const row of rows) {
    lines.push(
      `| ${row.label} | ${implementations
        .map((implementation) => formatMetricValue(row.values[implementation] ?? Number.NaN, row.unit))
        .join(" | ")} | ${row.candidateRatioToBest.toFixed(3)}x |`,
    );
  }
  return lines.join("\n");
};
