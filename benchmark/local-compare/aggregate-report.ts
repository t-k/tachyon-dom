import { analyzeRatios, type AuthorityStatus } from "../shared/statistical-authority.js";

type AggregateSummary = {
  id: string;
  label: string;
  implementation: string;
  trimmedMean: number;
  values?: readonly number[];
};

type AggregateRun = {
  workload: { candidate: string; implementations: readonly string[] };
  measurements: { summaries: readonly AggregateSummary[] };
};

export type AuthoritativeScenarioRow = {
  id: string;
  label: string;
  status: AuthorityStatus;
  medianRatio: number;
  oneSided95UpperBound: number;
  independentRunCount: number;
  sampleCountPerRun: number;
};

const stableNumber = (value: number): number => Number(value.toPrecision(12));

export const buildAuthoritativeScenarioRows = (
  runs: readonly AggregateRun[],
  options: { seed: number; resamples: number },
): AuthoritativeScenarioRow[] => {
  const first = runs[0];
  if (!first) return [];
  const candidate = first.workload.candidate;
  const candidateSummaries = first.measurements.summaries.filter((summary) => summary.implementation === candidate);
  return candidateSummaries.map((candidateSummary) => {
    const ratios = runs.map((run) => {
      const runCandidate = run.measurements.summaries.find(
        (summary) => summary.id === candidateSummary.id && summary.implementation === candidate,
      );
      const competitors = run.measurements.summaries.filter(
        (summary) => summary.id === candidateSummary.id && summary.implementation !== candidate,
      );
      const best = Math.min(...competitors.map((summary) => summary.trimmedMean));
      if (!runCandidate || !Number.isFinite(best)) throw new Error(`Incomplete scenario ${candidateSummary.id}`);
      return stableNumber(runCandidate.trimmedMean / best);
    });
    const analysis = analyzeRatios(ratios, options);
    return {
      id: candidateSummary.id,
      label: candidateSummary.label,
      ...analysis,
      medianRatio: stableNumber(analysis.medianRatio),
      oneSided95UpperBound: stableNumber(analysis.oneSided95UpperBound),
      sampleCountPerRun: candidateSummary.values?.length ?? 1,
    };
  });
};

export const formatAuthoritativeScenarioRows = (rows: readonly AuthoritativeScenarioRow[]): string =>
  rows
    .map(
      (row) =>
        `- ${row.label}: median=${row.medianRatio.toFixed(3)}x upper95=${row.oneSided95UpperBound.toFixed(3)}x status=${row.status} runs=${row.independentRunCount} samples/run=${row.sampleCountPerRun}`,
    )
    .join("\n");
