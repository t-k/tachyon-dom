import { describe, expect, it } from "vitest";

import { validateLocalCompareRuns } from "../benchmark/local-compare/validation.js";

const run = () => ({
  schemaVersion: 2,
  benchmark: { name: "local-compare", contractVersion: 2 },
  provenance: {
    capturedAt: "2026-07-11T00:00:00.000Z",
    command: { argv: ["pnpm", "bench"], display: "pnpm bench", cwd: "/repo" },
    git: { available: true, commit: "a".repeat(40), dirty: false, workingTreeSha256: "b".repeat(64) },
    runtime: { node: "v24.0.0", platform: "linux", arch: "x64", osRelease: "test" },
    host: { hostname: "host", cpuModel: "cpu", logicalCpuCount: 8 },
    browser: { name: "chromium", version: "140" },
    dependencies: { vite: { version: "8.0.16" } },
  },
  workload: {
    iterations: 5,
    warmup: 2,
    serveMode: "production",
    operationStatistic: "trimmedMean",
    trimFraction: 0.2,
    baseline: "vanillajs-lite-keyed",
    candidate: "tachyon-dom",
    implementations: ["vanillajs-lite-keyed", "tachyon-dom"],
  },
  measurements: {
    summaries: [
      { id: "render", label: "render", implementation: "vanillajs-lite-keyed", trimmedMean: 1 },
      { id: "render", label: "render", implementation: "tachyon-dom", trimmedMean: 1 },
    ],
    auxiliaryMetrics: [
      { id: "size", label: "size", unit: "kib", implementation: "vanillajs-lite-keyed", value: 1 },
      { id: "size", label: "size", unit: "kib", implementation: "tachyon-dom", value: 1 },
    ],
  },
});

describe("local compare validation", () => {
  it("returns machine-readable verified controls for authoritative runs", () => {
    const result = validateLocalCompareRuns([run(), run()]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.invalidFields.join(", "));
    expect(result.verifiedControls).toMatchObject({
      baseline: "vanillajs-lite-keyed",
      candidate: "tachyon-dom",
      git: { commit: "a".repeat(40), dirty: false, workingTreeSha256: "b".repeat(64) },
      browser: { name: "chromium", version: "140" },
      runtime: { node: "v24.0.0" },
      host: { cpuModel: "cpu", logicalCpuCount: 8 },
      dependencies: { vite: { version: "8.0.16" } },
      workload: { iterations: 5, warmup: 2 },
    });
  });

  it.each([-0.1, 0.5, 2, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects out-of-domain trimFraction %s",
    (trimFraction) => {
      const value = run();
      value.workload.trimFraction = trimFraction;
      const result = validateLocalCompareRuns([value]);
      expect(result).toEqual(expect.objectContaining({ ok: false }));
      if (result.ok) throw new Error("Expected invalid run");
      expect(result.invalidFields).toContain("runs[0].workload.trimFraction");
    },
  );

  it.each([
    ["serveMode", "preview"],
    ["operationStatistic", "median"],
  ] as const)("rejects unknown workload enum %s=%s", (field, invalidValue) => {
    const value = run();
    value.workload[field] = invalidValue;
    const result = validateLocalCompareRuns([value]);
    expect(result).toEqual(expect.objectContaining({ ok: false }));
    if (result.ok) throw new Error("Expected invalid run");
    expect(result.invalidFields).toContain(`runs[0].workload.${field}`);
  });

  it.each([
    ["missing summary implementation", "summaries", (entries: any[]) => entries.pop()],
    ["duplicate summary implementation", "summaries", (entries: any[]) => entries.push({ ...entries[0] })],
    ["missing auxiliary implementation", "auxiliaryMetrics", (entries: any[]) => entries.pop()],
    [
      "duplicate auxiliary implementation",
      "auxiliaryMetrics",
      (entries: any[]) => entries.push({ ...entries[0] }),
    ],
  ])("rejects %s for each metric id", (_label, collectionName, mutate) => {
    const value = run();
    mutate(value.measurements[collectionName as "summaries" | "auxiliaryMetrics"]);
    const result = validateLocalCompareRuns([value]);
    expect(result).toEqual(expect.objectContaining({ ok: false }));
    if (result.ok) throw new Error("Expected invalid run");
    expect(result.invalidFields).toContain(`runs[0].measurements.${collectionName}`);
  });

  it.each([
    [
      "browser version",
      (value: ReturnType<typeof run>) => ((value.provenance.browser.version as unknown) = null),
      "provenance.browser.version",
    ],
    [
      "summaries shape",
      (value: ReturnType<typeof run>) => ((value.measurements.summaries as unknown) = {}),
      "measurements.summaries",
    ],
    [
      "empty summaries",
      (value: ReturnType<typeof run>) => value.measurements.summaries.splice(0),
      "measurements.summaries",
    ],
    [
      "unknown implementation",
      (value: ReturnType<typeof run>) => (value.measurements.summaries[0]!.implementation = "unknown"),
      "measurements.summaries[0].implementation",
    ],
    [
      "summary metric",
      (value: ReturnType<typeof run>) =>
        ((value.measurements.summaries[0]!.trimmedMean as number) = Number.NaN),
      "measurements.summaries[0].trimmedMean",
    ],
    [
      "auxiliary metric",
      (value: ReturnType<typeof run>) =>
        ((value.measurements.auxiliaryMetrics[0]!.value as number) = Number.POSITIVE_INFINITY),
      "measurements.auxiliaryMetrics[0].value",
    ],
  ])("rejects malformed decoded %s", (_label, mutate, invalidPath) => {
    const value = run();
    mutate(value);
    const result = validateLocalCompareRuns([value]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected invalid run");
    expect(result.invalidFields).toContain(`runs[0].${invalidPath}`);
  });

  it.each([
    [
      "candidate mismatch",
      (value: ReturnType<typeof run>) => (value.workload.candidate = "other"),
      "workload.candidate",
    ],
    ["baseline mismatch", (value: ReturnType<typeof run>) => (value.workload.baseline = "other"), "workload.baseline"],
    ["candidate absent", (value: ReturnType<typeof run>) => value.workload.implementations.pop(), "workload.candidate"],
    [
      "baseline duplicated",
      (value: ReturnType<typeof run>) => value.workload.implementations.unshift("vanillajs-lite-keyed"),
      "workload.implementations",
    ],
    [
      "null iterations",
      (value: ReturnType<typeof run>) => ((value.workload.iterations as unknown) = null),
      "workload.iterations",
    ],
  ])("rejects %s", (_label, mutate, invalidPath) => {
    const baseline = run();
    const candidate = run();
    mutate(candidate);
    const result = validateLocalCompareRuns([baseline, candidate]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected invalid runs");
    expect(result.invalidFields.some((field) => field.includes(invalidPath))).toBe(true);
  });
});
