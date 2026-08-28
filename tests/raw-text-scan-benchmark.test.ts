import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);

it("writes a schema-v2 artifact from the real raw-text scanner benchmark", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tachyon-raw-text-scan-"));
  const output = join(directory, "result.json");
  try {
    const args = [
      "bench:raw-text-scan",
      "--",
      "--samples",
      "1",
      "--warmups",
      "0",
      "--iterations",
      "1",
      "--max-code-units",
      "256",
      "--output",
      output,
    ];
    const execution = await execFileAsync("pnpm", args, {
      cwd: process.cwd(),
      maxBuffer: 16 * 1024 * 1024,
    }).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    expect(execution).toMatchObject({ ok: true });
    if (!execution.ok) return;

    const result = JSON.parse(await readFile(output, "utf8"));
    expect(result).toMatchObject({
      schemaVersion: 2,
      benchmark: { name: "raw-text-scan", contractVersion: 1 },
      workload: { samples: 1, warmups: 0, fixedIterations: 1, maxCodeUnits: 256 },
      provenance: {
        command: { argv: expect.arrayContaining(["--max-code-units", "256"]) },
        git: { available: true, commit: expect.stringMatching(/^[a-f0-9]{40,64}$/) },
        runtime: { node: process.version, platform: process.platform, arch: process.arch },
        dependencies: { tsx: { version: expect.any(String) } },
      },
    });
    const workloads = result.measurements.workloads;
    expect(workloads).toHaveLength(16);

    const short = workloads.filter(({ codeUnits }: { codeUnits: number }) => codeUnits === 16 || codeUnits === 256);
    const longInert = workloads.filter(
      ({ codeUnits, density }: { codeUnits: number; density: string }) =>
        codeUnits === 64 * 1024 && density === "inert",
    );
    const dense = workloads.filter(({ density }: { density: string }) => density === "dense-decoy");
    const ratiosPass = (entries: Array<{ medianRatio: number }>, expectedCount: number, maximum: number): boolean =>
      entries.length === expectedCount && entries.every(({ medianRatio }) => medianRatio <= maximum);

    expect(result.measurements.evaluation).toEqual({
      eligible: false,
      complete: false,
      canonicalControls: false,
      shortPass: ratiosPass(short, 16, 1.1),
      longInertPass: ratiosPass(longInert, 4, 1 / 1.5),
      densePass: ratiosPass(dense, 20, 1.1),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
