import { compareBenchmarkEnvelopes } from "../provenance.js";
import { validateBenchmarkEnvelope, valueAtBenchmarkPath } from "../provenance-validation.js";
import { trimmedMean, validateCompletePositionCycles } from "../shared/statistical-authority.js";
import { createLocalRunPlan } from "./run-plan.js";
import { verifyArtifactManifest } from "../shared/artifact-manifest.js";

export type Summary = {
  id: string;
  label: string;
  implementation: string;
  trimmedMean: number;
  values?: readonly number[];
};
export type AuxiliaryMetric = { id: string; label: string; unit: string; implementation: string; value: number };

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

const nearlyEqual = (left: number, right: number): boolean =>
  Math.abs(left - right) <= Math.max(1e-9, 1e-9 * Math.max(Math.abs(left), Math.abs(right)));
const requiredScenarioIds = new Set([
  "createRows",
  "replaceAllRows",
  "partialUpdate",
  "selectRow",
  "swapRows",
  "removeRow",
  "createManyRows",
  "appendRows",
  "clearRows",
]);
const requiredAuxiliaryUnits = new Map([
  ["startup", "ms"],
  ["readyHeap", "mb"],
  ["runHeap", "mb"],
  ["runClearHeap", "mb"],
  ["readyDomNodes", "count"],
  ["runDomNodes", "count"],
  ["runClearDomNodes", "count"],
  ["localSourceSize", "kib"],
  ["entrySourceSize", "kib"],
]);

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
      if (!nonEmptyString(entry.id)) invalid.push(`${prefix}.measurements.${collectionName}[${index}].id`);
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
    const byId = new Map<string, Array<Record<string, unknown>>>();
    for (const entryValue of collection) {
      if (!isRecord(entryValue) || !nonEmptyString(entryValue.id)) continue;
      const entries = byId.get(entryValue.id) ?? [];
      entries.push(entryValue);
      byId.set(entryValue.id, entries);
    }
    for (const entries of byId.values()) {
      const labels = new Set(entries.map((entry) => entry.label));
      const units = collectionName === "auxiliaryMetrics" ? new Set(entries.map((entry) => entry.unit)) : new Set([""]);
      const hasExactlyOnePerImplementation = implementations.every(
        (implementation) => entries.filter((entry) => entry.implementation === implementation).length === 1,
      );
      if (
        entries.length !== implementations.length ||
        !hasExactlyOnePerImplementation ||
        labels.size !== 1 ||
        units.size !== 1
      ) {
        invalid.push(`${prefix}.measurements.${collectionName}`);
      }
    }
    const requiredIds = collectionName === "summaries" ? requiredScenarioIds : new Set(requiredAuxiliaryUnits.keys());
    if (byId.size !== requiredIds.size || [...requiredIds].some((id) => !byId.has(id))) {
      invalid.push(`${prefix}.measurements.${collectionName}`);
    }
    if (
      collectionName === "auxiliaryMetrics" &&
      [...requiredAuxiliaryUnits].some(([id, unit]) => byId.get(id)?.some((entry) => entry.unit !== unit))
    ) {
      invalid.push(`${prefix}.measurements.auxiliaryMetrics`);
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
  if (workload.serveMode !== "dev" && workload.serveMode !== "production") {
    invalid.push(`${prefix}.workload.serveMode`);
  }
  if (workload.operationStatistic !== "trimmedMean") invalid.push(`${prefix}.workload.operationStatistic`);
  if (!finiteNumber(workload.trimFraction) || Number(workload.trimFraction) < 0 || Number(workload.trimFraction) >= 0.5) {
    invalid.push(`${prefix}.workload.trimFraction`);
  }
  return invalid;
};

const measurementMetadata = (value: unknown, collectionName: "summaries" | "auxiliaryMetrics") => {
  const collection = valueAtBenchmarkPath(value, `measurements.${collectionName}`);
  if (!Array.isArray(collection)) return new Map<string, string>();
  return new Map(
    collection.flatMap((entryValue) => {
      if (!isRecord(entryValue) || !nonEmptyString(entryValue.id) || !nonEmptyString(entryValue.label)) return [];
      const unit = collectionName === "auxiliaryMetrics" && nonEmptyString(entryValue.unit) ? entryValue.unit : "";
      return [[entryValue.id, `${entryValue.label}\0${unit}`] as const];
    }),
  );
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
    for (const collectionName of ["summaries", "auxiliaryMetrics"] as const) {
      const metadata = measurementMetadata(value, collectionName);
      if (new Set(metadata.values()).size !== metadata.size) {
        invalidFields.push(`${prefix}.measurements.${collectionName}`);
      }
      if (index > 0) {
        const baselineMetadata = measurementMetadata(values[0], collectionName);
        if (
          metadata.size !== baselineMetadata.size ||
          [...baselineMetadata].some(([id, description]) => metadata.get(id) !== description)
        ) {
          invalidFields.push(`${prefix}.measurements.${collectionName}`);
        }
      }
    }
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

export const validateAuthoritativeLocalCompareRuns = (values: readonly unknown[]): LocalCompareValidation => {
  const base = validateLocalCompareRuns(values);
  if (!base.ok) return base;

  const invalidFields: string[] = [];
  if (values.length < 5) invalidFields.push("runs");
  const runIds: string[] = [];
  const processIdentities: string[] = [];
  const runIndices: number[] = [];
  const seeds: number[] = [];
  const implementationOrders: string[][] = [];
  const scenarioOrders: string[][] = [];
  for (const [index, value] of values.entries()) {
    const prefix = `runs[${index}]`;
    if (!verifyArtifactManifest(value)) invalidFields.push(`${prefix}.manifest.sha256`);
    const pid = valueAtBenchmarkPath(value, "manifest.pid");
    const processStartedAt = valueAtBenchmarkPath(value, "manifest.processStartedAt");
    if (Number.isInteger(pid) && nonEmptyString(processStartedAt)) {
      processIdentities.push(`${pid}:${processStartedAt}`);
    } else {
      invalidFields.push(`${prefix}.manifest.processIdentity`);
    }
    if (valueAtBenchmarkPath(value, "benchmark.contractVersion") !== 4) {
      invalidFields.push(`${prefix}.benchmark.contractVersion`);
    }
    const runId = valueAtBenchmarkPath(value, "workload.runId");
    if (!nonEmptyString(runId)) invalidFields.push(`${prefix}.workload.runId`);
    else runIds.push(runId);
    const seed = valueAtBenchmarkPath(value, "workload.seed");
    if (!Number.isInteger(seed)) {
      invalidFields.push(`${prefix}.workload.seed`);
    } else seeds.push(Number(seed));
    const runIndex = valueAtBenchmarkPath(value, "workload.runIndex");
    if (!nonNegativeInteger(runIndex)) invalidFields.push(`${prefix}.workload.runIndex`);
    else runIndices.push(runIndex);
    if (Number(valueAtBenchmarkPath(value, "workload.iterations")) < 30) {
      invalidFields.push(`${prefix}.workload.iterations`);
    }
    if (Number(valueAtBenchmarkPath(value, "workload.warmup")) < 5) {
      invalidFields.push(`${prefix}.workload.warmup`);
    }
    const order = valueAtBenchmarkPath(value, "workload.order");
    implementationOrders.push(Array.isArray(order) && order.every(nonEmptyString) ? order : []);
    const scenarioOrder = valueAtBenchmarkPath(value, "workload.scenarioOrder");
    scenarioOrders.push(Array.isArray(scenarioOrder) && scenarioOrder.every(nonEmptyString) ? scenarioOrder : []);
    const summaries = valueAtBenchmarkPath(value, "measurements.summaries");
    if (Array.isArray(summaries)) {
      for (const [summaryIndex, summaryValue] of summaries.entries()) {
        const summary = isRecord(summaryValue) ? summaryValue : {};
        const samplesValid =
          Array.isArray(summary.values) &&
          summary.values.length >= 30 &&
          summary.values.every((sample) => finiteNumber(sample) && sample >= 0);
        if (
          !samplesValid
        ) {
          invalidFields.push(`${prefix}.measurements.summaries[${summaryIndex}].values`);
        } else {
          const stored = summary.trimmedMean;
          const trimFraction = valueAtBenchmarkPath(value, "workload.trimFraction");
          if (
            !finiteNumber(stored) ||
            !finiteNumber(trimFraction) ||
            !nearlyEqual(stored, trimmedMean(summary.values as number[], trimFraction))
          ) {
            invalidFields.push(`${prefix}.measurements.summaries[${summaryIndex}].trimmedMean`);
          }
        }
      }
    }
  }
  if (new Set(runIds).size !== runIds.length) invalidFields.push("runs.workload.runId");
  if (new Set(processIdentities).size !== processIdentities.length) invalidFields.push("runs.manifest.processIdentity");
  if (values.length < 7) invalidFields.push("runs");
  if (new Set(runIndices).size !== runIndices.length) invalidFields.push("runs.workload.runIndex");
  if (new Set(seeds).size !== 1) invalidFields.push("runs.workload.seed");
  const implementations = base.verifiedControls.workload.implementations;
  const scenarios = [...requiredScenarioIds];
  if (!validateCompletePositionCycles(implementationOrders, implementations)) {
    invalidFields.push("runs.workload.order");
  }
  for (const [index, runIndex] of runIndices.entries()) {
    const expected = createLocalRunPlan(implementations, scenarios, {
      runId: runIds[index] ?? "invalid",
      runIndex,
      seed: seeds[index] ?? 0,
    });
    if (JSON.stringify(implementationOrders[index]) !== JSON.stringify(expected.implementationOrder)) {
      invalidFields.push(`runs[${index}].workload.order`);
    }
    if (JSON.stringify(scenarioOrders[index]) !== JSON.stringify(expected.scenarioOrder)) {
      invalidFields.push(`runs[${index}].workload.scenarioOrder`);
    }
  }
  for (const scenario of scenarios) {
    const positions = scenarioOrders.map((order) => order.indexOf(scenario));
    const early = positions.filter((position) => position >= 0 && position < 4).length;
    const late = positions.filter((position) => position > 4).length;
    const mean = positions.reduce((total, position) => total + position, 0) / positions.length;
    if (positions.some((position) => position < 0) || Math.abs(early - late) > 1 || Math.abs(mean - 4) > 1) {
      invalidFields.push("runs.workload.scenarioOrder");
      break;
    }
  }
  return invalidFields.length > 0 ? { ok: false, invalidFields: [...new Set(invalidFields)] } : base;
};
