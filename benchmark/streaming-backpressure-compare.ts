import { readFile, writeFile } from "node:fs/promises";

import { collectBenchmarkProvenance, compareBenchmarkEnvelopes, type BenchmarkEnvelope } from "./provenance.js";

type StreamingWorkload = {
  transport: string;
  connections: number;
  chunksPerConnection: number;
  chunkBytes: number;
  drainDelayMs: number;
  subject: {
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
  peakRssDeltaBytes: number;
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
] as const;

export const compareStreamingBackpressureResults = (
  baseline: BenchmarkEnvelope<StreamingWorkload, StreamingMeasurements>,
  candidate: BenchmarkEnvelope<StreamingWorkload, StreamingMeasurements>,
) => {
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
