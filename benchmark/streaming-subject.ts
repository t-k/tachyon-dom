import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, cp, lstat, mkdtemp, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const esbuildCli = require.resolve("esbuild/bin/esbuild");

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

const materializeDependencyTree = async (snapshotRoot: string, nodeModules: string): Promise<void> => {
  const [canonicalSnapshotRoot, canonicalNodeModules] = await Promise.all([
    realpath(snapshotRoot),
    realpath(nodeModules),
  ]);
  let copyIndex = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) {
        const resolved = await realpath(absolute);
        if (!isInside(canonicalSnapshotRoot, resolved)) {
          throw new Error(`Prepared dependency symlink escapes the private snapshot: ${absolute}`);
        }
        if (!isInside(canonicalNodeModules, resolved)) {
          await rm(absolute, { force: true });
          await cp(resolved, absolute, { recursive: true, dereference: true, force: true });
          const replacement = await lstat(absolute);
          if (replacement.isDirectory()) await visit(absolute);
        }
      } else if (metadata.isDirectory()) {
        await visit(absolute);
      } else if (metadata.isFile()) {
        if (metadata.nlink > 1) {
          const replacement = `${absolute}.tachyon-private-${process.pid}-${copyIndex++}`;
          await copyFile(absolute, replacement);
          await rename(replacement, absolute);
        }
      } else {
        throw new Error(`Prepared dependency entry has an unsupported type: ${absolute}`);
      }
    }
  };
  await visit(canonicalNodeModules);
};

const ignoredPnpmMetadata = new Set([".modules.yaml", ".pnpm-workspace-state-v1.json"]);

const hashPrivateDependencyTree = async (nodeModules: string): Promise<string> => {
  const canonicalNodeModules = await realpath(nodeModules);
  const hash = createHash("sha256");
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(canonicalNodeModules, absolute).split(path.sep).join("/");
      if (!relative.includes("/") && ignoredPnpmMetadata.has(relative)) continue;
      const metadata = await lstat(absolute, { bigint: true });
      if (metadata.isSymbolicLink()) {
        const resolved = await realpath(absolute);
        if (!isInside(canonicalNodeModules, resolved)) {
          throw new Error(`Prepared dependency symlink escapes the private snapshot: ${relative}`);
        }
        hash.update(`link\0${relative}\0${path.relative(canonicalNodeModules, resolved).split(path.sep).join("/")}\0`);
      } else if (metadata.isDirectory()) {
        hash.update(`directory\0${relative}\0${metadata.mode & 0o777n}\0`);
        await visit(absolute);
      } else if (metadata.isFile()) {
        if (metadata.nlink !== 1n) {
          throw new Error(`Prepared dependency file is not private to the snapshot: ${relative}`);
        }
        hash.update(`file\0${relative}\0${metadata.mode & 0o777n}\0`);
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

const setTreeWritable = async (root: string, writable: boolean): Promise<void> => {
  const visit = async (entryPath: string): Promise<void> => {
    const metadata = await lstat(entryPath);
    if (metadata.isSymbolicLink()) return;
    if (metadata.isDirectory()) {
      if (writable) await chmod(entryPath, 0o755);
      for (const entry of await readdir(entryPath)) await visit(path.join(entryPath, entry));
      if (!writable) await chmod(entryPath, 0o555);
    } else if (metadata.isFile()) {
      await chmod(entryPath, writable ? 0o644 : 0o444);
    }
  };
  await visit(root);
};

const prepareDependencies = async (
  snapshotRoot: string,
): Promise<Omit<StreamingBenchmarkDependencySnapshot, "treeSha256">> => {
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
  const lockfileAfterInstall = await readFile(lockfile);
  if (!lockfileContent.equals(lockfileAfterInstall)) {
    throw new Error("The benchmark lockfile changed while preparing the dependency snapshot.");
  }
  const nodeModules = path.join(snapshotRoot, "node_modules");
  await materializeDependencyTree(snapshotRoot, nodeModules);
  const packageManagerVersion = (await execFileAsync("pnpm", ["--version"], { cwd: snapshotRoot })).stdout.trim();
  return {
    lockfileSha256: sha256(lockfileContent),
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
  executionBundle: {
    sha256: string;
    bundler: string;
  };
  dependencySnapshot: StreamingBenchmarkDependencySnapshot;
  verify: () => Promise<void>;
  importAdapter: <T = Record<string, unknown>>() => Promise<T>;
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
    const dependencyBase = await prepareDependencies(snapshotRoot);
    const executionModule = path.join(snapshotRoot, ...identity.relativePath.split("/"));
    await setTreeWritable(snapshotRoot, false);
    const dependencySnapshot: StreamingBenchmarkDependencySnapshot = {
      ...dependencyBase,
      treeSha256: await hashPrivateDependencyTree(path.join(snapshotRoot, "node_modules")),
    };
    const bundleProcess = (await execFileAsync(
      process.execPath,
      [
        esbuildCli,
        executionModule,
        "--bundle",
        "--format=esm",
        "--platform=node",
        "--target=node24",
        "--packages=bundle",
        "--legal-comments=none",
        "--log-level=warning",
      ],
      { cwd: snapshotRoot, encoding: null, maxBuffer: 64 * 1024 * 1024 },
    )) as unknown as { stdout: Buffer; stderr: Buffer };
    if (bundleProcess.stderr.length > 0) {
      throw new Error(`The benchmark adapter bundler emitted diagnostics:\n${bundleProcess.stderr.toString("utf8")}`);
    }
    const bundleBytes = bundleProcess.stdout;
    if (bundleBytes.length === 0) throw new Error("The benchmark adapter bundler did not produce an execution module.");
    const bundlerVersion = (
      (await execFileAsync(process.execPath, [esbuildCli, "--version"], {
        cwd: snapshotRoot,
        encoding: "utf8",
      })) as { stdout: string }
    ).stdout.trim();
    const executionBundle = {
      sha256: sha256(bundleBytes),
      bundler: `esbuild@${bundlerVersion}`,
    };
    const executionUrl = `data:text/javascript;base64,${Buffer.from(bundleBytes).toString("base64")}#${executionBundle.sha256}`;
    const verify = async (): Promise<void> => {
      const [content, snapshotBlob, lockfileContent, treeSha256, trackedStatus] = await Promise.all([
        readFile(executionModule),
        git(snapshotRoot, ["hash-object", executionModule]),
        readFile(path.join(snapshotRoot, "pnpm-lock.yaml")),
        hashPrivateDependencyTree(path.join(snapshotRoot, "node_modules")),
        git(snapshotRoot, ["status", "--porcelain=v1", "--untracked-files=no"]),
      ]);
      if (sha256(content) !== identity.sha256 || snapshotBlob !== identity.gitBlob) {
        throw new Error("Prepared benchmark snapshot does not match the pinned adapter identity.");
      }
      if (sha256(lockfileContent) !== dependencySnapshot.lockfileSha256) {
        throw new Error("Prepared benchmark lockfile does not match its captured identity.");
      }
      if (treeSha256 !== dependencySnapshot.treeSha256) {
        throw new Error("Prepared benchmark dependencies do not match their captured identity.");
      }
      if (trackedStatus !== "") {
        throw new Error("Prepared benchmark source tree changed after its pinned commit was checked out.");
      }
    };
    await verify();
    const importAdapter = async <T = Record<string, unknown>>(): Promise<T> => {
      const loaded = (await import(executionUrl)) as T;
      await verify();
      return loaded;
    };
    let cleaned = false;
    return {
      ...identity,
      executionModule,
      executionBundle,
      dependencySnapshot,
      verify,
      importAdapter,
      cleanup: async () => {
        if (cleaned) return;
        await setTreeWritable(snapshotRoot, true);
        try {
          await git(identity.subjectRoot, ["worktree", "remove", "--force", snapshotRoot]);
          cleaned = true;
        } catch (error) {
          let fallbackError: unknown;
          try {
            await rm(snapshotRoot, { recursive: true, force: true });
          } catch (cleanupError) {
            fallbackError = cleanupError;
          } finally {
            await git(identity.subjectRoot, ["worktree", "prune"]).catch(() => undefined);
          }
          if (fallbackError) throw new AggregateError([error, fallbackError], "Benchmark snapshot cleanup failed.");
          cleaned = true;
          throw error;
        }
      },
    };
  } catch (error) {
    await setTreeWritable(snapshotRoot, true).catch(() => undefined);
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
