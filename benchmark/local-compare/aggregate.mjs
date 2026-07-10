// Aggregate multiple local-compare result JSON files to see the candidate's true
// standing across runs (median of each implementation per metric), since single
// runs are noisy and auxiliary metrics are single-shot.
//
// Usage: node benchmark/local-compare/aggregate.mjs results/AFTER-clean.json results/AFTER-2.json ...
import { readFileSync } from "node:fs";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Pass one or more result JSON paths.");
  process.exit(1);
}
const runs = files.map((file) => JSON.parse(readFileSync(file, "utf8")));
if (runs.some((run) => run.schemaVersion !== 2 || run.benchmark?.name !== "local-compare" || !run.provenance)) {
  throw new Error("Legacy benchmark artifacts have incomplete provenance and cannot be aggregated authoritatively.");
}
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
const valueAtPath = (value, fieldPath) => fieldPath.split(".").reduce((current, field) => current?.[field], value);
for (const run of runs.slice(1)) {
  for (const fieldPath of requiredEqualPaths) {
    if (JSON.stringify(valueAtPath(run, fieldPath)) !== JSON.stringify(valueAtPath(runs[0], fieldPath))) {
      throw new Error(`Incompatible benchmark artifacts differ at ${fieldPath}.`);
    }
  }
}
const candidate = runs[0].workload.candidate;
const impls = runs[0].workload.implementations;

const median = (values) => {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const collect = (extract) => {
  // returns Map<key, Map<impl, number[]>>
  const map = new Map();
  for (const run of runs) {
    for (const { key, impl, value } of extract(run)) {
      if (!map.has(key)) map.set(key, new Map());
      const byImpl = map.get(key);
      if (!byImpl.has(impl)) byImpl.set(impl, []);
      byImpl.get(impl).push(value);
    }
  }
  return map;
};

const opMap = collect((run) =>
  run.measurements.summaries.map((s) => ({ key: s.label, impl: s.implementation, value: s.trimmedMean })),
);
const auxMap = collect((run) =>
  run.measurements.auxiliaryMetrics.map((m) => ({ key: `${m.label}|${m.unit}`, impl: m.implementation, value: m.value })),
);

const report = (title, map, lowerIsBetter = true) => {
  console.log(`\n## ${title} (median of ${runs.length} runs)\n`);
  let wins = 0;
  let total = 0;
  for (const [key, byImpl] of map) {
    const medians = impls.map((impl) => [impl, median(byImpl.get(impl) ?? [])]);
    const finite = medians.filter(([, v]) => Number.isFinite(v));
    const best = lowerIsBetter
      ? Math.min(...finite.map(([, v]) => v))
      : Math.max(...finite.map(([, v]) => v));
    const candVal = medians.find(([impl]) => impl === candidate)?.[1] ?? Number.NaN;
    const ratio = candVal / best;
    // rank: 1 = best. Count how many strictly beat the candidate.
    const better = finite.filter(([, v]) => (lowerIsBetter ? v < candVal - 1e-9 : v > candVal + 1e-9)).length;
    const rank = better + 1;
    total++;
    const isWin = rank === 1 || Math.abs(ratio - 1) < 0.005;
    if (isWin) wins++;
    const label = key.split("|")[0];
    const flag = rank === 1 ? "1st" : `#${rank}`;
    const tie = rank !== 1 && Math.abs(ratio - 1) < 0.02 ? " (~tie)" : "";
    console.log(
      `- ${label.padEnd(26)} ${candidate}=${candVal.toFixed(2)}  best=${best.toFixed(2)}  ${ratio.toFixed(3)}x  ${flag}${tie}`,
    );
  }
  console.log(`\n  => ${candidate} 1st-or-tied(<0.5%): ${wins}/${total}`);
};

console.log(`Candidate: ${candidate}`);
console.log(`Runs: ${files.join(", ")}`);
report("Operations", opMap, true);
report("Auxiliary", auxMap, true);
