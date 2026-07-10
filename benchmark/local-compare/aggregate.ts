// Aggregate multiple local-compare result JSON files to see the candidate's true
// standing across runs (median of each implementation per metric), since single
// runs are noisy and auxiliary metrics are single-shot.
//
// Usage: pnpm exec tsx benchmark/local-compare/aggregate.ts results/AFTER-clean.json results/AFTER-2.json ...
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { validateBenchmarkEnvelope, valueAtBenchmarkPath } from "../provenance-validation.js";

type Summary = { label: string; implementation: string; trimmedMean: number };
type AuxiliaryMetric = { label: string; unit: string; implementation: string; value: number };
type LocalCompareRun = {
  workload: { candidate: string; implementations: string[] };
  measurements: { summaries: Summary[]; auxiliaryMetrics: AuxiliaryMetric[] };
};

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Pass one or more result JSON paths.");
  process.exit(1);
}
const runs = files.map((file): unknown => JSON.parse(readFileSync(file, "utf8")));
const requiredEqualPaths = [
  "benchmark.contractVersion",
  "workload.iterations",
  "workload.warmup",
  "workload.serveMode",
  "workload.operationStatistic",
  "workload.trimFraction",
  "workload.implementations",
  "provenance.runtime",
  "provenance.host.cpuModel",
  "provenance.browser",
  "provenance.dependencies",
];
for (const [index, run] of runs.entries()) {
  const validation = validateBenchmarkEnvelope(run, requiredEqualPaths);
  if (!validation.valid || valueAtBenchmarkPath(run, "benchmark.name") !== "local-compare") {
    const details = validation.valid ? "benchmark.name" : validation.invalidFields.join(", ");
    throw new Error(`Benchmark artifact ${files[index]} is incomplete or invalid at: ${details}.`);
  }
}
for (const run of runs.slice(1)) {
  for (const fieldPath of requiredEqualPaths) {
    if (!isDeepStrictEqual(valueAtBenchmarkPath(run, fieldPath), valueAtBenchmarkPath(runs[0], fieldPath))) {
      throw new Error(`Incompatible benchmark artifacts differ at ${fieldPath}.`);
    }
  }
}
const validatedRuns = runs as LocalCompareRun[];
const firstRun = validatedRuns[0];
if (!firstRun) throw new Error("At least one benchmark artifact is required.");
const candidate = firstRun.workload.candidate;
const implementations = firstRun.workload.implementations;

const median = (values: readonly number[]): number => {
  const sorted = [...values].filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return Number.NaN;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
};

type Measurement = { key: string; implementation: string; value: number };

const collect = (extract: (run: LocalCompareRun) => Measurement[]): Map<string, Map<string, number[]>> => {
  const measurements = new Map<string, Map<string, number[]>>();
  for (const run of validatedRuns) {
    for (const { key, implementation, value } of extract(run)) {
      const byImplementation = measurements.get(key) ?? new Map<string, number[]>();
      const values = byImplementation.get(implementation) ?? [];
      values.push(value);
      byImplementation.set(implementation, values);
      measurements.set(key, byImplementation);
    }
  }
  return measurements;
};

const operationMap = collect((run) =>
  run.measurements.summaries.map((summary) => ({
    key: summary.label,
    implementation: summary.implementation,
    value: summary.trimmedMean,
  })),
);
const auxiliaryMap = collect((run) =>
  run.measurements.auxiliaryMetrics.map((metric) => ({
    key: `${metric.label}|${metric.unit}`,
    implementation: metric.implementation,
    value: metric.value,
  })),
);

const report = (title: string, measurements: Map<string, Map<string, number[]>>, lowerIsBetter = true): void => {
  console.log(`\n## ${title} (median of ${validatedRuns.length} runs)\n`);
  let wins = 0;
  let total = 0;
  for (const [key, byImplementation] of measurements) {
    const medians = implementations.map(
      (implementation) => [implementation, median(byImplementation.get(implementation) ?? [])] as const,
    );
    const finite = medians.filter((entry) => Number.isFinite(entry[1]));
    const best = lowerIsBetter
      ? Math.min(...finite.map((entry) => entry[1]))
      : Math.max(...finite.map((entry) => entry[1]));
    const candidateValue = medians.find((entry) => entry[0] === candidate)?.[1] ?? Number.NaN;
    const ratio = candidateValue / best;
    const better = finite.filter((entry) =>
      lowerIsBetter ? entry[1] < candidateValue - 1e-9 : entry[1] > candidateValue + 1e-9,
    ).length;
    const rank = better + 1;
    total += 1;
    const isWin = rank === 1 || Math.abs(ratio - 1) < 0.005;
    if (isWin) wins += 1;
    const label = key.split("|")[0] as string;
    const flag = rank === 1 ? "1st" : `#${rank}`;
    const tie = rank !== 1 && Math.abs(ratio - 1) < 0.02 ? " (~tie)" : "";
    console.log(
      `- ${label.padEnd(26)} ${candidate}=${candidateValue.toFixed(2)}  best=${best.toFixed(2)}  ${ratio.toFixed(3)}x  ${flag}${tie}`,
    );
  }
  console.log(`\n  => ${candidate} 1st-or-tied(<0.5%): ${wins}/${total}`);
};

console.log(`Candidate: ${candidate}`);
console.log(`Runs: ${files.join(", ")}`);
report("Operations", operationMap, true);
report("Auxiliary", auxiliaryMap, true);
