import { describe, expect, it } from "vitest";

import { compareStreamingBackpressureResults } from "../benchmark/streaming-backpressure-compare.js";

const seed = 0xb34c4004;
const budget = 256;
const fields = [
  "workload.connections",
  "workload.chunksPerConnection",
  "workload.chunkBytes",
  "workload.drainDelayMs",
  "measurements.completionTimeMs",
  "measurements.peakQueuedBytes",
  "measurements.sourcePullCount",
  "measurements.startingRssBytes",
  "measurements.peakRssBytes",
  "measurements.peakRssDeltaBytes",
] as const;
const invalidValues = [null, "1", -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1] as const;

const envelope = (revision: string) => ({
  schemaVersion: 2,
  benchmark: { name: "streaming-backpressure", contractVersion: 2 },
  provenance: {
    capturedAt: "2026-07-11T00:00:00.000Z",
    command: { argv: ["benchmark"], display: "benchmark", cwd: "/repo" },
    git: { available: true, commit: "runner", dirty: false, workingTreeSha256: "tree" },
    runtime: { node: "v24", platform: "linux", arch: "x64", osRelease: "test" },
    host: { hostname: "host", cpuModel: "cpu", logicalCpuCount: 8 },
    dependencies: { tsx: { version: "4.22.4" } },
  },
  workload: {
    label: revision,
    transport: "tcp",
    connections: 6,
    chunksPerConnection: 128,
    chunkBytes: 32768,
    drainDelayMs: 2,
    adapterModule: `/repo/${revision}/src/adapter.js`,
    adapter: {
      relativePath: "src/adapter.js",
      sha256: (revision === "baseline" ? "a" : "b").repeat(64),
      gitBlob: (revision === "baseline" ? "c" : "d").repeat(40),
    },
    subject: {
      root: `/repo/${revision}`,
      git: { available: true, commit: revision, dirty: false, workingTreeSha256: revision },
    },
  },
  measurements: {
    completionTimeMs: 400,
    peakQueuedBytes: 1_000,
    sourcePullCount: 774,
    startingRssBytes: 10,
    peakRssBytes: 20,
    peakRssDeltaBytes: 10,
  },
});

const setPath = (value: Record<string, any>, path: string, nextValue: unknown): void => {
  const parts = path.split(".");
  const field = parts.pop() as string;
  let target = value;
  for (const part of parts) target = target[part] as Record<string, any>;
  target[field] = nextValue;
};

describe("benchmark decoded JSON bounded properties", () => {
  it(`rejects malformed values across ${budget} seeded mutations`, () => {
    let state = seed >>> 0;
    for (let index = 0; index < budget; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const field = fields[state % fields.length] as string;
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const invalid = invalidValues[state % invalidValues.length];
      const baseline = envelope("baseline");
      const candidate = envelope("candidate");
      setPath(baseline, field, invalid);
      if (field.startsWith("workload.")) setPath(candidate, field, invalid);
      expect(
        () => compareStreamingBackpressureResults(baseline, candidate),
        `seed=${seed} case=${index} field=${field} value=${String(invalid)}`,
      ).toThrow(new RegExp(`baseline\\.${field.replaceAll(".", "\\.")}`));
    }
  });

  it("returns only finite ratios for valid boundaries", () => {
    const baseline = envelope("baseline");
    const candidate = envelope("candidate");
    candidate.measurements.peakQueuedBytes = 0;
    candidate.measurements.peakRssBytes = candidate.measurements.startingRssBytes;
    candidate.measurements.peakRssDeltaBytes = 0;
    const comparison = compareStreamingBackpressureResults(baseline, candidate);
    expect(Object.values(comparison.ratios).every(Number.isFinite)).toBe(true);
  });
});
