import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify, isDeepStrictEqual } from "node:util";
import { validateBenchmarkEnvelope, valueAtBenchmarkPath } from "./provenance-validation.js";

const execFileAsync = promisify(execFile);
const MAX_UNTRACKED_FILE_BYTES = 16 * 1024 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = 64 * 1024 * 1024;

export type BenchmarkDependency = {
  version: string | null;
  reason?: string;
};

export type BenchmarkProvenance = {
  capturedAt: string;
  command: { argv: string[]; display: string; cwd: string };
  git: {
    available: boolean;
    commit: string | null;
    dirty: boolean | null;
    workingTreeSha256: string | null;
    reason?: string;
  };
  runtime: { node: string; platform: string; arch: string; osRelease: string };
  host: { hostname: string; cpuModel: string; logicalCpuCount: number };
  dependencies: Record<string, BenchmarkDependency>;
  browser?: { name: string; version: string };
};

export type BenchmarkEnvelope<Workload, Measurements> = {
  schemaVersion: 2;
  benchmark: { name: string; contractVersion: number };
  provenance: BenchmarkProvenance;
  workload: Workload;
  measurements: Measurements;
};

const quoteArgument = (argument: string): string =>
  /^[A-Za-z0-9_./:=@+-]+$/.test(argument) ? argument : `'${argument.replaceAll("'", `'"'"'`)}'`;

const git = async (cwd: string, args: readonly string[]): Promise<string> =>
  (await execFileAsync("git", [...args], { cwd, maxBuffer: 16 * 1024 * 1024 })).stdout;

const readBoundedRegularFile = async (absoluteFile: string, relativeFile: string): Promise<Buffer> => {
  const handle = await open(absoluteFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error(`Untracked provenance path ${relativeFile} must be a regular file.`);
    if (metadata.size > MAX_UNTRACKED_FILE_BYTES) {
      throw new Error(`Untracked provenance file ${relativeFile} exceeds ${MAX_UNTRACKED_FILE_BYTES} bytes.`);
    }
    const content = Buffer.allocUnsafe(Math.min(metadata.size + 1, MAX_UNTRACKED_FILE_BYTES + 1));
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_UNTRACKED_FILE_BYTES) {
      throw new Error(`Untracked provenance file ${relativeFile} exceeds ${MAX_UNTRACKED_FILE_BYTES} bytes.`);
    }
    const verified = await handle.stat();
    if (!verified.isFile() || verified.dev !== metadata.dev || verified.ino !== metadata.ino || verified.size !== offset) {
      throw new Error(`Untracked provenance file ${relativeFile} changed while it was being hashed.`);
    }
    return content.subarray(0, offset);
  } finally {
    await handle.close();
  }
};

const workingTreeHash = async (cwd: string, commit: string): Promise<string> => {
  const [status, diff, untracked] = await Promise.all([
    git(cwd, ["status", "--porcelain=v1", "-z"]),
    git(cwd, ["diff", "--binary", "HEAD"]),
    git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const hash = createHash("sha256").update(commit).update("\0").update(status).update("\0").update(diff);
  let totalBytes = 0;
  for (const relativeFile of untracked.split("\0").filter(Boolean).sort()) {
    const absoluteFile = path.join(cwd, relativeFile);
    const content = await readBoundedRegularFile(absoluteFile, relativeFile);
    totalBytes += content.byteLength;
    if (totalBytes > MAX_UNTRACKED_TOTAL_BYTES) {
      throw new Error(`Untracked provenance files exceed ${MAX_UNTRACKED_TOTAL_BYTES} bytes in total.`);
    }
    hash
      .update("\0")
      .update(relativeFile)
      .update("\0")
      .update(content);
  }
  return hash.digest("hex");
};

const collectGit = async (cwd: string): Promise<BenchmarkProvenance["git"]> => {
  try {
    const commit = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    const status = await git(cwd, ["status", "--porcelain=v1", "-z"]);
    return {
      available: true,
      commit,
      dirty: status.length > 0,
      workingTreeSha256: await workingTreeHash(cwd, commit),
    };
  } catch (error) {
    return {
      available: false,
      commit: null,
      dirty: null,
      workingTreeSha256: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};

export const collectBenchmarkProvenance = async (options: {
  cwd: string;
  argv: readonly string[];
  dependencies?: Record<string, BenchmarkDependency>;
  browser?: { name: string; version: string };
}): Promise<BenchmarkProvenance> => {
  const cpus = os.cpus();
  return {
    capturedAt: new Date().toISOString(),
    command: {
      argv: [...options.argv],
      display: options.argv.map(quoteArgument).join(" "),
      cwd: path.resolve(options.cwd),
    },
    git: await collectGit(options.cwd),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
    },
    host: {
      hostname: os.hostname(),
      cpuModel: cpus[0]?.model ?? "unknown",
      logicalCpuCount: cpus.length,
    },
    dependencies: options.dependencies ?? {},
    ...(options.browser ? { browser: options.browser } : {}),
  };
};

export const collectDependencyVersions = async (
  cwd: string,
  packageNames: readonly string[],
): Promise<Record<string, BenchmarkDependency>> => {
  const requireFromProject = createRequire(path.join(path.resolve(cwd), "package.json"));
  const entries = await Promise.all(
    packageNames.map(async (packageName) => {
      try {
        let packageFile: string;
        try {
          packageFile = requireFromProject.resolve(`${packageName}/package.json`);
        } catch {
          let directory = path.dirname(requireFromProject.resolve(packageName));
          while (true) {
            const candidate = path.join(directory, "package.json");
            try {
              const manifest = JSON.parse(await readFile(candidate, "utf8")) as { name?: unknown };
              if (manifest.name === packageName) {
                packageFile = candidate;
                break;
              }
            } catch {
              // Continue toward the filesystem root.
            }
            const parent = path.dirname(directory);
            if (parent === directory) throw new Error(`Could not locate package.json for ${packageName}.`);
            directory = parent;
          }
        }
        const manifest = JSON.parse(await readFile(packageFile, "utf8")) as { version?: unknown };
        if (typeof manifest.version !== "string") throw new Error(`${packageFile} has no string version.`);
        return [packageName, { version: manifest.version }] as const;
      } catch (error) {
        return [
          packageName,
          {
            version: null,
            reason: error instanceof Error ? error.message : String(error),
          },
        ] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
};

export type BenchmarkDifference = {
  path: string;
  baseline: unknown;
  candidate: unknown;
};

export type BenchmarkComparison = {
  compatible: boolean;
  legacyIncomplete: boolean;
  invalidFields: string[];
  intentionalDifferences: BenchmarkDifference[];
  accidentalDifferences: BenchmarkDifference[];
};

const isEnvelope = (value: unknown): value is BenchmarkEnvelope<unknown, unknown> =>
  typeof value === "object" &&
  value !== null &&
  (value as { schemaVersion?: unknown }).schemaVersion === 2 &&
  typeof (value as { provenance?: unknown }).provenance === "object";

export const compareBenchmarkEnvelopes = (
  baseline: unknown,
  candidate: unknown,
  options: { requiredEqualPaths: readonly string[]; allowedDifferences?: readonly string[] },
): BenchmarkComparison => {
  if (!isEnvelope(baseline) || !isEnvelope(candidate)) {
    return {
      compatible: false,
      legacyIncomplete: true,
      invalidFields: [],
      intentionalDifferences: [],
      accidentalDifferences: [],
    };
  }
  const requiredPaths = [...new Set([...options.requiredEqualPaths, ...(options.allowedDifferences ?? [])])];
  const baselineValidation = validateBenchmarkEnvelope(baseline, requiredPaths);
  const candidateValidation = validateBenchmarkEnvelope(candidate, requiredPaths);
  const invalidFields = [
    ...(baselineValidation.valid ? [] : baselineValidation.invalidFields.map((field) => `baseline.${field}`)),
    ...(candidateValidation.valid ? [] : candidateValidation.invalidFields.map((field) => `candidate.${field}`)),
  ];
  for (const [label, envelope] of [
    ["baseline", baseline],
    ["candidate", candidate],
  ] as const) {
    if (envelope.provenance.git.available !== true) {
      invalidFields.push(`${label}.provenance.git.available`);
    } else if (envelope.provenance.git.dirty !== false) {
      invalidFields.push(`${label}.provenance.git.dirty`);
    }
    if (Object.keys(envelope.provenance.dependencies).length === 0) {
      invalidFields.push(`${label}.provenance.dependencies`);
    }
  }
  if (invalidFields.length > 0) {
    return {
      compatible: false,
      legacyIncomplete: false,
      invalidFields,
      intentionalDifferences: [],
      accidentalDifferences: [],
    };
  }
  const allowed = new Set(options.allowedDifferences ?? []);
  const intentionalDifferences = [...allowed].flatMap((fieldPath) => {
    const baselineValue = valueAtBenchmarkPath(baseline, fieldPath);
    const candidateValue = valueAtBenchmarkPath(candidate, fieldPath);
    return isDeepStrictEqual(baselineValue, candidateValue)
      ? []
      : [{ path: fieldPath, baseline: baselineValue, candidate: candidateValue }];
  });
  const accidentalDifferences = options.requiredEqualPaths.flatMap((fieldPath) => {
    if (allowed.has(fieldPath)) return [];
    const baselineValue = valueAtBenchmarkPath(baseline, fieldPath);
    const candidateValue = valueAtBenchmarkPath(candidate, fieldPath);
    return isDeepStrictEqual(baselineValue, candidateValue)
      ? []
      : [{ path: fieldPath, baseline: baselineValue, candidate: candidateValue }];
  });
  return {
    compatible: accidentalDifferences.length === 0,
    legacyIncomplete: false,
    invalidFields: [],
    intentionalDifferences,
    accidentalDifferences,
  };
};
