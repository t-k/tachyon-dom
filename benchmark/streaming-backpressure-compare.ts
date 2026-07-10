import { readFile, writeFile } from "node:fs/promises";

import {
  compareBenchmarkEnvelopes,
  type BenchmarkEnvelope,
} from "./provenance.js";

type StreamingWorkload = {
  subject: { git: { commit: string | null; dirty: boolean | null } };
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
      : controls.accidentalDifferences.map(({ path }) => path).join(", ");
    throw new Error(`Incompatible benchmark controls: ${details}`);
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
    ratios: {
      completionTime:
        candidate.measurements.completionTimeMs /
        baseline.measurements.completionTimeMs,
      peakQueuedBytes:
        candidate.measurements.peakQueuedBytes /
        baseline.measurements.peakQueuedBytes,
      peakRssDeltaBytes:
        candidate.measurements.peakRssDeltaBytes /
        baseline.measurements.peakRssDeltaBytes,
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
    [baselinePath, candidatePath].map(async (filePath) =>
      JSON.parse(await readFile(filePath, "utf8")),
    ),
  )) as [
    BenchmarkEnvelope<StreamingWorkload, StreamingMeasurements>,
    BenchmarkEnvelope<StreamingWorkload, StreamingMeasurements>,
  ];
  const comparison = compareStreamingBackpressureResults(baseline, candidate);
  await writeFile(outputPath, `${JSON.stringify(comparison, null, 2)}\n`);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
