import { appendFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import * as releaseContract from "../scripts/release-contract.mjs";
import { decideDistTagTransition, readRegistryState } from "../scripts/npm-registry-state.mjs";
import { preflightReleasePublication } from "../scripts/preflight-release-publication.mjs";
import * as releasePublisher from "../scripts/publish-release-package.mjs";

const { verifyReleaseIdentity } = releaseContract;

const repository = (directory?: string) => ({
  type: "git",
  url: "git+https://github.com/t-k/tachyon-dom.git",
  ...(directory === undefined ? {} : { directory }),
});

const packages = (version = "1.2.3", dependency = version) => ({
  rootPackage: { name: "tachyon-dom", version, repository: repository() },
  createPackage: {
    name: "create-tachyon-dom",
    version,
    repository: repository("packages/create-tachyon-dom"),
    dependencies: { "tachyon-dom": dependency },
  },
});

describe("npm release identity", () => {
  it.each(["0.1.1", "0.1.2", "0.1.3", "0.1.4", "0.1.5"])(
    "contains a changelog entry for release %s",
    async (version) => {
      const changelog = await readFile("CHANGELOG.md", "utf8");
      expect(changelog).toMatch(new RegExp(`^## \\[${version.replaceAll(".", "\\.")}\\]`, "m"));
    },
  );

  it("requires the current release version in CHANGELOG", () => {
    expect((releaseContract as any).verifyChangelogVersion("# Changelog\n", "0.2.0")).toEqual({
      ok: false,
      error: "CHANGELOG.md must contain a 0.2.0 release heading.",
    });
    expect((releaseContract as any).verifyChangelogVersion("## [0.2.0] - 2026-08-15\n", "0.2.0")).toEqual({
      ok: true,
    });
  });

  it.each([
    ["v1.2.3", "1.2.3", "latest"],
    ["v1.2.3-beta.1", "1.2.3-beta.1", "next"],
  ])("accepts matching release identity %s", (tag, version, npmTag) => {
    expect(verifyReleaseIdentity({ tag, ...packages(version) })).toEqual({ ok: true, version, npmTag });
  });

  it.each([
    ["malformed tag", "1.2.3", "1.2.3", "1.2.3", /tag must be v/],
    ["build metadata", "v1.2.3+build.1", "1.2.3+build.1", "1.2.3+build.1", /tag must be v/],
    ["tag and root mismatch", "v1.2.4", "1.2.3", "1.2.3", /root package version/],
    ["root and create mismatch", "v1.2.3", "1.2.3", "1.2.4", /create-tachyon-dom version/],
    ["dependency range", "v1.2.3", "1.2.3", "1.2.3", /dependency must equal/],
    ["dependency mismatch", "v1.2.3", "1.2.3", "1.2.3", /dependency must equal/],
  ])("rejects %s", (_label, tag, rootVersion, createVersion, expected) => {
    const fixture = packages(rootVersion);
    fixture.createPackage.version = createVersion;
    fixture.createPackage.dependencies["tachyon-dom"] =
      _label === "dependency range" ? `^${rootVersion}` : _label === "dependency mismatch" ? "1.2.2" : rootVersion;
    expect(verifyReleaseIdentity({ tag, ...fixture })).toEqual({ ok: false, error: expect.stringMatching(expected) });
  });

  it.each(["rootPackage", "createPackage"] as const)(
    "rejects release identity without %s repository metadata",
    (key) => {
      const fixture = packages();
      delete (fixture[key] as { repository?: unknown }).repository;
      expect(verifyReleaseIdentity({ tag: "v1.2.3", ...fixture })).toEqual({
        ok: false,
        error: expect.stringMatching(/repository metadata/),
      });
    },
  );

  it("rejects release identity with repository metadata for another repository", () => {
    const fixture = packages();
    fixture.createPackage.repository.url = "git+https://github.com/example/other.git";
    expect(verifyReleaseIdentity({ tag: "v1.2.3", ...fixture })).toEqual({
      ok: false,
      error: expect.stringMatching(/repository metadata/),
    });
  });

  it("rejects create package repository metadata without its package directory", () => {
    const fixture = packages();
    delete fixture.createPackage.repository.directory;
    expect(verifyReleaseIdentity({ tag: "v1.2.3", ...fixture })).toEqual({
      ok: false,
      error: expect.stringMatching(/repository directory/),
    });
  });
});

describe("initializer package artifacts", () => {
  it("accepts regular contained tar entries", () => {
    expect(
      (releaseContract as any).validateTarEntries({
        entries: ["package/LICENSE", "package/dist/index.js"],
        verboseLines: ["-rw-r--r-- LICENSE", "-rwxr-xr-x dist/index.js"],
      }),
    ).toEqual(["LICENSE", "dist/index.js"]);
  });

  it.each([
    ["outside package root", ["outside/file"], ["-rw-r--r-- file"]],
    ["parent traversal", ["package/../escape"], ["-rw-r--r-- file"]],
    ["duplicate path", ["package/file", "package/file"], ["-rw-r--r-- file", "-rw-r--r-- file"]],
    ["symbolic link", ["package/link"], ["lrwxrwxrwx link -> target"]],
    ["hard link", ["package/link"], ["hrw-r--r-- link to target"]],
  ])("rejects unsafe tar entry: %s", (_label, entries, verboseLines) => {
    expect(() => (releaseContract as any).validateTarEntries({ entries, verboseLines })).toThrow();
  });

  it("inspects required files in the real npm dry-run manifest", async () => {
    const packageDir = await mkdtemp(path.join(tmpdir(), "tachyon-create-pack-"));
    try {
      await mkdir(path.join(packageDir, "dist"));
      await writeFile(path.join(packageDir, "dist", "index.js"), "#!/usr/bin/env node\n");
      await writeFile(path.join(packageDir, "README.md"), "# fixture\n");
      await writeFile(path.join(packageDir, "LICENSE"), "MIT fixture\n");
      await writeFile(
        path.join(packageDir, "package.json"),
        `${JSON.stringify({
          name: "create-tachyon-dom-fixture",
          version: "1.2.3",
          files: ["dist", "README.md", "LICENSE"],
          bin: { "create-tachyon-dom-fixture": "./dist/index.js" },
        })}\n`,
      );

      const requiredFiles = ["package.json", "README.md", "LICENSE", "dist/index.js"];
      await expect((releaseContract as any).inspectPackageDryRun({ packageDir, requiredFiles })).resolves.toMatchObject(
        { ok: true, files: expect.arrayContaining(requiredFiles) },
      );

      await unlink(path.join(packageDir, "LICENSE"));
      await expect((releaseContract as any).inspectPackageDryRun({ packageDir, requiredFiles })).resolves.toEqual({
        ok: false,
        error: expect.stringMatching(/LICENSE/),
      });
    } finally {
      await rm(packageDir, { recursive: true, force: true });
    }
  });

  it("copies the repository MIT license bytes into the initializer package", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "tachyon-license-root-"));
    const packageDir = path.join(rootDir, "packages", "create-tachyon-dom");
    try {
      await mkdir(packageDir, { recursive: true });
      const license = "MIT License\n\nfixture text\n";
      await writeFile(path.join(rootDir, "LICENSE"), license);
      const assets = await import("../scripts/copy-create-package-assets.mjs");
      await assets.copyCreatePackageAssets({ rootDir, packageDir });
      expect(await readFile(path.join(packageDir, "LICENSE"), "utf8")).toBe(license);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("packs and reverifies immutable package bytes independently of the source tree", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "tachyon-release-repository-"));
    const createDir = path.join(rootDir, "packages", "create-tachyon-dom");
    const artifactDir = path.join(rootDir, "release-artifacts");
    try {
      await mkdir(path.join(rootDir, "dist"), { recursive: true });
      await mkdir(path.join(createDir, "dist"), { recursive: true });
      const license = "MIT License\n\nfixture text\n";
      await writeFile(path.join(rootDir, "LICENSE"), license);
      await writeFile(path.join(rootDir, "README.md"), "# root\n");
      await writeFile(path.join(rootDir, "CHANGELOG.md"), "# Changelog\n\n## [1.2.3] - 2026-08-15\n");
      await writeFile(path.join(rootDir, "dist", "cli.js"), "#!/usr/bin/env node\n");
      await writeFile(
        path.join(rootDir, "package.json"),
        `${JSON.stringify({
          name: "tachyon-dom",
          version: "1.2.3",
          repository: repository(),
          files: ["dist", "README.md", "LICENSE"],
          bin: { "tachyon-dom": "./dist/cli.js" },
        })}\n`,
      );
      await writeFile(path.join(createDir, "LICENSE"), license);
      await writeFile(path.join(createDir, "README.md"), "# create\n");
      await writeFile(path.join(createDir, "dist", "index.js"), "#!/usr/bin/env node\n");
      await writeFile(
        path.join(createDir, "package.json"),
        `${JSON.stringify({
          name: "create-tachyon-dom",
          version: "1.2.3",
          repository: repository("packages/create-tachyon-dom"),
          files: ["dist", "README.md", "LICENSE"],
          bin: { "create-tachyon-dom": "./dist/index.js" },
          dependencies: { "tachyon-dom": "1.2.3" },
        })}\n`,
      );

      const prepared = await (releaseContract as any).prepareReleaseArtifacts({
        rootDir,
        artifactDir,
        tag: "v1.2.3",
      });
      expect(prepared).toMatchObject({ ok: true, version: "1.2.3", npmTag: "latest" });
      await expect((releaseContract as any).dryRunReleaseArtifacts({ artifactDir, tag: "v1.2.3" })).resolves.toEqual({
        ok: true,
        version: "1.2.3",
        npmTag: "latest",
      });

      const manifestPath = path.join(artifactDir, "release-manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const registryServer = createServer((request, response) => {
        const name = decodeURIComponent(request.url?.slice(1) ?? "");
        const entry = Object.values(manifest.packages).find((candidate: any) => candidate.name === name) as any;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            versions: { "1.2.3": { dist: { integrity: entry.integrity } } },
            "dist-tags": { latest: "1.2.2" },
          }),
        );
      });
      await new Promise<void>((resolve, reject) => {
        registryServer.once("error", reject);
        registryServer.listen(0, "127.0.0.1", resolve);
      });
      const registryAddress = registryServer.address();
      if (!registryAddress || typeof registryAddress === "string")
        throw new Error("Registry fixture has no TCP address.");
      try {
        await expect(
          preflightReleasePublication({
            artifactDir,
            tag: "v1.2.3",
            registryUrl: `http://127.0.0.1:${registryAddress.port}`,
          }),
        ).resolves.toMatchObject({
          version: "1.2.3",
          packages: {
            root: { publication: "skip", distTag: "update" },
            create: { publication: "skip", distTag: "update" },
          },
        });
      } finally {
        await new Promise<void>((resolve, reject) =>
          registryServer.close((error) => (error ? reject(error) : resolve())),
        );
      }

      manifest.packages.root.filename = "../tachyon-dom-1.2.3.tgz";
      await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
      await expect((releaseContract as any).verifyReleaseArtifacts({ artifactDir, tag: "v1.2.3" })).resolves.toEqual({
        ok: false,
        error: expect.stringMatching(/filename/),
      });

      manifest.packages.root.filename = "tachyon-dom-1.2.3.tgz";
      manifest.packages.root.name = "attacker-package";
      await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
      await expect((releaseContract as any).verifyReleaseArtifacts({ artifactDir, tag: "v1.2.3" })).resolves.toEqual({
        ok: false,
        error: expect.stringMatching(/name/),
      });

      manifest.packages.root.name = "tachyon-dom";
      await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

      await writeFile(path.join(createDir, "LICENSE"), `${license}changed\n`);
      await expect(
        (releaseContract as any).verifyReleaseArtifacts({ artifactDir, tag: "v1.2.3" }),
      ).resolves.toMatchObject({ ok: true, version: "1.2.3" });

      const rootTarball = path.join(artifactDir, prepared.manifest.packages.root.filename);
      await appendFile(rootTarball, "tampered");
      await expect((releaseContract as any).verifyReleaseArtifacts({ artifactDir, tag: "v1.2.3" })).resolves.toEqual({
        ok: false,
        error: expect.stringMatching(/integrity/),
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

describe("retryable npm publication", () => {
  it("rejects a direct publish when the release tag advanced after preflight", () => {
    const decideDirectPublication = (releasePublisher as any).decideDirectPublication;
    expect(decideDirectPublication).toBeTypeOf("function");
    if (typeof decideDirectPublication !== "function") return;

    expect(
      decideDirectPublication({
        expectedIntegrity: "sha512-a",
        publishedIntegrity: null,
        currentTag: "1.2.4",
        targetVersion: "1.2.3",
      }),
    ).toEqual({ ok: false, error: expect.stringMatching(/rollback/) });
    expect(
      decideDirectPublication({
        expectedIntegrity: "sha512-a",
        publishedIntegrity: "sha512-a",
        currentTag: "1.2.2",
        targetVersion: "1.2.3",
      }),
    ).toEqual({ ok: false, error: expect.stringMatching(/dist-tag/) });
    expect(
      decideDirectPublication({
        expectedIntegrity: "sha512-a",
        publishedIntegrity: "sha512-a",
        currentTag: "1.2.3",
        targetVersion: "1.2.3",
      }),
    ).toEqual({ ok: true, action: "skip" });
  });

  it("publishes missing versions, skips identical versions, and rejects conflicts", () => {
    expect(
      (releaseContract as any).decidePublication({ expectedIntegrity: "sha512-a", publishedIntegrity: null }),
    ).toEqual({ ok: true, action: "publish" });
    expect(
      (releaseContract as any).decidePublication({ expectedIntegrity: "sha512-a", publishedIntegrity: "sha512-a" }),
    ).toEqual({ ok: true, action: "skip" });
    expect(
      (releaseContract as any).decidePublication({ expectedIntegrity: "sha512-a", publishedIntegrity: "sha512-b" }),
    ).toEqual({ ok: false, error: expect.stringMatching(/different integrity/) });
  });

  it.each([
    [undefined, "1.2.3", "update"],
    ["1.2.3", "1.2.3", "noop"],
    ["1.2.2", "1.2.3", "update"],
    ["1.2.3-beta.1", "1.2.3-beta.2", "update"],
    ["1.2.3-beta.2", "1.2.3-beta.10", "update"],
  ])("allows a safe dist-tag transition from %s to %s", (currentVersion, targetVersion, action) => {
    expect(decideDistTagTransition({ currentVersion, targetVersion })).toEqual({ ok: true, action });
  });

  it("rejects a dist-tag rollback", () => {
    expect(decideDistTagTransition({ currentVersion: "1.2.4", targetVersion: "1.2.3" })).toEqual({
      ok: false,
      error: expect.stringMatching(/rollback/),
    });
  });

  it("distinguishes registry absence from authentication and rate-limit failures", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/missing") {
        response.writeHead(404).end("not found");
        return;
      }
      if (request.url === "/unauthorized") {
        response.writeHead(401).end("unauthorized");
        return;
      }
      if (request.url === "/limited") {
        response.writeHead(429).end("limited");
        return;
      }
      if (request.url === "/malformed") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ versions: "invalid", "dist-tags": {} }));
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          versions: { "1.2.3": { dist: { integrity: "sha512-current" } } },
          "dist-tags": { latest: "1.2.2" },
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Registry fixture has no TCP address.");
    const registryUrl = `http://127.0.0.1:${address.port}`;
    try {
      await expect(readRegistryState({ registryUrl, name: "missing", version: "1.2.3" })).resolves.toEqual({
        integrity: null,
        distTags: {},
      });
      await expect(readRegistryState({ registryUrl, name: "package", version: "1.2.3" })).resolves.toEqual({
        integrity: "sha512-current",
        distTags: { latest: "1.2.2" },
      });
      await expect(readRegistryState({ registryUrl, name: "unauthorized", version: "1.2.3" })).rejects.toThrow(/401/);
      await expect(readRegistryState({ registryUrl, name: "limited", version: "1.2.3" })).rejects.toThrow(/429/);
      await expect(readRegistryState({ registryUrl, name: "malformed", version: "1.2.3" })).rejects.toThrow(/versions/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
