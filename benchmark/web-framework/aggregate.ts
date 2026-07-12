import { readFileSync } from "node:fs";
import { analyzeWebStreamRuns } from "./report.js";

const files = process.argv.slice(2);
const runs = files.map((file): unknown => JSON.parse(readFileSync(file, "utf8")));
const result = analyzeWebStreamRuns(runs as Parameters<typeof analyzeWebStreamRuns>[0], {
  seed: 20260712,
  resamples: 10_000,
});
if (!result.ok) throw new Error(`Web stream runs are non-authoritative: ${result.reasons.join(", ")}`);
console.log(`Runs: ${files.join(", ")}`);
console.log(`Ratios: ${result.ratios.map((ratio) => ratio.toFixed(4)).join(", ")}`);
console.log(`Median ratio: ${result.analysis.medianRatio.toFixed(4)}x`);
console.log(`One-sided 95% upper bound: ${result.analysis.oneSided95UpperBound.toFixed(4)}x`);
console.log(`Status: ${result.analysis.status}`);
