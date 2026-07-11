import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { identifyStreamingBenchmarkAdapter } from "../benchmark/streaming-subject.js";

const execFileAsync = promisify(execFile);

const repositoryFixture = async (): Promise<{ root: string; adapter: string }> => {
  const root = await mkdtemp(path.join(tmpdir(), "tachyon-stream-subject-"));
  const adapter = path.join(root, "src/adapter.ts");
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "benchmark@example.test"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Benchmark Test"], { cwd: root });
  await mkdir(path.join(root, "src"));
  await writeFile(adapter, "export const adapter = true;\n");
  await execFileAsync("git", ["add", "src/adapter.ts"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "adapter"], { cwd: root });
  return { root, adapter };
};

describe("streaming benchmark adapter identity", () => {
  it("binds a tracked adapter to its subject-relative path and commit bytes", async () => {
    const fixture = await repositoryFixture();
    try {
      await expect(identifyStreamingBenchmarkAdapter(fixture.root, fixture.adapter)).resolves.toMatchObject({
        relativePath: "src/adapter.ts",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        gitBlob: expect.stringMatching(/^[a-f0-9]{40,64}$/),
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects outside, symlinked, untracked, and modified adapters", async () => {
    const fixture = await repositoryFixture();
    const outside = await mkdtemp(path.join(tmpdir(), "tachyon-stream-outside-"));
    try {
      const outsideAdapter = path.join(outside, "adapter.ts");
      await writeFile(outsideAdapter, "export const outside = true;\n");
      await expect(identifyStreamingBenchmarkAdapter(fixture.root, outsideAdapter)).rejects.toThrow(/subject root/);

      const link = path.join(fixture.root, "src/link.ts");
      await symlink(outsideAdapter, link);
      await expect(identifyStreamingBenchmarkAdapter(fixture.root, link)).rejects.toThrow(/subject root/);

      const untracked = path.join(fixture.root, "src/untracked.ts");
      await writeFile(untracked, "export const untracked = true;\n");
      await expect(identifyStreamingBenchmarkAdapter(fixture.root, untracked)).rejects.toThrow(/tracked/);

      await writeFile(fixture.adapter, "export const adapter = false;\n");
      await expect(identifyStreamingBenchmarkAdapter(fixture.root, fixture.adapter)).rejects.toThrow(/reported commit/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
