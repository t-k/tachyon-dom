export type ImplementationName = string;

export type ScenarioSummary = {
  id: string;
  label: string;
  implementation: ImplementationName;
  values: readonly number[];
  mean: number;
  median: number;
  trimmedMean: number;
  standardDeviation: number;
  relativeStandardDeviation: number;
  medianAbsoluteDeviation: number;
  relativeMedianAbsoluteDeviation: number;
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
  baselineTrimmedMean: number;
  candidateTrimmedMean: number;
  ratio: number;
  trimmedRatio: number;
  deltaPercent: number;
  baselineMedian: number;
  candidateMedian: number;
};

export type ScenarioMatrixRow = {
  id: string;
  label: string;
  means: Record<ImplementationName, number>;
  trimmedMeans: Record<ImplementationName, number>;
  relativeStandardDeviations: Record<ImplementationName, number>;
  fastestMean: number;
  fastestTrimmedMean: number;
  candidateRatioToFastest: number;
  candidateTrimmedRatioToFastest: number;
};

export type GeomeanComparisonSummary = {
  baseline: ImplementationName;
  candidate: ImplementationName;
  meanGeomeanRatio: number;
  medianGeomeanRatio: number;
  trimmedGeomeanRatio: number;
  losses: readonly string[];
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

export type BenchmarkRegressionGateOptions = {
  maxGeomeanRatio?: number;
  maxMemoryRatio?: number;
};

export type BenchmarkRegressionGateResult = {
  ok: boolean;
  geomeanRatio: number;
  maxMemoryRatio: number;
  failures: string[];
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

export const trimmedMean = (values: readonly number[], trimFraction = 0.2): number => {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const trimCount = Math.floor(sorted.length * trimFraction);
  const first = trimCount;
  const last = sorted.length - trimCount;
  const trimmed = first < last ? sorted.slice(first, last) : sorted;
  return mean(trimmed);
};

export const standardDeviation = (values: readonly number[]): number => {
  if (values.length === 0) {
    return Number.NaN;
  }
  const average = mean(values);
  const variance = mean(values.map((value) => (value - average) ** 2));
  return Math.sqrt(variance);
};

export const relativeStandardDeviation = (values: readonly number[]): number => {
  const average = mean(values);
  if (!Number.isFinite(average) || average === 0) {
    return Number.NaN;
  }
  return (standardDeviation(values) / average) * 100;
};

export const medianAbsoluteDeviation = (values: readonly number[]): number => {
  if (values.length === 0) {
    return Number.NaN;
  }
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
};

export const relativeMedianAbsoluteDeviation = (values: readonly number[]): number => {
  const center = median(values);
  if (!Number.isFinite(center) || center === 0) {
    return Number.NaN;
  }
  return (medianAbsoluteDeviation(values) / center) * 100;
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
  trimmedMean: trimmedMean(values),
  standardDeviation: standardDeviation(values),
  relativeStandardDeviation: relativeStandardDeviation(values),
  medianAbsoluteDeviation: medianAbsoluteDeviation(values),
  relativeMedianAbsoluteDeviation: relativeMedianAbsoluteDeviation(values),
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
    const trimmedRatio = candidateSummary.trimmedMean / baselineSummary.trimmedMean;
    rows.push({
      id: candidateSummary.id,
      label: candidateSummary.label,
      baseline,
      candidate,
      baselineMean: baselineSummary.mean,
      candidateMean: candidateSummary.mean,
      baselineTrimmedMean: baselineSummary.trimmedMean,
      candidateTrimmedMean: candidateSummary.trimmedMean,
      ratio,
      trimmedRatio,
      deltaPercent: (ratio - 1) * 100,
      baselineMedian: baselineSummary.median,
      candidateMedian: candidateSummary.median,
    });
  }

  return rows;
};

const geomean = (values: readonly number[]): number => {
  if (values.length === 0) {
    return Number.NaN;
  }
  return Math.exp(values.reduce((total, value) => total + Math.log(value), 0) / values.length);
};

export const geomeanComparison = (rows: readonly ComparisonRow[]): GeomeanComparisonSummary => {
  const first = rows[0];
  const baseline = first?.baseline ?? "";
  const candidate = first?.candidate ?? "";
  return {
    baseline,
    candidate,
    meanGeomeanRatio: geomean(rows.map((row) => row.ratio)),
    medianGeomeanRatio: geomean(rows.map((row) => row.candidateMedian / row.baselineMedian)),
    trimmedGeomeanRatio: geomean(rows.map((row) => row.trimmedRatio)),
    losses: rows
      .filter((row) => row.trimmedRatio > 1)
      .map((row) => `${row.label} ${row.trimmedRatio.toFixed(3)}x`),
  };
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
    const trimmedMeans: Record<ImplementationName, number> = {};
    const relativeStandardDeviations: Record<ImplementationName, number> = {};
    for (const implementation of implementations) {
      const summary = byKey.get(`${implementation}:${scenario.id}`);
      means[implementation] = summary?.mean ?? Number.NaN;
      trimmedMeans[implementation] = summary?.trimmedMean ?? Number.NaN;
      relativeStandardDeviations[implementation] = summary?.relativeStandardDeviation ?? Number.NaN;
    }
    const fastestMean = Math.min(...Object.values(means).filter(Number.isFinite));
    const fastestTrimmedMean = Math.min(...Object.values(trimmedMeans).filter(Number.isFinite));
    const candidateMean = means[candidate] ?? Number.NaN;
    const candidateTrimmedMean = trimmedMeans[candidate] ?? Number.NaN;
    return {
      ...scenario,
      means,
      trimmedMeans,
      relativeStandardDeviations,
      fastestMean,
      fastestTrimmedMean,
      candidateRatioToFastest: candidateMean / fastestMean,
      candidateTrimmedRatioToFastest: candidateTrimmedMean / fastestTrimmedMean,
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

const formatUnsignedPercent = (value: number): string => `${value.toFixed(1)}%`;

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
  const lines = ["| Scenario | Baseline trimmed | Candidate trimmed | Ratio | Delta |", "|---|---:|---:|---:|---:|"];
  for (const row of rows) {
    const trimmedDeltaPercent = (row.trimmedRatio - 1) * 100;
    lines.push(
      `| ${row.label} | ${formatMilliseconds(row.baselineTrimmedMean)} | ${formatMilliseconds(row.candidateTrimmedMean)} | ${row.trimmedRatio.toFixed(3)}x | ${formatPercent(trimmedDeltaPercent)} |`,
    );
  }
  return lines.join("\n");
};

export const formatGeomeanComparisonTable = (summaries: readonly GeomeanComparisonSummary[]): string => {
  const lines = [
    "| Baseline | Candidate | Trimmed geomean | Mean geomean | Median geomean | Trimmed losses |",
    "|---|---|---:|---:|---:|---|",
  ];
  for (const summary of summaries) {
    lines.push(
      `| ${summary.baseline} | ${summary.candidate} | ${summary.trimmedGeomeanRatio.toFixed(3)}x | ${summary.meanGeomeanRatio.toFixed(3)}x | ${summary.medianGeomeanRatio.toFixed(3)}x | ${summary.losses.join(", ") || "none"} |`,
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
    ...implementations.map((implementation) => `${implementation} trimmed mean`),
    `${candidate} vs fastest`,
    `${candidate} RSD`,
  ];
  const lines = [`| ${header.join(" | ")} |`, `|---${"|---:".repeat(implementations.length + 2)}|`];
  for (const row of rows) {
    lines.push(
      `| ${row.label} | ${implementations
        .map((implementation) => formatMilliseconds(row.trimmedMeans[implementation] ?? Number.NaN))
        .join(" | ")} | ${row.candidateTrimmedRatioToFastest.toFixed(3)}x | ${formatUnsignedPercent(row.relativeStandardDeviations[candidate] ?? Number.NaN)} |`,
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

export const evaluateBenchmarkRegressionGate = (
  operationRows: readonly ComparisonRow[],
  auxiliaryRows: readonly AuxiliaryMetricMatrixRow[],
  options: BenchmarkRegressionGateOptions,
): BenchmarkRegressionGateResult => {
  const finiteRatios = operationRows
    .map((row) => row.trimmedRatio)
    .filter((ratio) => Number.isFinite(ratio) && ratio > 0);
  const geomeanRatio =
    finiteRatios.length === 0
      ? Number.NaN
      : Math.exp(finiteRatios.reduce((total, ratio) => total + Math.log(ratio), 0) / finiteRatios.length);
  const memoryRatios = auxiliaryRows
    .filter((row) => row.unit === "mb")
    .map((row) => row.candidateRatioToBest)
    .filter(Number.isFinite);
  const maxMemoryRatio = memoryRatios.length === 0 ? Number.NaN : Math.max(...memoryRatios);
  const failures: string[] = [];
  if (
    options.maxGeomeanRatio !== undefined &&
    Number.isFinite(geomeanRatio) &&
    geomeanRatio > options.maxGeomeanRatio
  ) {
    failures.push(`geomean ratio ${geomeanRatio.toFixed(3)}x exceeds ${options.maxGeomeanRatio.toFixed(3)}x`);
  }
  if (
    options.maxMemoryRatio !== undefined &&
    Number.isFinite(maxMemoryRatio) &&
    maxMemoryRatio > options.maxMemoryRatio
  ) {
    failures.push(`memory ratio ${maxMemoryRatio.toFixed(3)}x exceeds ${options.maxMemoryRatio.toFixed(3)}x`);
  }
  return {
    ok: failures.length === 0,
    geomeanRatio,
    maxMemoryRatio,
    failures,
  };
};
