import { compareBenchmarkEnvelopes } from "../provenance.js";
import { validateBenchmarkEnvelope, valueAtBenchmarkPath } from "../provenance-validation.js";

export type Summary = { label: string; implementation: string; trimmedMean: number };
export type AuxiliaryMetric = { label: string; unit: string; implementation: string; value: number };

export type LocalCompareRun = {
  schemaVersion: 2;
  benchmark: { name: "local-compare"; contractVersion: number };
  provenance: {
    git: { commit: string; dirty: false; workingTreeSha256: string };
    runtime: { node: string; platform: string; arch: string; osRelease: string };
    host: { hostname: string; cpuModel: string; logicalCpuCount: number };
    browser: { name: string; version: string };
    dependencies: Record<string, { version: string }>;
  };
  workload: {
    iterations: number;
    warmup: number;
    serveMode: string;
    operationStatistic: string;
    trimFraction: number;
    baseline: string;
    candidate: string;
    implementations: string[];
  };
  measurements: { summaries: Summary[]; auxiliaryMetrics: AuxiliaryMetric[] };
};

const requiredEqualPaths = [
  "benchmark.contractVersion",
  "workload.iterations",
  "workload.warmup",
  "workload.serveMode",
  "workload.operationStatistic",
  "workload.trimFraction",
  "workload.baseline",
  "workload.candidate",
  "workload.implementations",
  "provenance.git.commit",
  "provenance.git.dirty",
  "provenance.git.workingTreeSha256",
  "provenance.runtime",
  "provenance.host",
  "provenance.browser",
  "provenance.dependencies",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const positiveInteger = (value: unknown): value is number => Number.isInteger(value) && Number(value) > 0;
const nonNegativeInteger = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0;
const finiteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const validateBrowserAndMeasurements = (value: unknown, prefix: string): string[] => {
  const invalid: string[] = [];
  const provenance = isRecord(value) && isRecord(value.provenance) ? value.provenance : {};
  const browser = isRecord(provenance.browser) ? provenance.browser : {};
  if (!nonEmptyString(browser.name)) invalid.push(`${prefix}.provenance.browser.name`);
  if (!nonEmptyString(browser.version)) invalid.push(`${prefix}.provenance.browser.version`);
  const measurements = isRecord(value) && isRecord(value.measurements) ? value.measurements : {};
  const workload = isRecord(value) && isRecord(value.workload) ? value.workload : {};
  const implementations = Array.isArray(workload.implementations) ? workload.implementations : [];
  for (const [collectionName, metricName] of [
    ["summaries", "trimmedMean"],
    ["auxiliaryMetrics", "value"],
  ] as const) {
    const collection = measurements[collectionName];
    if (!Array.isArray(collection) || collection.length === 0) {
      invalid.push(`${prefix}.measurements.${collectionName}`);
      continue;
    }
    for (const [index, entryValue] of collection.entries()) {
      const entry = isRecord(entryValue) ? entryValue : {};
      if (!nonEmptyString(entry.label)) invalid.push(`${prefix}.measurements.${collectionName}[${index}].label`);
      if (!nonEmptyString(entry.implementation)) {
        invalid.push(`${prefix}.measurements.${collectionName}[${index}].implementation`);
      } else if (!implementations.includes(entry.implementation)) {
        invalid.push(`${prefix}.measurements.${collectionName}[${index}].implementation`);
      }
      if (collectionName === "auxiliaryMetrics" && !nonEmptyString(entry.unit)) {
        invalid.push(`${prefix}.measurements.${collectionName}[${index}].unit`);
      }
      if (!finiteNumber(entry[metricName]) || Number(entry[metricName]) < 0) {
        invalid.push(`${prefix}.measurements.${collectionName}[${index}].${metricName}`);
      }
    }
  }
  return invalid;
};

const validateIdentity = (value: unknown, prefix: string): string[] => {
  const workload = isRecord(value) && isRecord(value.workload) ? value.workload : {};
  const baseline = workload.baseline;
  const candidate = workload.candidate;
  const implementations = workload.implementations;
  const invalid: string[] = [];
  if (!nonEmptyString(baseline)) invalid.push(`${prefix}.workload.baseline`);
  if (!nonEmptyString(candidate) || candidate === baseline) invalid.push(`${prefix}.workload.candidate`);
  if (
    !Array.isArray(implementations) ||
    implementations.length === 0 ||
    !implementations.every(nonEmptyString) ||
    new Set(implementations).size !== implementations.length
  ) {
    invalid.push(`${prefix}.workload.implementations`);
  } else {
    if (implementations.filter((item) => item === baseline).length !== 1) {
      invalid.push(`${prefix}.workload.baseline`);
    }
    if (implementations.filter((item) => item === candidate).length !== 1) {
      invalid.push(`${prefix}.workload.candidate`);
    }
  }
  if (!positiveInteger(workload.iterations)) invalid.push(`${prefix}.workload.iterations`);
  if (!nonNegativeInteger(workload.warmup)) invalid.push(`${prefix}.workload.warmup`);
  if (!nonEmptyString(workload.serveMode)) invalid.push(`${prefix}.workload.serveMode`);
  if (!nonEmptyString(workload.operationStatistic)) invalid.push(`${prefix}.workload.operationStatistic`);
  if (!finiteNumber(workload.trimFraction)) invalid.push(`${prefix}.workload.trimFraction`);
  return invalid;
};

export type LocalCompareValidation =
  | {
      ok: true;
      runs: LocalCompareRun[];
      verifiedControls: Pick<LocalCompareRun["workload"], "baseline" | "candidate"> & {
        runtime: LocalCompareRun["provenance"]["runtime"];
        host: LocalCompareRun["provenance"]["host"];
        git: LocalCompareRun["provenance"]["git"];
        browser: LocalCompareRun["provenance"]["browser"];
        dependencies: LocalCompareRun["provenance"]["dependencies"];
        workload: Omit<LocalCompareRun["workload"], "baseline" | "candidate">;
      };
    }
  | { ok: false; invalidFields: string[] };

export const validateLocalCompareRuns = (values: readonly unknown[]): LocalCompareValidation => {
  if (values.length === 0) return { ok: false, invalidFields: ["runs"] };
  const invalidFields: string[] = [];
  for (const [index, value] of values.entries()) {
    const prefix = `runs[${index}]`;
    const validation = validateBenchmarkEnvelope(value, requiredEqualPaths);
    if (!validation.valid) invalidFields.push(...validation.invalidFields.map((field) => `${prefix}.${field}`));
    if (valueAtBenchmarkPath(value, "benchmark.name") !== "local-compare") {
      invalidFields.push(`${prefix}.benchmark.name`);
    }
    invalidFields.push(...validateIdentity(value, prefix));
    invalidFields.push(...validateBrowserAndMeasurements(value, prefix));
    if (index > 0) {
      const comparison = compareBenchmarkEnvelopes(values[0], value, { requiredEqualPaths });
      invalidFields.push(
        ...comparison.invalidFields.map((field) => `${prefix}.${field}`),
        ...comparison.accidentalDifferences.map((difference) => `${prefix}.${difference.path}`),
      );
    }
  }
  if (invalidFields.length > 0) return { ok: false, invalidFields: [...new Set(invalidFields)] };
  const runs = values as LocalCompareRun[];
  const first = runs[0] as LocalCompareRun;
  const { baseline, candidate, ...workload } = first.workload;
  return {
    ok: true,
    runs,
    verifiedControls: {
      baseline,
      candidate,
      git: first.provenance.git,
      browser: first.provenance.browser,
      runtime: first.provenance.runtime,
      host: first.provenance.host,
      dependencies: first.provenance.dependencies,
      workload,
    },
  };
};
