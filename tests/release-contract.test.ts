import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import * as releaseContract from "../scripts/release-contract.mjs";

const { verifyReleaseIdentity } = releaseContract;

const packages = (version = "1.2.3", dependency = version) => ({
  rootPackage: { name: "tachyon-dom", version },
  createPackage: {
    name: "create-tachyon-dom",
    version,
    dependencies: { "tachyon-dom": dependency },
  },
});

describe("npm release identity", () => {
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
});

describe("initializer package artifacts", () => {
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
      await expect(
        (releaseContract as any).inspectPackageDryRun({ packageDir, requiredFiles }),
      ).resolves.toMatchObject({ ok: true, files: expect.arrayContaining(requiredFiles) });

      await unlink(path.join(packageDir, "LICENSE"));
      await expect(
        (releaseContract as any).inspectPackageDryRun({ packageDir, requiredFiles }),
      ).resolves.toEqual({ ok: false, error: expect.stringMatching(/LICENSE/) });
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

  it("verifies both real package manifests and identical license bytes", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "tachyon-release-repository-"));
    const createDir = path.join(rootDir, "packages", "create-tachyon-dom");
    try {
      await mkdir(path.join(rootDir, "dist"), { recursive: true });
      await mkdir(path.join(createDir, "dist"), { recursive: true });
      const license = "MIT License\n\nfixture text\n";
      await writeFile(path.join(rootDir, "LICENSE"), license);
      await writeFile(path.join(rootDir, "README.md"), "# root\n");
      await writeFile(path.join(rootDir, "dist", "cli.js"), "#!/usr/bin/env node\n");
      await writeFile(
        path.join(rootDir, "package.json"),
        `${JSON.stringify({
          name: "tachyon-dom",
          version: "1.2.3",
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
          files: ["dist", "README.md", "LICENSE"],
          bin: { "create-tachyon-dom": "./dist/index.js" },
          dependencies: { "tachyon-dom": "1.2.3" },
        })}\n`,
      );

      await expect(
        (releaseContract as any).verifyReleaseRepository({ rootDir, tag: "v1.2.3" }),
      ).resolves.toMatchObject({ ok: true, version: "1.2.3", npmTag: "latest" });

      await writeFile(path.join(createDir, "LICENSE"), `${license}changed\n`);
      await expect(
        (releaseContract as any).verifyReleaseRepository({ rootDir, tag: "v1.2.3" }),
      ).resolves.toEqual({ ok: false, error: expect.stringMatching(/LICENSE bytes/) });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
