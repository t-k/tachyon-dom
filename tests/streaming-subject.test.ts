import { execFile } from "node:child_process";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  hashPrivateDependencyTree,
  identifyStreamingBenchmarkAdapter,
  materializeDependencyTree,
  prepareStreamingBenchmarkAdapter,
  writeVerifiedBenchmarkArtifact,
} from "../benchmark/streaming-subject.js";

const execFileAsync = promisify(execFile);

const repositoryFixture = async (): Promise<{ root: string; adapter: string }> => {
  const root = await mkdtemp(path.join(tmpdir(), "tachyon-stream-subject-"));
  const adapter = path.join(root, "src/adapter.mjs");
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "benchmark@example.test"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Benchmark Test"], { cwd: root });
  await mkdir(path.join(root, "src"));
  await writeFile(adapter, "export const adapter = true;\n");
  await writeFile(path.join(root, "package.json"), '{"name":"benchmark-subject","private":true,"type":"module"}\n');
  await writeFile(path.join(root, ".gitignore"), "node_modules/\n");
  await execFileAsync("pnpm", ["install", "--ignore-scripts"], { cwd: root });
  await execFileAsync("git", ["add", ".gitignore", "package.json", "pnpm-lock.yaml", "src/adapter.mjs"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "adapter"], { cwd: root });
  return { root, adapter };
};

describe("streaming benchmark adapter identity", () => {
  it("rejects computed dynamic imports that remain outside the hashed execution bundle", async () => {
    const fixture = await repositoryFixture();
    try {
      await writeFile(path.join(fixture.root, "src/dynamic.mjs"), 'export const value = "live";\n');
      await writeFile(
        fixture.adapter,
        'const modulePath = "./dynamic.mjs"; export const load = () => import(modulePath);\n',
      );
      await execFileAsync("git", ["add", "src/adapter.mjs", "src/dynamic.mjs"], { cwd: fixture.root });
      await execFileAsync("git", ["commit", "-m", "computed import"], { cwd: fixture.root });
      await expect(prepareStreamingBenchmarkAdapter(fixture.root, fixture.adapter)).rejects.toThrow(
        /dynamic import.*authoritative/i,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("denies runtime imports hidden in indirect eval and Function while the adapter executes", async () => {
    const fixture = await repositoryFixture();
    const external = await mkdtemp(path.join(tmpdir(), "tachyon-dynamic-external-"));
    try {
      const externalModule = path.join(external, "live.mjs");
      await writeFile(externalModule, 'export const value = "external";\n');
      const externalCommonJs = path.join(external, "live.cjs");
      await writeFile(externalCommonJs, 'module.exports = { value: "external" };\n');
      const importSource = `import(${JSON.stringify(pathToFileURL(externalModule).href)})`;
      await writeFile(
        fixture.adapter,
        `export const evalLoad = () => globalThis.eval(${JSON.stringify(importSource)}); export const functionLoad = () => Function(${JSON.stringify(`return ${importSource}`)})(); export const requireLoad = () => process.getBuiltinModule("node:module").createRequire("/tmp/tachyon-benchmark.cjs")(${JSON.stringify(externalCommonJs)});\n`,
      );
      await execFileAsync("git", ["add", "src/adapter.mjs"], { cwd: fixture.root });
      await execFileAsync("git", ["commit", "-m", "hidden imports"], { cwd: fixture.root });
      const prepared = await prepareStreamingBenchmarkAdapter(fixture.root, fixture.adapter);
      try {
        const loaded = await prepared.importAdapter<{
          evalLoad: () => Promise<unknown>;
          functionLoad: () => Promise<unknown>;
          requireLoad: () => unknown;
        }>();
        await expect(loaded.evalLoad()).rejects.toThrow(/not allowed.*authoritative/i);
        await expect(loaded.functionLoad()).rejects.toThrow(/not allowed.*authoritative/i);
        expect(() => loaded.requireLoad()).toThrow(/not allowed.*authoritative/i);
      } finally {
        await prepared.cleanup();
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(external, { recursive: true, force: true });
    }
  });

  it("rejects a nested escaping symlink before dependency materialization reads it", async () => {
    const snapshot = await mkdtemp(path.join(tmpdir(), "tachyon-materialize-snapshot-"));
    const external = await mkdtemp(path.join(tmpdir(), "tachyon-materialize-external-"));
    const nodeModules = path.join(snapshot, "node_modules");
    const packageRoot = path.join(snapshot, "vendor/package");
    try {
      await mkdir(nodeModules);
      await mkdir(packageRoot, { recursive: true });
      const secret = path.join(external, "secret.mjs");
      await writeFile(secret, 'export const secret = "outside";\n');
      await symlink(secret, path.join(packageRoot, "nested.mjs"));
      await symlink(packageRoot, path.join(nodeModules, "package"), "dir");
      await expect(materializeDependencyTree(snapshot, nodeModules)).rejects.toThrow(/escapes.*snapshot/i);
    } finally {
      await rm(snapshot, { recursive: true, force: true });
      await rm(external, { recursive: true, force: true });
    }
  });

  it("materializes every contained nested dependency symlink without retaining a live link", async () => {
    const snapshot = await mkdtemp(path.join(tmpdir(), "tachyon-materialize-contained-"));
    const nodeModules = path.join(snapshot, "node_modules");
    const packageRoot = path.join(snapshot, "vendor/package");
    const shared = path.join(snapshot, "shared/value.mjs");
    try {
      await mkdir(nodeModules);
      await mkdir(packageRoot, { recursive: true });
      await mkdir(path.dirname(shared), { recursive: true });
      await writeFile(shared, 'export const value = "contained";\n');
      await symlink(shared, path.join(packageRoot, "nested.mjs"));
      await symlink(packageRoot, path.join(nodeModules, "package"), "dir");
      await materializeDependencyTree(snapshot, nodeModules);
      const materialized = path.join(nodeModules, "package/nested.mjs");
      expect((await lstat(materialized)).isSymbolicLink()).toBe(false);
      expect(await readFile(materialized, "utf8")).toContain('"contained"');
    } finally {
      await rm(snapshot, { recursive: true, force: true });
    }
  });

  it("rejects contained self-referential and multi-directory symlink cycles", async () => {
    for (const cycle of ["self", "multi"] as const) {
      const snapshot = await mkdtemp(path.join(tmpdir(), `tachyon-materialize-${cycle}-`));
      const nodeModules = path.join(snapshot, "node_modules");
      const packageRoot = path.join(snapshot, "vendor/package");
      try {
        await mkdir(nodeModules);
        await mkdir(packageRoot, { recursive: true });
        if (cycle === "self") {
          await symlink(packageRoot, path.join(packageRoot, "cycle"), "dir");
        } else {
          const second = path.join(snapshot, "vendor/second");
          await mkdir(second);
          await symlink(second, path.join(packageRoot, "second"), "dir");
          await symlink(packageRoot, path.join(second, "package"), "dir");
        }
        await symlink(packageRoot, path.join(nodeModules, "package"), "dir");
        await expect(materializeDependencyTree(snapshot, nodeModules)).rejects.toThrow(/cycle/i);
      } finally {
        await rm(snapshot, { recursive: true, force: true });
      }
    }
  });

  it("uses unambiguous length framing for dependency tree records", async () => {
    const oneFile = await mkdtemp(path.join(tmpdir(), "tachyon-hash-one-"));
    const twoFiles = await mkdtemp(path.join(tmpdir(), "tachyon-hash-two-"));
    try {
      const delimiter = Buffer.from([0]);
      await writeFile(
        path.join(oneFile, "a"),
        Buffer.concat([
          Buffer.from("A"),
          delimiter,
          Buffer.from("file"),
          delimiter,
          Buffer.from("b"),
          delimiter,
          Buffer.from("292"),
          delimiter,
          Buffer.from("B"),
        ]),
      );
      await writeFile(path.join(twoFiles, "a"), "A");
      await writeFile(path.join(twoFiles, "b"), "B");
      await Promise.all([
        chmod(path.join(oneFile, "a"), 0o444),
        chmod(path.join(twoFiles, "a"), 0o444),
        chmod(path.join(twoFiles, "b"), 0o444),
      ]);
      await expect(hashPrivateDependencyTree(oneFile)).resolves.not.toBe(await hashPrivateDependencyTree(twoFiles));
    } finally {
      await rm(oneFile, { recursive: true, force: true });
      await rm(twoFiles, { recursive: true, force: true });
    }
  });

  it("binds a tracked adapter to its subject-relative path and commit bytes", async () => {
    const fixture = await repositoryFixture();
    try {
      await expect(identifyStreamingBenchmarkAdapter(fixture.root, fixture.adapter)).resolves.toMatchObject({
        relativePath: "src/adapter.mjs",
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

  it("executes an immutable commit snapshot even if the source path changes after validation", async () => {
    const fixture = await repositoryFixture();
    const prepared = await prepareStreamingBenchmarkAdapter(fixture.root, fixture.adapter);
    try {
      await writeFile(fixture.adapter, "export const adapter = false;\n");
      const executed = await execFileAsync(process.execPath, [
        "--input-type=module",
        "--eval",
        `const value = await import(${JSON.stringify(pathToFileURL(prepared.executionModule).href)}); console.log(value.adapter);`,
      ]);
      expect(executed.stdout.trim()).toBe("true");
      expect(prepared.executionModule).not.toBe(fixture.adapter);
    } finally {
      await prepared.cleanup();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("executes private lockfile-derived dependency bytes after the subject installation changes", async () => {
    const fixture = await repositoryFixture();
    const dependencyRoot = path.join(fixture.root, "vendor/fixture-dependency");
    await mkdir(dependencyRoot, { recursive: true });
    await writeFile(
      path.join(fixture.root, "package.json"),
      `${JSON.stringify({
        name: "benchmark-subject",
        private: true,
        type: "module",
        dependencies: { "fixture-dependency": "file:vendor/fixture-dependency" },
      })}\n`,
    );
    await writeFile(path.join(fixture.root, ".gitignore"), "node_modules/\n");
    await writeFile(
      path.join(dependencyRoot, "package.json"),
      `${JSON.stringify({ name: "fixture-dependency", version: "1.0.0", type: "module", exports: "./index.js" })}\n`,
    );
    await writeFile(path.join(dependencyRoot, "index.js"), 'export const dependencyValue = "pinned";\n');
    await writeFile(
      fixture.adapter,
      'import { dependencyValue } from "fixture-dependency"; export const adapter = dependencyValue;\n',
    );
    await execFileAsync("pnpm", ["install", "--ignore-scripts"], { cwd: fixture.root });
    await execFileAsync("git", ["add", ".gitignore", "package.json", "pnpm-lock.yaml", "vendor", "src/adapter.mjs"], {
      cwd: fixture.root,
    });
    await execFileAsync("git", ["commit", "-m", "add dependency"], { cwd: fixture.root });

    const prepared = await prepareStreamingBenchmarkAdapter(fixture.root, fixture.adapter);
    try {
      await writeFile(
        path.join(fixture.root, "node_modules/fixture-dependency/index.js"),
        'export const dependencyValue = "mutated";\n',
      );
      const executed = await execFileAsync(process.execPath, [
        "--input-type=module",
        "--eval",
        `const value = await import(${JSON.stringify(pathToFileURL(prepared.executionModule).href)}); console.log(value.adapter);`,
      ]);
      expect(executed.stdout.trim()).toBe("pinned");
      expect(prepared.dependencySnapshot).toMatchObject({
        lockfileSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        treeSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      const preparedDependency = path.join(
        path.dirname(path.dirname(prepared.executionModule)),
        "node_modules/fixture-dependency/index.js",
      );
      const dependencyMetadata = await lstat(preparedDependency);
      expect(dependencyMetadata.isSymbolicLink()).toBe(false);
      expect(dependencyMetadata.nlink).toBe(1);
      await expect(writeFile(preparedDependency, 'export const dependencyValue = "tampered";\n')).rejects.toThrow();
      await expect(prepared.verify()).resolves.toBeUndefined();
      await expect(prepared.importAdapter<{ adapter: string }>()).resolves.toMatchObject({ adapter: "pinned" });
      await chmod(preparedDependency, 0o555);
      await expect(prepared.verify()).rejects.toThrow(/dependencies do not match/);
      await chmod(preparedDependency, 0o444);
      await expect(prepared.verify()).resolves.toBeUndefined();
      await chmod(preparedDependency, 0o644);
      await writeFile(preparedDependency, 'export const dependencyValue = "tampered";\n');
      await expect(prepared.verify()).rejects.toThrow(/dependencies do not match/);
      await expect((prepared as any).importAdapter()).rejects.toThrow(/dependencies do not match/);
    } finally {
      await prepared.cleanup();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("binds execution to one hashed bundle and detects execution-relevant mode changes", async () => {
    const fixture = await repositoryFixture();
    const prepared = await prepareStreamingBenchmarkAdapter(fixture.root, fixture.adapter);
    try {
      expect((prepared as any).executionBundle).toMatchObject({
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        bundler: expect.stringMatching(/^esbuild@/),
      });
      await expect((prepared as any).importAdapter()).resolves.toMatchObject({ adapter: true });
      const preparedAdapter = prepared.executionModule;
      await chmod(preparedAdapter, 0o755);
      await expect(prepared.verify()).rejects.toThrow(/source tree|mode|snapshot/i);
    } finally {
      await prepared.cleanup();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a lockfile changed after the snapshot was sealed", async () => {
    const fixture = await repositoryFixture();
    const prepared = await prepareStreamingBenchmarkAdapter(fixture.root, fixture.adapter);
    try {
      const preparedLockfile = path.join(path.dirname(path.dirname(prepared.executionModule)), "pnpm-lock.yaml");
      await chmod(preparedLockfile, 0o644);
      await writeFile(preparedLockfile, "tampered\n");
      await expect(prepared.verify()).rejects.toThrow(/lockfile does not match/);
    } finally {
      await prepared.cleanup();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects an authoritative subject without a pinned lockfile", async () => {
    const fixture = await repositoryFixture();
    try {
      await execFileAsync("git", ["rm", "pnpm-lock.yaml"], { cwd: fixture.root });
      await execFileAsync("git", ["commit", "-m", "remove lockfile"], { cwd: fixture.root });
      await expect(prepareStreamingBenchmarkAdapter(fixture.root, fixture.adapter)).rejects.toThrow(
        /pinned pnpm-lock\.yaml/,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("produces one dependency identity for repeated preparation of the same commit", async () => {
    const fixture = await repositoryFixture();
    const first = await prepareStreamingBenchmarkAdapter(fixture.root, fixture.adapter);
    const firstIdentity = first.dependencySnapshot;
    await first.cleanup();
    const second = await prepareStreamingBenchmarkAdapter(fixture.root, fixture.adapter);
    try {
      expect(second.dependencySnapshot).toEqual(firstIdentity);
    } finally {
      await second.cleanup();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not publish a final or temporary artifact when final snapshot verification fails", async () => {
    const fixture = await repositoryFixture();
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "tachyon-verified-artifact-"));
    const output = path.join(outputDirectory, "result.json");
    const prepared = await prepareStreamingBenchmarkAdapter(fixture.root, fixture.adapter);
    try {
      await chmod(prepared.executionModule, 0o644);
      await writeFile(prepared.executionModule, "export const adapter = false;\n");
      await expect(writeVerifiedBenchmarkArtifact(prepared, output, '{"result":true}\n')).rejects.toThrow(
        /snapshot|source tree/,
      );
      await expect(access(output)).rejects.toThrow();
      expect(await readdir(outputDirectory)).toEqual([]);
    } finally {
      await prepared.cleanup();
      await rm(fixture.root, { recursive: true, force: true });
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });
});
