import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const git = async (root: string, args: readonly string[]): Promise<string> =>
  (await execFileAsync("git", args, { cwd: root, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();

export type StreamingBenchmarkAdapterIdentity = {
  subjectRoot: string;
  adapterModule: string;
  relativePath: string;
  sha256: string;
  gitBlob: string;
};

export const identifyStreamingBenchmarkAdapter = async (
  subjectRoot: string,
  adapterModule: string,
): Promise<StreamingBenchmarkAdapterIdentity> => {
  const [canonicalRoot, canonicalAdapter] = await Promise.all([realpath(subjectRoot), realpath(adapterModule)]);
  const relativePath = path.relative(canonicalRoot, canonicalAdapter);
  if (!relativePath || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error(`Benchmark adapter must be a file inside the subject root: ${canonicalAdapter}`);
  }
  try {
    await git(canonicalRoot, ["ls-files", "--error-unmatch", "--", relativePath]);
  } catch {
    throw new Error(`Benchmark adapter must be tracked by the subject repository: ${relativePath}`);
  }
  const commit = await git(canonicalRoot, ["rev-parse", "HEAD"]);
  const [gitBlob, measuredBlob, content] = await Promise.all([
    git(canonicalRoot, ["rev-parse", `${commit}:${relativePath}`]),
    git(canonicalRoot, ["hash-object", canonicalAdapter]),
    readFile(canonicalAdapter),
  ]);
  if (gitBlob !== measuredBlob) {
    throw new Error(`Benchmark adapter bytes do not match the reported commit: ${relativePath}`);
  }
  return {
    subjectRoot: canonicalRoot,
    adapterModule: canonicalAdapter,
    relativePath: relativePath.split(path.sep).join("/"),
    sha256: createHash("sha256").update(content).digest("hex"),
    gitBlob,
  };
};
