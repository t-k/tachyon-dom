import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const git = async (root: string, args: readonly string[]): Promise<string> =>
  (await execFileAsync("git", args, { cwd: root, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();

export type StreamingBenchmarkAdapterIdentity = {
  subjectRoot: string;
  adapterModule: string;
  commit: string;
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
    commit,
    relativePath: relativePath.split(path.sep).join("/"),
    sha256: createHash("sha256").update(content).digest("hex"),
    gitBlob,
  };
};

export type PreparedStreamingBenchmarkAdapter = StreamingBenchmarkAdapterIdentity & {
  executionModule: string;
  cleanup: () => Promise<void>;
};

export const prepareStreamingBenchmarkAdapter = async (
  subjectRoot: string,
  adapterModule: string,
): Promise<PreparedStreamingBenchmarkAdapter> => {
  const identity = await identifyStreamingBenchmarkAdapter(subjectRoot, adapterModule);
  const snapshotRoot = await mkdtemp(path.join(os.tmpdir(), "tachyon-benchmark-subject-"));
  await rm(snapshotRoot, { recursive: true, force: true });
  let added = false;
  try {
    await git(identity.subjectRoot, ["worktree", "add", "--detach", snapshotRoot, identity.commit]);
    added = true;
    const sourceNodeModules = path.join(identity.subjectRoot, "node_modules");
    try {
      await access(sourceNodeModules);
      await symlink(sourceNodeModules, path.join(snapshotRoot, "node_modules"), "dir");
    } catch {
      // The adapter may have no package dependencies, so node_modules is optional.
    }
    const executionModule = path.join(snapshotRoot, ...identity.relativePath.split("/"));
    const content = await readFile(executionModule);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const snapshotBlob = await git(snapshotRoot, ["hash-object", executionModule]);
    if (sha256 !== identity.sha256 || snapshotBlob !== identity.gitBlob) {
      throw new Error("Prepared benchmark snapshot does not match the pinned adapter identity.");
    }
    let cleaned = false;
    return {
      ...identity,
      sha256,
      executionModule,
      cleanup: async () => {
        if (cleaned) return;
        cleaned = true;
        try {
          await git(identity.subjectRoot, ["worktree", "remove", "--force", snapshotRoot]);
        } catch (error) {
          await rm(snapshotRoot, { recursive: true, force: true });
          await git(identity.subjectRoot, ["worktree", "prune"]);
          throw error;
        }
      },
    };
  } catch (error) {
    if (added) {
      await git(identity.subjectRoot, ["worktree", "remove", "--force", snapshotRoot]).catch(async () => {
        await git(identity.subjectRoot, ["worktree", "prune"]).catch(() => undefined);
      });
    }
    await rm(snapshotRoot, { recursive: true, force: true });
    throw error;
  }
};
