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
  measurements: { summaries: [], auxiliaryMetrics: [] },
});

describe("local compare validation", () => {
  it("returns machine-readable verified controls for authoritative runs", () => {
    const result = validateLocalCompareRuns([run(), run()]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.invalidFields.join(", "));
    expect(result.verifiedControls).toMatchObject({
      baseline: "vanillajs-lite-keyed",
      candidate: "tachyon-dom",
      runtime: { node: "v24.0.0" },
      host: { cpuModel: "cpu", logicalCpuCount: 8 },
      dependencies: { vite: { version: "8.0.16" } },
      workload: { iterations: 5, warmup: 2 },
    });
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
