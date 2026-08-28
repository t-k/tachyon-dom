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
    });
    expect(result.measurements.workloads.length).toBeGreaterThan(0);
    expect(result.measurements.evaluation).toMatchObject({ eligible: expect.any(Boolean) });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
