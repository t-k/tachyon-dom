import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { collectBenchmarkProvenance, compareBenchmarkEnvelopes, type BenchmarkEnvelope } from "./provenance.js";
import { valueAtBenchmarkPath } from "./provenance-validation.js";

type StreamingWorkload = {
  label: string;
  transport: string;
  connections: number;
  chunksPerConnection: number;
  chunkBytes: number;
  drainDelayMs: number;
  adapterModule: string;
  adapter: {
    relativePath: string;
    sha256: string;
    gitBlob: string;
  };
  subject: {
    root: string;
    git: {
      available: boolean;
      commit: string | null;
      dirty: boolean | null;
      workingTreeSha256: string | null;
    };
  };
};

type StreamingMeasurements = {
  completionTimeMs: number;
  peakQueuedBytes: number;
  sourcePullCount: number;
  startingRssBytes: number;
  peakRssBytes: number;
  peakRssDeltaBytes: number;
};

const controlValidators = [
  ["workload.label", (value: unknown) => typeof value === "string" && value.length > 0],
  ["workload.transport", (value: unknown) => value === "tcp"],
  [
    "workload.connections",
    (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 10_000,
  ],
  [
    "workload.chunksPerConnection",
    (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 1_000_000,
  ],
  [
    "workload.chunkBytes",
    (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 16 * 1024 * 1024,
  ],
  [
    "workload.drainDelayMs",
    (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 60_000,
  ],
  ["workload.adapterModule", (value: unknown) => typeof value === "string" && value.length > 0],
  ["workload.adapter", (value: unknown) => typeof value === "object" && value !== null],
  [
    "workload.adapter.relativePath",
    (value: unknown) =>
      typeof value === "string" && value.length > 0 && !path.isAbsolute(value) && !value.split(/[\\/]/).includes(".."),
  ],
  ["workload.adapter.sha256", (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)],
  ["workload.adapter.gitBlob", (value: unknown) => typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value)],
  ["workload.subject", (value: unknown) => typeof value === "object" && value !== null],
  ["workload.subject.root", (value: unknown) => typeof value === "string" && value.length > 0],
  ["workload.subject.git", (value: unknown) => typeof value === "object" && value !== null],
  ["workload.subject.git.available", (value: unknown) => value === true],
  ["workload.subject.git.commit", (value: unknown) => typeof value === "string" && value.length > 0],
  ["workload.subject.git.dirty", (value: unknown) => typeof value === "boolean"],
  [
    "workload.subject.git.workingTreeSha256",
    (value: unknown) => typeof value === "string" && value.length > 0,
  ],
] as const;

const measurementValidators = [
  [
    "measurements.completionTimeMs",
    (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0,
  ],
  ["measurements.peakQueuedBytes", (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0],
  ["measurements.sourcePullCount", (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0],
  ["measurements.startingRssBytes", (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0],
  ["measurements.peakRssBytes", (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0],
  ["measurements.peakRssDeltaBytes", (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0],
] as const;

const validateStreamingArtifact = (value: unknown, label: "baseline" | "candidate"): void => {
  if (valueAtBenchmarkPath(value, "benchmark.name") !== "streaming-backpressure") {
    throw new Error(`${label}.benchmark.name must be streaming-backpressure.`);
  }
  if (valueAtBenchmarkPath(value, "benchmark.contractVersion") !== 2) {
    throw new Error(`${label}.benchmark.contractVersion must be 2.`);
  }
  for (const [path, validate] of [...controlValidators, ...measurementValidators]) {
    if (!validate(valueAtBenchmarkPath(value, path))) throw new Error(`${label}.${path} is invalid.`);
  }
  const subjectRoot = String(valueAtBenchmarkPath(value, "workload.subject.root"));
  const adapterModule = String(valueAtBenchmarkPath(value, "workload.adapterModule"));
  const relativeAdapter = String(valueAtBenchmarkPath(value, "workload.adapter.relativePath"));
  if (path.resolve(subjectRoot, relativeAdapter) !== path.resolve(adapterModule)) {
    throw new Error(`${label}.workload.adapterModule must match the subject-relative adapter path.`);
  }
  const startingRssBytes = Number(valueAtBenchmarkPath(value, "measurements.startingRssBytes"));
  const peakRssBytes = Number(valueAtBenchmarkPath(value, "measurements.peakRssBytes"));
  const peakRssDeltaBytes = Number(valueAtBenchmarkPath(value, "measurements.peakRssDeltaBytes"));
  const connections = Number(valueAtBenchmarkPath(value, "workload.connections"));
  const chunksPerConnection = Number(valueAtBenchmarkPath(value, "workload.chunksPerConnection"));
  const sourcePullCount = Number(valueAtBenchmarkPath(value, "measurements.sourcePullCount"));
  const expectedSourcePullCount = connections * (chunksPerConnection + 1);
  if (!Number.isSafeInteger(expectedSourcePullCount) || sourcePullCount !== expectedSourcePullCount) {
    throw new Error(`${label}.measurements.sourcePullCount must match the completed workload.`);
  }
  if (startingRssBytes <= 0) throw new Error(`${label}.measurements.startingRssBytes must be positive.`);
  if (peakRssBytes <= 0 || peakRssBytes < startingRssBytes) {
    throw new Error(`${label}.measurements.peakRssBytes must be positive and not below starting RSS.`);
  }
  if (peakRssDeltaBytes !== peakRssBytes - startingRssBytes) {
    throw new Error(`${label}.measurements.peakRssDeltaBytes must equal peak RSS minus starting RSS.`);
  }
  for (const path of ["measurements.peakQueuedBytes", "measurements.peakRssDeltaBytes"] as const) {
    if (label === "baseline" && Number(valueAtBenchmarkPath(value, path)) <= 0) {
      throw new Error(`${label}.${path} must be positive for ratio calculation.`);
    }
  }
};

const requiredEqualPaths = [
  "schemaVersion",
  "benchmark.name",
  "benchmark.contractVersion",
  "provenance.git.commit",
  "provenance.git.dirty",
  "provenance.git.workingTreeSha256",
  "provenance.runtime",
  "provenance.host",
  "provenance.dependencies",
  "workload.transport",
  "workload.connections",
  "workload.chunksPerConnection",
  "workload.chunkBytes",
  "workload.drainDelayMs",
  "workload.adapter.relativePath",
] as const;

export const compareStreamingBackpressureResults = (baselineValue: unknown, candidateValue: unknown) => {
  validateStreamingArtifact(baselineValue, "baseline");
  validateStreamingArtifact(candidateValue, "candidate");
  const baseline = baselineValue as BenchmarkEnvelope<StreamingWorkload, StreamingMeasurements>;
  const candidate = candidateValue as BenchmarkEnvelope<StreamingWorkload, StreamingMeasurements>;
  const controls = compareBenchmarkEnvelopes(baseline, candidate, {
    requiredEqualPaths,
  });
  if (!controls.compatible || controls.legacyIncomplete) {
    const details = controls.legacyIncomplete
      ? "legacy or incomplete benchmark envelope"
      : [...controls.invalidFields, ...controls.accidentalDifferences.map(({ path }) => path)].join(", ");
    throw new Error(`Incompatible benchmark controls: ${details}`);
  }
  for (const [label, subject] of [
    ["baseline", baseline.workload.subject],
    ["candidate", candidate.workload.subject],
  ] as const) {
    if (subject.git.available !== true) {
      throw new Error(`${label}.workload.subject.git.available must be true.`);
    }
    if (typeof subject.git.commit !== "string" || subject.git.commit.length === 0) {
      throw new Error(`${label}.workload.subject.git.commit must be available.`);
    }
    if (typeof subject.git.workingTreeSha256 !== "string" || subject.git.workingTreeSha256.length === 0) {
      throw new Error(`${label}.workload.subject.git.workingTreeSha256 must be available.`);
    }
  }
  if (
    baseline.provenance.git.dirty !== false ||
    candidate.provenance.git.dirty !== false ||
    baseline.workload.subject.git.dirty !== false ||
    candidate.workload.subject.git.dirty !== false
  ) {
    throw new Error("Benchmark runner and subjects must have clean working trees.");
  }

  return {
    schemaVersion: 1,
    benchmark: baseline.benchmark,
    baselineRevision: baseline.workload.subject.git.commit,
    candidateRevision: candidate.workload.subject.git.commit,
    controls,
    verifiedControls: {
      baselineSubject: baseline.workload.subject.git,
      candidateSubject: candidate.workload.subject.git,
      baselineAdapter: baseline.workload.adapter,
      candidateAdapter: candidate.workload.adapter,
      runtime: baseline.provenance.runtime,
      host: baseline.provenance.host,
      dependencies: baseline.provenance.dependencies,
      workload: {
        transport: baseline.workload.transport,
        connections: baseline.workload.connections,
        chunksPerConnection: baseline.workload.chunksPerConnection,
        chunkBytes: baseline.workload.chunkBytes,
        drainDelayMs: baseline.workload.drainDelayMs,
      },
    },
    ratios: {
      completionTime: candidate.measurements.completionTimeMs / baseline.measurements.completionTimeMs,
      peakQueuedBytes: candidate.measurements.peakQueuedBytes / baseline.measurements.peakQueuedBytes,
      peakRssDeltaBytes: candidate.measurements.peakRssDeltaBytes / baseline.measurements.peakRssDeltaBytes,
    },
    baseline: baseline.measurements,
    candidate: candidate.measurements,
  };
};

const main = async () => {
  const [baselinePath, candidatePath, outputPath] = process.argv.slice(2);
  if (!baselinePath || !candidatePath || !outputPath) {
    throw new Error(
      "Usage: tsx benchmark/streaming-backpressure-compare.ts <baseline.json> <candidate.json> <output.json>",
    );
  }
  const [baseline, candidate] = (await Promise.all(
    [baselinePath, candidatePath].map(async (filePath) => JSON.parse(await readFile(filePath, "utf8"))),
  )) as [
    BenchmarkEnvelope<StreamingWorkload, StreamingMeasurements>,
    BenchmarkEnvelope<StreamingWorkload, StreamingMeasurements>,
  ];
  const comparison = compareStreamingBackpressureResults(baseline, candidate);
  const result = {
    schemaVersion: 2,
    benchmark: { name: "streaming-backpressure-comparison", contractVersion: 1 },
    provenance: await collectBenchmarkProvenance({
      cwd: process.cwd(),
      argv: [process.execPath, ...process.argv.slice(1)],
      dependencies: candidate.provenance.dependencies,
    }),
    workload: {
      baselineRevision: comparison.baselineRevision,
      candidateRevision: comparison.candidateRevision,
      controls: comparison.controls,
      verifiedControls: comparison.verifiedControls,
    },
    measurements: {
      ratios: comparison.ratios,
      baseline: comparison.baseline,
      candidate: comparison.candidate,
    },
  };
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
