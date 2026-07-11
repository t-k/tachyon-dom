import { describe, expect, it } from "vitest";

import { compareStreamingBackpressureResults } from "../benchmark/streaming-backpressure-compare.js";
import type { BenchmarkEnvelope } from "../benchmark/provenance.js";

const envelope = (options: { revision: string; queued: number; connections?: number; dirty?: boolean }) =>
  ({
    schemaVersion: 2,
    benchmark: { name: "streaming-backpressure", contractVersion: 2 },
    provenance: {
      capturedAt: "2026-07-10T00:00:00.000Z",
      command: { argv: ["benchmark"], display: "benchmark", cwd: "/repo" },
      git: { available: true, commit: "runner", dirty: false, workingTreeSha256: "tree" },
      runtime: { node: "v24", platform: "linux", arch: "x64", osRelease: "test" },
      host: { hostname: "host", cpuModel: "cpu", logicalCpuCount: 8 },
      dependencies: { tachyon: { version: "1.0.0" } },
    },
    workload: {
      label: options.revision,
      transport: "tcp",
      connections: options.connections ?? 6,
      chunksPerConnection: 128,
      chunkBytes: 32768,
      drainDelayMs: 2,
      adapterModule: `/repo/${options.revision}/src/adapter.js`,
      adapter: {
        relativePath: "src/adapter.js",
        sha256: (options.revision === "baseline" ? "a" : "b").repeat(64),
        gitBlob: (options.revision === "baseline" ? "c" : "d").repeat(40),
        dependencySnapshot: {
          lockfileSha256: "e".repeat(64),
          treeSha256: "f".repeat(64),
          packageManager: "pnpm@10.32.1",
        },
      },
      subject: {
        root: `/repo/${options.revision}`,
        git: {
          available: true,
          commit: options.revision,
          dirty: options.dirty ?? false,
          workingTreeSha256: options.revision,
        },
      },
    },
    measurements: {
      completionTimeMs: 400,
      peakQueuedBytes: options.queued,
      sourcePullCount: (options.connections ?? 6) * 129,
      startingRssBytes: 10,
      peakRssBytes: 20,
      peakRssDeltaBytes: 10,
    },
  }) as BenchmarkEnvelope<any, any>;

describe("streaming backpressure comparison", () => {
  it("records explicit revisions and ratios when controls match", () => {
    const result = compareStreamingBackpressureResults(
      envelope({ revision: "baseline", queued: 1_000 }),
      envelope({ revision: "candidate", queued: 100 }),
    );

    expect(result.baselineRevision).toBe("baseline");
    expect(result.candidateRevision).toBe("candidate");
    expect(result.ratios.peakQueuedBytes).toBe(0.1);
    expect(result.controls.compatible).toBe(true);
    expect(result.verifiedControls).toMatchObject({
      baselineSubject: { commit: "baseline" },
      candidateSubject: { commit: "candidate" },
      runtime: { node: "v24" },
      host: { cpuModel: "cpu" },
      workload: { connections: 6, chunksPerConnection: 128 },
      baselineAdapter: { relativePath: "src/adapter.js", sha256: "a".repeat(64) },
      candidateAdapter: { relativePath: "src/adapter.js", sha256: "b".repeat(64) },
    });
  });

  it("rejects mismatched controls and dirty subjects", () => {
    expect(() =>
      compareStreamingBackpressureResults(
        envelope({ revision: "baseline", queued: 1_000 }),
        envelope({ revision: "candidate", queued: 100, connections: 7 }),
      ),
    ).toThrow(/workload.connections/);
    expect(() =>
      compareStreamingBackpressureResults(
        envelope({ revision: "baseline", queued: 1_000 }),
        envelope({ revision: "candidate", queued: 100, dirty: true }),
      ),
    ).toThrow(/clean working trees/);
  });

  it("rejects dependency snapshot identity mismatches", () => {
    const baseline = envelope({ revision: "baseline", queued: 1_000 });
    const candidate = envelope({ revision: "candidate", queued: 100 });
    candidate.workload.adapter.dependencySnapshot.treeSha256 = "0".repeat(64);
    expect(() => compareStreamingBackpressureResults(baseline, candidate)).toThrow(/dependencySnapshot/);
  });

  it("rejects unavailable subject provenance with a precise field", () => {
    const baseline = envelope({ revision: "baseline", queued: 1_000 });
    const candidate = envelope({ revision: "candidate", queued: 100 });
    candidate.workload.subject.git.available = false;
    candidate.workload.subject.git.commit = null;
    candidate.workload.subject.git.workingTreeSha256 = null;
    expect(() => compareStreamingBackpressureResults(baseline, candidate)).toThrow(
      /candidate\.workload\.subject\.git\.available/,
    );
  });

  it.each([
    ["missing subject", undefined, "baseline.workload.subject"],
    ["null subject", null, "baseline.workload.subject"],
    ["null subject git", { root: "/repo/baseline", git: null }, "baseline.workload.subject.git"],
  ])("rejects %s with a precise field instead of a TypeError", (_name, subject, expected) => {
    const baseline = envelope({ revision: "baseline", queued: 1_000 }) as any;
    const candidate = envelope({ revision: "candidate", queued: 100 });
    baseline.workload.subject = subject;
    expect(() => compareStreamingBackpressureResults(baseline, candidate)).toThrow(expected);
  });

  it.each([
    ["connections", "6"],
    ["chunksPerConnection", 1.5],
    ["chunkBytes", -1],
    ["drainDelayMs", -1],
  ])("rejects malformed decoded workload control %s", (field, value) => {
    const baseline = envelope({ revision: "baseline", queued: 1_000 }) as any;
    const candidate = envelope({ revision: "candidate", queued: 100 }) as any;
    baseline.workload[field] = value;
    candidate.workload[field] = value;
    expect(() => compareStreamingBackpressureResults(baseline, candidate)).toThrow(
      new RegExp(`baseline\\.workload\\.${field}`),
    );
  });

  it.each(["completionTimeMs", "peakQueuedBytes", "peakRssDeltaBytes"])(
    "rejects zero or non-finite ratio denominator %s",
    (field) => {
      const baseline = envelope({ revision: "baseline", queued: 1_000 }) as any;
      const candidate = envelope({ revision: "candidate", queued: 100 }) as any;
      baseline.measurements[field] = 0;
      expect(() => compareStreamingBackpressureResults(baseline, candidate)).toThrow(
        new RegExp(`baseline\\.measurements\\.${field}`),
      );
      baseline.measurements[field] = Number.NaN;
      expect(() => compareStreamingBackpressureResults(baseline, candidate)).toThrow(
        new RegExp(`baseline\\.measurements\\.${field}`),
      );
    },
  );

  it.each([
    ["zero starting RSS", { startingRssBytes: 0, peakRssBytes: 20, peakRssDeltaBytes: 20 }, "startingRssBytes"],
    ["zero peak RSS", { startingRssBytes: 10, peakRssBytes: 0, peakRssDeltaBytes: 0 }, "peakRssBytes"],
    ["peak below start", { startingRssBytes: 20, peakRssBytes: 10, peakRssDeltaBytes: 0 }, "peakRssBytes"],
    ["inconsistent delta", { startingRssBytes: 10, peakRssBytes: 20, peakRssDeltaBytes: 9 }, "peakRssDeltaBytes"],
  ])("rejects %s", (_label, measurements, invalidField) => {
    const baseline = envelope({ revision: "baseline", queued: 1_000 }) as any;
    const candidate = envelope({ revision: "candidate", queued: 100 }) as any;
    Object.assign(baseline.measurements, measurements);
    expect(() => compareStreamingBackpressureResults(baseline, candidate)).toThrow(
      new RegExp(`baseline\\.measurements\\.${invalidField}`),
    );
  });

  it("validates candidate RSS relationships independently", () => {
    const baseline = envelope({ revision: "baseline", queued: 1_000 }) as any;
    const candidate = envelope({ revision: "candidate", queued: 100 }) as any;
    candidate.measurements.peakRssDeltaBytes = 9;
    expect(() => compareStreamingBackpressureResults(baseline, candidate)).toThrow(
      /candidate\.measurements\.peakRssDeltaBytes/,
    );
  });

  it("rejects adapter identities detached from the reported subject", () => {
    const baseline = envelope({ revision: "baseline", queued: 1_000 }) as any;
    const candidate = envelope({ revision: "candidate", queued: 100 }) as any;
    baseline.workload.adapterModule = "/foreign/adapter.js";
    expect(() => compareStreamingBackpressureResults(baseline, candidate)).toThrow(/baseline\.workload\.adapterModule/);
    baseline.workload.adapterModule = "/repo/baseline/src/adapter.js";
    baseline.workload.adapter.sha256 = "not-a-digest";
    expect(() => compareStreamingBackpressureResults(baseline, candidate)).toThrow(
      /baseline\.workload\.adapter\.sha256/,
    );
  });

  it("rejects impossible completed-run source pull counts", () => {
    const baseline = envelope({ revision: "baseline", queued: 1_000 }) as any;
    const candidate = envelope({ revision: "candidate", queued: 100 }) as any;
    baseline.workload.connections = candidate.workload.connections = 2;
    baseline.workload.chunksPerConnection = candidate.workload.chunksPerConnection = 4;
    baseline.measurements.sourcePullCount = candidate.measurements.sourcePullCount = 1;
    expect(() => compareStreamingBackpressureResults(baseline, candidate)).toThrow(
      /baseline\.measurements\.sourcePullCount/,
    );

    baseline.measurements.sourcePullCount = 10;
    candidate.measurements.sourcePullCount = 9;
    expect(() => compareStreamingBackpressureResults(baseline, candidate)).toThrow(
      /candidate\.measurements\.sourcePullCount/,
    );
  });
});
