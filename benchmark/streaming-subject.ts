import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
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

export type StreamingBenchmarkDependencySnapshot = {
  lockfileSha256: string;
  treeSha256: string;
  packageManager: string;
};

const sha256 = (content: Uint8Array | string): string => createHash("sha256").update(content).digest("hex");

const isInside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

type InodeRecord = { nlink: bigint; paths: string[] };

const collectSnapshotInodes = async (snapshotRoot: string): Promise<Map<string, InodeRecord>> => {
  const records = new Map<string, InodeRecord>();
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const metadata = await lstat(absolute, { bigint: true });
      if (metadata.isDirectory()) {
        await visit(absolute);
      } else if (metadata.isFile()) {
        const key = `${metadata.dev}:${metadata.ino}`;
        const record = records.get(key) ?? { nlink: metadata.nlink, paths: [] };
        if (record.nlink !== metadata.nlink) throw new Error(`Inconsistent hardlink metadata: ${absolute}`);
        record.paths.push(absolute);
        records.set(key, record);
      }
    }
  };
  await visit(snapshotRoot);
  return records;
};

const hashPrivateDependencyTree = async (snapshotRoot: string, nodeModules: string): Promise<string> => {
  const [canonicalSnapshotRoot, canonicalNodeModules] = await Promise.all([
    realpath(snapshotRoot),
    realpath(nodeModules),
  ]);
  const inodes = await collectSnapshotInodes(canonicalSnapshotRoot);
  const hash = createHash("sha256");
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(canonicalNodeModules, absolute).split(path.sep).join("/");
      const metadata = await lstat(absolute, { bigint: true });
      if (metadata.isSymbolicLink()) {
        const resolved = await realpath(absolute);
        if (!isInside(canonicalSnapshotRoot, resolved)) {
          throw new Error(`Prepared dependency symlink escapes the private snapshot: ${relative}`);
        }
        hash.update(
          `link\0${relative}\0${path.relative(canonicalSnapshotRoot, resolved).split(path.sep).join("/")}\0`,
        );
      } else if (metadata.isDirectory()) {
        hash.update(`directory\0${relative}\0`);
        await visit(absolute);
      } else if (metadata.isFile()) {
        const key = `${metadata.dev}:${metadata.ino}`;
        const record = inodes.get(key);
        if (!record || BigInt(record.paths.length) !== metadata.nlink) {
          throw new Error(`Prepared dependency file is not private to the snapshot: ${relative}`);
        }
        hash.update(`file\0${relative}\0`);
        hash.update(await readFile(absolute));
        hash.update("\0");
        const after = await lstat(absolute, { bigint: true });
        if (
          after.dev !== metadata.dev ||
          after.ino !== metadata.ino ||
          after.nlink !== metadata.nlink ||
          after.size !== metadata.size ||
          after.mtimeNs !== metadata.mtimeNs
        ) {
          throw new Error(`Prepared dependency file changed while its identity was captured: ${relative}`);
        }
      } else {
        throw new Error(`Prepared dependency entry has an unsupported type: ${relative}`);
      }
    }
  };
  await visit(canonicalNodeModules);
  return hash.digest("hex");
};

const prepareDependencies = async (snapshotRoot: string): Promise<StreamingBenchmarkDependencySnapshot> => {
  const lockfile = path.join(snapshotRoot, "pnpm-lock.yaml");
  const lockfileContent = await readFile(lockfile).catch(() => {
    throw new Error("Authoritative benchmark subjects must contain a pinned pnpm-lock.yaml.");
  });
  await execFileAsync(
    "pnpm",
    [
      "install",
      "--offline",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--prod",
      "--package-import-method=copy",
      "--config.node-linker=hoisted",
    ],
    { cwd: snapshotRoot, maxBuffer: 16 * 1024 * 1024 },
  );
  const packageManagerVersion = (await execFileAsync("pnpm", ["--version"], { cwd: snapshotRoot })).stdout.trim();
  return {
    lockfileSha256: sha256(lockfileContent),
    treeSha256: await hashPrivateDependencyTree(snapshotRoot, path.join(snapshotRoot, "node_modules")),
    packageManager: `pnpm@${packageManagerVersion}`,
  };
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
    sha256: sha256(content),
    gitBlob,
  };
};

export type PreparedStreamingBenchmarkAdapter = StreamingBenchmarkAdapterIdentity & {
  executionModule: string;
  dependencySnapshot: StreamingBenchmarkDependencySnapshot;
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
    const dependencySnapshot = await prepareDependencies(snapshotRoot);
    const executionModule = path.join(snapshotRoot, ...identity.relativePath.split("/"));
    const content = await readFile(executionModule);
    const adapterSha256 = sha256(content);
    const snapshotBlob = await git(snapshotRoot, ["hash-object", executionModule]);
    if (adapterSha256 !== identity.sha256 || snapshotBlob !== identity.gitBlob) {
      throw new Error("Prepared benchmark snapshot does not match the pinned adapter identity.");
    }
    let cleaned = false;
    return {
      ...identity,
      sha256: adapterSha256,
      executionModule,
      dependencySnapshot,
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
    let removeFailed = false;
    if (added) {
      await git(identity.subjectRoot, ["worktree", "remove", "--force", snapshotRoot]).catch(() => {
        removeFailed = true;
      });
    }
    await rm(snapshotRoot, { recursive: true, force: true });
    if (removeFailed) await git(identity.subjectRoot, ["worktree", "prune"]).catch(() => undefined);
    throw error;
  }
};
