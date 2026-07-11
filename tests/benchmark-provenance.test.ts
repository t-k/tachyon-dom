import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  collectBenchmarkProvenance,
  collectDependencyVersions,
  compareBenchmarkEnvelopes,
  type BenchmarkEnvelope,
} from "../benchmark/provenance";

const execFileAsync = promisify(execFile);

const commitFixture = async (directory: string): Promise<string> => {
  await execFileAsync("git", ["init"], { cwd: directory });
  await execFileAsync("git", ["config", "user.email", "benchmark@example.com"], { cwd: directory });
  await execFileAsync("git", ["config", "user.name", "Benchmark Test"], { cwd: directory });
  await writeFile(path.join(directory, "tracked.txt"), "clean\n");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: directory });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: directory });
  return (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: directory })).stdout.trim();
};

describe("benchmark provenance", () => {
  it("records clean, dirty, command, runtime, and unavailable Git metadata", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "tachyon-provenance-repo-"));
    const nonRepository = await mkdtemp(path.join(tmpdir(), "tachyon-provenance-nonrepo-"));
    try {
      const commit = await commitFixture(repository);
      const argv = ["pnpm", "bench file.ts", "--label", "a'b", "--output", "x y.json"];
      const clean = await collectBenchmarkProvenance({ cwd: repository, argv });

      expect(clean.command.argv).toEqual(argv);
      expect(clean.command.display).toContain("'a'\"'\"'b'");
      expect(clean.git).toMatchObject({ available: true, commit, dirty: false });
      expect(clean.git.workingTreeSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(clean.runtime.node).toBe(process.version);
      expect(clean.runtime).toMatchObject({ platform: process.platform, arch: process.arch });
      expect(clean.host.cpuModel.length).toBeGreaterThan(0);
      expect(clean.host.logicalCpuCount).toBeGreaterThan(0);

      await writeFile(path.join(repository, "tracked.txt"), "dirty\n");
      await writeFile(path.join(repository, "untracked.txt"), "untracked\n");
      const dirty = await collectBenchmarkProvenance({ cwd: repository, argv });
      expect(dirty.git.dirty).toBe(true);
      expect(dirty.git.workingTreeSha256).not.toBe(clean.git.workingTreeSha256);

      const unavailable = await collectBenchmarkProvenance({ cwd: nonRepository, argv });
      expect(unavailable.git).toMatchObject({ available: false, commit: null, dirty: null });
      expect(unavailable.git.reason).toBeTruthy();
    } finally {
      await rm(repository, { recursive: true, force: true });
      await rm(nonRepository, { recursive: true, force: true });
    }
  });

  it("fails closed instead of following untracked symlinks while hashing provenance", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "tachyon-provenance-symlink-"));
    const external = await mkdtemp(path.join(tmpdir(), "tachyon-provenance-external-"));
    try {
      await commitFixture(repository);
      const secret = path.join(external, "secret.txt");
      await writeFile(secret, "must-not-be-read\n");
      await symlink(secret, path.join(repository, "untracked-link"));
      const provenance = await collectBenchmarkProvenance({ cwd: repository, argv: ["benchmark"] });
      expect(provenance.git.available).toBe(false);
      expect(provenance.git.reason).toContain("untracked-link");
      expect(provenance.git.reason).toMatch(/(?:ELOOP|regular file)/);
    } finally {
      await rm(repository, { recursive: true, force: true });
      await rm(external, { recursive: true, force: true });
    }
  });

  it("rejects accidental comparison mismatches and reports intentional revision differences", () => {
    const envelope = (commit: string, connections: number): BenchmarkEnvelope<Record<string, unknown>, unknown> => ({
      schemaVersion: 2,
      benchmark: { name: "streaming-backpressure", contractVersion: 2 },
      provenance: {
        capturedAt: "2026-07-10T00:00:00.000Z",
        command: { argv: ["pnpm", "bench"], display: "pnpm bench", cwd: "/repo" },
        git: { available: true, commit, dirty: false, workingTreeSha256: "a".repeat(64) },
        runtime: { node: "v24.0.0", platform: "linux", arch: "x64", osRelease: "test" },
        host: { hostname: "host", cpuModel: "cpu", logicalCpuCount: 8 },
        dependencies: { tsx: { version: "4.22.4" } },
      },
      workload: { connections, chunksPerConnection: 128, chunkBytes: 32768, drainDelayMs: 2 },
      measurements: {},
    });

    const compatible = compareBenchmarkEnvelopes(envelope("base", 6), envelope("candidate", 6), {
      requiredEqualPaths: [
        "benchmark.name",
        "benchmark.contractVersion",
        "workload.connections",
        "workload.chunksPerConnection",
        "workload.chunkBytes",
        "workload.drainDelayMs",
        "provenance.runtime",
        "provenance.host.cpuModel",
      ],
      allowedDifferences: ["provenance.git.commit"],
    });
    expect(compatible.compatible).toBe(true);
    expect(compatible.intentionalDifferences).toEqual([
      expect.objectContaining({ path: "provenance.git.commit", baseline: "base", candidate: "candidate" }),
    ]);

    const mismatch = compareBenchmarkEnvelopes(envelope("base", 6), envelope("candidate", 7), {
      requiredEqualPaths: ["workload.connections"],
      allowedDifferences: ["provenance.git.commit"],
    });
    expect(mismatch.compatible).toBe(false);
    expect(mismatch.accidentalDifferences).toEqual([
      expect.objectContaining({ path: "workload.connections", baseline: 6, candidate: 7 }),
    ]);

    const legacy = compareBenchmarkEnvelopes({ controls: {} }, envelope("candidate", 6), {
      requiredEqualPaths: ["workload.connections"],
    });
    expect(legacy).toMatchObject({ compatible: false, legacyIncomplete: true });
  });

  it("rejects schema-v2 comparisons when required provenance or workload fields are missing", () => {
    const envelope = (): BenchmarkEnvelope<Record<string, unknown>, unknown> => ({
      schemaVersion: 2,
      benchmark: { name: "streaming-backpressure", contractVersion: 2 },
      provenance: {
        capturedAt: "2026-07-10T00:00:00.000Z",
        command: { argv: ["pnpm", "bench"], display: "pnpm bench", cwd: "/repo" },
        git: { available: true, commit: "a".repeat(40), dirty: false, workingTreeSha256: "b".repeat(64) },
        runtime: { node: "v24.0.0", platform: "linux", arch: "x64", osRelease: "test" },
        host: { hostname: "host", cpuModel: "cpu", logicalCpuCount: 8 },
        dependencies: { tsx: { version: "4.22.4" } },
      },
      workload: { connections: 6 },
      measurements: {},
    });
    const missingRuntimeBaseline = structuredClone(envelope()) as any;
    const missingRuntimeCandidate = structuredClone(envelope()) as any;
    delete missingRuntimeBaseline.provenance.runtime.node;
    delete missingRuntimeCandidate.provenance.runtime.node;

    const missingRuntime = compareBenchmarkEnvelopes(missingRuntimeBaseline, missingRuntimeCandidate, {
      requiredEqualPaths: ["workload.connections"],
    });
    expect(missingRuntime).toMatchObject({ compatible: false, legacyIncomplete: false });
    expect(missingRuntime.invalidFields).toContain("baseline.provenance.runtime.node");
    expect(missingRuntime.invalidFields).toContain("candidate.provenance.runtime.node");

    const missingWorkloadBaseline = structuredClone(envelope()) as any;
    const missingWorkloadCandidate = structuredClone(envelope()) as any;
    delete missingWorkloadBaseline.workload.connections;
    delete missingWorkloadCandidate.workload.connections;
    const missingWorkload = compareBenchmarkEnvelopes(missingWorkloadBaseline, missingWorkloadCandidate, {
      requiredEqualPaths: ["workload.connections"],
    });
    expect(missingWorkload.invalidFields).toEqual(["baseline.workload.connections", "candidate.workload.connections"]);

    const nullWorkloadBaseline = structuredClone(envelope()) as any;
    const nullWorkloadCandidate = structuredClone(envelope()) as any;
    nullWorkloadBaseline.workload.connections = null;
    nullWorkloadCandidate.workload.connections = null;
    const nullWorkload = compareBenchmarkEnvelopes(nullWorkloadBaseline, nullWorkloadCandidate, {
      requiredEqualPaths: ["workload.connections"],
    });
    expect(nullWorkload.invalidFields).toEqual(["baseline.workload.connections", "candidate.workload.connections"]);

    const unavailableDependencyBaseline = structuredClone(envelope()) as any;
    const unavailableDependencyCandidate = structuredClone(envelope()) as any;
    unavailableDependencyBaseline.provenance.dependencies.tsx = { version: null, reason: "not found" };
    unavailableDependencyCandidate.provenance.dependencies.tsx = { version: null, reason: "not found" };
    const unavailableDependency = compareBenchmarkEnvelopes(
      unavailableDependencyBaseline,
      unavailableDependencyCandidate,
      { requiredEqualPaths: ["provenance.dependencies", "workload.connections"] },
    );
    expect(unavailableDependency.invalidFields).toContain("baseline.provenance.dependencies");
    expect(unavailableDependency.invalidFields).toContain("candidate.provenance.dependencies");

    const wrongTypeBaseline = structuredClone(envelope()) as any;
    wrongTypeBaseline.provenance.host.logicalCpuCount = "8";
    const wrongType = compareBenchmarkEnvelopes(wrongTypeBaseline, envelope(), {
      requiredEqualPaths: ["workload.connections"],
    });
    expect(wrongType.invalidFields).toContain("baseline.provenance.host.logicalCpuCount");
  });

  it("rejects authoritative comparisons from dirty or unavailable Git sources", () => {
    const envelope = (): BenchmarkEnvelope<Record<string, unknown>, unknown> => ({
      schemaVersion: 2,
      benchmark: { name: "local-compare", contractVersion: 2 },
      provenance: {
        capturedAt: "2026-07-10T00:00:00.000Z",
        command: { argv: ["pnpm", "bench"], display: "pnpm bench", cwd: "/repo" },
        git: { available: true, commit: "a".repeat(40), dirty: false, workingTreeSha256: "b".repeat(64) },
        runtime: { node: "v24.0.0", platform: "linux", arch: "x64", osRelease: "test" },
        host: { hostname: "host", cpuModel: "cpu", logicalCpuCount: 8 },
        dependencies: { tsx: { version: "4.22.4" } },
      },
      workload: { iterations: 3 },
      measurements: {},
    });
    const dirty = structuredClone(envelope());
    dirty.provenance.git.dirty = true;
    const dirtyComparison = compareBenchmarkEnvelopes(dirty, dirty, {
      requiredEqualPaths: ["provenance.git.commit", "provenance.git.workingTreeSha256", "workload.iterations"],
    });
    expect(dirtyComparison).toMatchObject({ compatible: false, legacyIncomplete: false });
    expect(dirtyComparison.invalidFields).toContain("baseline.provenance.git.dirty");
    expect(dirtyComparison.invalidFields).toContain("candidate.provenance.git.dirty");

    const unavailable = structuredClone(envelope());
    unavailable.provenance.git = {
      available: false,
      commit: null,
      dirty: null,
      workingTreeSha256: null,
      reason: "not a repository",
    };
    const unavailableComparison = compareBenchmarkEnvelopes(unavailable, unavailable, {
      requiredEqualPaths: ["provenance.git.commit", "workload.iterations"],
    });
    expect(unavailableComparison.invalidFields).toContain("baseline.provenance.git.available");
    expect(unavailableComparison.invalidFields).toContain("candidate.provenance.git.available");

    const missingDependencies = structuredClone(envelope());
    missingDependencies.provenance.dependencies = {};
    const dependencyComparison = compareBenchmarkEnvelopes(missingDependencies, envelope(), {
      requiredEqualPaths: ["provenance.dependencies", "workload.iterations"],
    });
    expect(dependencyComparison.invalidFields).toContain("baseline.provenance.dependencies");
  });

  it("records resolved and unavailable dependency versions from the requested project", async () => {
    const dependencies = await collectDependencyVersions(process.cwd(), [
      "vite",
      "@marko/run",
      "missing-benchmark-package",
    ]);

    expect(dependencies.vite?.version).toMatch(/^8\./);
    expect(dependencies["@marko/run"]?.version).toMatch(/^0\.10\./);
    expect(dependencies["missing-benchmark-package"]).toMatchObject({ version: null });
    expect(dependencies["missing-benchmark-package"]?.reason).toBeTruthy();
  });

  it("writes a provenance envelope from the real TCP backpressure harness", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tachyon-backpressure-envelope-"));
    const output = path.join(directory, "result.json");
    const subject = path.join(process.cwd(), ".worktrees", `.benchmark-test-${path.basename(directory)}`);
    try {
      await execFileAsync("git", ["worktree", "add", "--detach", subject, "HEAD"], { cwd: process.cwd() });
      await mkdir(path.join(subject, "node_modules"));
      await symlink(
        await realpath(path.join(process.cwd(), "node_modules/parse5")),
        path.join(subject, "node_modules/parse5"),
        "dir",
      );
      await execFileAsync(
        "pnpm",
        [
          "exec",
          "tsx",
          "benchmark/streaming-backpressure.ts",
          "--connections",
          "1",
          "--chunks",
          "8",
          "--chunk-bytes",
          "4096",
          "--drain-delay-ms",
          "1",
          "--label",
          "test",
          "--subject-root",
          subject,
          "--adapter-module",
          path.join(subject, "src/adapters/node.ts"),
          "--output",
          output,
        ],
        { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 },
      );
      const result = JSON.parse(await readFile(output, "utf8")) as BenchmarkEnvelope<
        { transport?: string; connections?: number },
        { completionTimeMs?: number; sourcePullCount?: number }
      >;

      expect(result.schemaVersion).toBe(2);
      expect(result.benchmark).toEqual({ name: "streaming-backpressure", contractVersion: 2 });
      expect(result.workload).toMatchObject({ transport: "tcp", connections: 1 });
      expect(result.provenance.command.argv).toContain("--connections");
      expect(result.measurements.completionTimeMs).toBeGreaterThan(0);
      expect(result.measurements.sourcePullCount).toBeGreaterThan(0);
    } finally {
      await execFileAsync("git", ["worktree", "remove", "--force", subject], { cwd: process.cwd() }).catch(
        () => undefined,
      );
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("labels HTML minification as a same-checkout algorithm comparison", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tachyon-html-benchmark-envelope-"));
    const output = path.join(directory, "result.json");
    try {
      await execFileAsync(
        "pnpm",
        ["exec", "tsx", "benchmark/html-minification.ts", "--iterations", "1", "--output", output],
        { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 },
      );
      const result = JSON.parse(await readFile(output, "utf8")) as any;
      expect(result.workload.algorithms).toEqual({ baseline: "legacyMinifyHtml", candidate: "minifyHtml" });
      expect(result.workload).not.toHaveProperty("baselineRevision");
      expect(result.workload).not.toHaveProperty("candidateRevision");
      expect(result.provenance.dependencies.parse5.version).toMatch(/^7\./);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
