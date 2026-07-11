// Aggregate multiple local-compare result JSON files to see the candidate's true
// standing across runs (median of each implementation per metric), since single
// runs are noisy and auxiliary metrics are single-shot.
//
// Usage: pnpm exec tsx benchmark/local-compare/aggregate.ts results/AFTER-clean.json results/AFTER-2.json ...
import { readFileSync } from "node:fs";
import { buildAuthoritativeScenarioRows, formatAuthoritativeScenarioRows } from "./aggregate-report.js";
import { validateAuthoritativeLocalCompareRuns, type LocalCompareRun } from "./validation.js";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Pass one or more result JSON paths.");
  process.exit(1);
}
const runs = files.map((file): unknown => JSON.parse(readFileSync(file, "utf8")));
const validation = validateAuthoritativeLocalCompareRuns(runs);
if (!validation.ok) {
  throw new Error(
    `Benchmark artifacts are incomplete, non-authoritative, or incompatible at: ${validation.invalidFields.join(", ")}.`,
  );
}
const validatedRuns = validation.runs;
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
    key: summary.id,
    implementation: summary.implementation,
    value: summary.trimmedMean,
  })),
);
const auxiliaryMap = collect((run) =>
  run.measurements.auxiliaryMetrics.map((metric) => ({
    key: metric.id,
    implementation: metric.implementation,
    value: metric.value,
  })),
);

const labels = new Map([
  ...firstRun.measurements.summaries.map((summary) => [summary.id, summary.label] as const),
  ...firstRun.measurements.auxiliaryMetrics.map((metric) => [metric.id, metric.label] as const),
]);

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
    const label = labels.get(key) ?? key;
    const flag = rank === 1 ? "1st" : `#${rank}`;
    const tie = rank !== 1 && Math.abs(ratio - 1) < 0.02 ? " (~tie)" : "";
    console.log(
      `- ${label.padEnd(26)} ${candidate}=${candidateValue.toFixed(2)}  best=${best.toFixed(2)}  ${ratio.toFixed(3)}x  ${flag}${tie}`,
    );
  }
  console.log(`\n  => ${candidate} 1st-or-tied(<0.5%): ${wins}/${total}`);
};

console.log(`Baseline: ${validation.verifiedControls.baseline}`);
console.log(`Candidate: ${validation.verifiedControls.candidate}`);
console.log(`Runs: ${files.join(", ")}`);
console.log(`Verified controls: ${JSON.stringify(validation.verifiedControls)}`);
console.log("\n## Authoritative operation confidence\n");
console.log(formatAuthoritativeScenarioRows(buildAuthoritativeScenarioRows(validatedRuns, { seed: 20260712, resamples: 10_000 })));
report("Operations", operationMap, true);
report("Auxiliary", auxiliaryMap, true);
