import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const releaseTagPattern =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

const failure = (error) => ({ ok: false, error });

export const verifyReleaseIdentity = ({ tag, rootPackage, createPackage }) => {
  if (typeof tag !== "string" || !releaseTagPattern.test(tag)) {
    return failure("Release tag must be v followed by a SemVer version without build metadata.");
  }
  const version = tag.slice(1);
  if (rootPackage?.name !== "tachyon-dom" || rootPackage.version !== version) {
    return failure(`The root package version must equal ${version}.`);
  }
  if (createPackage?.name !== "create-tachyon-dom" || createPackage.version !== version) {
    return failure(`The create-tachyon-dom version must equal ${version}.`);
  }
  if (createPackage.dependencies?.["tachyon-dom"] !== version) {
    return failure(`The create-tachyon-dom tachyon-dom dependency must equal ${version} exactly.`);
  }
  return { ok: true, version, npmTag: version.includes("-") ? "next" : "latest" };
};

export const inspectPackageDryRun = async ({ packageDir, requiredFiles }) => {
  const { stdout } = await execFile("npm", ["pack", "--dry-run", "--json"], {
    cwd: packageDir,
    maxBuffer: 16 * 1024 * 1024,
  });
  const manifests = JSON.parse(stdout);
  if (!Array.isArray(manifests) || manifests.length !== 1 || !Array.isArray(manifests[0]?.files)) {
    return failure("npm pack did not return exactly one package manifest.");
  }
  const files = manifests[0].files.map((entry) => entry.path).filter((entry) => typeof entry === "string");
  for (const requiredFile of requiredFiles) {
    if (!files.includes(requiredFile)) return failure(`Package dry-run manifest is missing ${requiredFile}.`);
  }
  return { ok: true, files };
};

const readPackageJson = async (packageDir) => JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));

const integrityFor = async (file) =>
  `sha512-${createHash("sha512")
    .update(await readFile(file))
    .digest("base64")}`;

const packPackage = async ({ packageDir, artifactDir }) => {
  const { stdout } = await execFile(
    "npm",
    ["pack", packageDir, "--ignore-scripts", "--json", "--pack-destination", artifactDir],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const manifests = JSON.parse(stdout);
  if (!Array.isArray(manifests) || manifests.length !== 1 || typeof manifests[0]?.filename !== "string") {
    throw new Error("npm pack did not produce exactly one release tarball.");
  }
  return manifests[0];
};

export const validateTarEntries = ({ entries, verboseLines }) => {
  const files = [];
  const seen = new Set();
  for (const entry of entries) {
    if (!entry.startsWith("package/")) throw new Error(`Tarball entry is outside package/: ${entry}.`);
    const relative = entry.slice("package/".length);
    if (relative === "") continue;
    if (path.isAbsolute(relative) || relative.split("/").includes("..") || relative.includes("\\")) {
      throw new Error(`Tarball entry path is unsafe: ${entry}.`);
    }
    if (seen.has(relative)) throw new Error(`Tarball contains duplicate entry: ${relative}.`);
    seen.add(relative);
    files.push(relative);
  }
  for (const line of verboseLines) {
    if (line[0] !== "-" && line[0] !== "d") throw new Error("Tarball links and special entries are not allowed.");
  }
  return files;
};

const inspectTarball = async (tarball) => {
  const [{ stdout: listing }, { stdout: verboseListing }] = await Promise.all([
    execFile("tar", ["-tzf", tarball], { maxBuffer: 16 * 1024 * 1024 }),
    execFile("tar", ["-tvzf", tarball], { maxBuffer: 16 * 1024 * 1024 }),
  ]);
  const files = validateTarEntries({
    entries: listing.split("\n").filter(Boolean),
    verboseLines: verboseListing.split("\n").filter(Boolean),
  });
  const extract = async (file) =>
    (
      await execFile("tar", ["-xOzf", tarball, `package/${file}`], {
        encoding: "buffer",
        maxBuffer: 16 * 1024 * 1024,
      })
    ).stdout;
  return {
    files,
    license: await extract("LICENSE"),
    packageJson: JSON.parse((await extract("package.json")).toString("utf8")),
  };
};

const requiredPackageFiles = {
  root: ["package.json", "README.md", "LICENSE", "dist/cli.js"],
  create: ["package.json", "README.md", "LICENSE", "dist/index.js"],
};

export const verifyReleaseArtifacts = async ({ artifactDir, tag }) => {
  const manifest = JSON.parse(await readFile(path.join(artifactDir, "release-manifest.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.tag !== tag)
    return failure("Release artifact tag does not match this workflow run.");
  const artifactRoot = await realpath(artifactDir);
  const inspected = {};
  const expectedNames = { root: "tachyon-dom", create: "create-tachyon-dom" };
  for (const key of ["root", "create"]) {
    const entry = manifest.packages?.[key];
    if (!entry || entry.name !== expectedNames[key]) return failure(`Release manifest package ${key} name is invalid.`);
    const expectedFilename = `${entry.name}-${manifest.version}.tgz`;
    if (entry.filename !== expectedFilename || path.basename(entry.filename) !== entry.filename) {
      return failure(`Release manifest package ${key} filename is invalid.`);
    }
    if (typeof entry.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity)) {
      return failure(`Release manifest package ${key} integrity is invalid.`);
    }
    const tarball = path.join(artifactDir, entry.filename);
    if (path.dirname(await realpath(tarball)) !== artifactRoot)
      return failure(`Release manifest package ${key} filename escapes the artifact directory.`);
    if ((await integrityFor(tarball)) !== entry.integrity)
      return failure(`Release tarball ${key} integrity does not match.`);
    const contents = await inspectTarball(tarball);
    for (const requiredFile of requiredPackageFiles[key]) {
      if (!contents.files.includes(requiredFile)) return failure(`Release tarball ${key} is missing ${requiredFile}.`);
    }
    inspected[key] = { ...contents, tarball };
  }
  if (manifest.packages.root.filename === manifest.packages.create.filename) {
    return failure("Release manifest package filenames must be distinct.");
  }
  const identity = verifyReleaseIdentity({
    tag,
    rootPackage: inspected.root.packageJson,
    createPackage: inspected.create.packageJson,
  });
  if (!identity.ok) return identity;
  if (!inspected.root.license.equals(inspected.create.license)) {
    return failure("The create-tachyon-dom LICENSE bytes must equal the root LICENSE.");
  }
  if (manifest.version !== identity.version || manifest.npmTag !== identity.npmTag) {
    return failure("Release manifest identity does not match the packed packages.");
  }
  return { ...identity, manifest, packages: inspected };
};

export const prepareReleaseArtifacts = async ({ rootDir, artifactDir, tag }) => {
  const createDir = path.join(rootDir, "packages", "create-tachyon-dom");
  const identity = verifyReleaseIdentity({
    tag,
    rootPackage: await readPackageJson(rootDir),
    createPackage: await readPackageJson(createDir),
  });
  if (!identity.ok) return identity;
  await mkdir(artifactDir, { recursive: true });
  const [rootPack, createPack] = await Promise.all([
    packPackage({ packageDir: rootDir, artifactDir }),
    packPackage({ packageDir: createDir, artifactDir }),
  ]);
  const manifest = {
    schemaVersion: 1,
    tag,
    version: identity.version,
    npmTag: identity.npmTag,
    packages: {
      root: {
        name: "tachyon-dom",
        filename: rootPack.filename,
        integrity: await integrityFor(path.join(artifactDir, rootPack.filename)),
      },
      create: {
        name: "create-tachyon-dom",
        filename: createPack.filename,
        integrity: await integrityFor(path.join(artifactDir, createPack.filename)),
      },
    },
  };
  await writeFile(path.join(artifactDir, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
  });
  return await verifyReleaseArtifacts({ artifactDir, tag });
};

export const decidePublication = ({ expectedIntegrity, publishedIntegrity }) => {
  if (publishedIntegrity === null) return { ok: true, action: "publish" };
  if (publishedIntegrity === expectedIntegrity) return { ok: true, action: "skip" };
  return failure("The registry already contains this version with different integrity.");
};

export const dryRunReleaseArtifacts = async ({ artifactDir, tag }) => {
  const verified = await verifyReleaseArtifacts({ artifactDir, tag });
  if (!verified.ok) return verified;
  for (const key of ["root", "create"]) {
    await execFile(
      "npm",
      [
        "publish",
        verified.manifest.packages[key].filename,
        "--dry-run",
        "--ignore-scripts",
        "--provenance",
        "--access",
        "public",
        "--tag",
        verified.npmTag,
      ],
      { cwd: artifactDir, maxBuffer: 16 * 1024 * 1024 },
    );
  }
  return { ok: true, version: verified.version, npmTag: verified.npmTag };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tagIndex = process.argv.indexOf("--tag");
  const tag = tagIndex < 0 ? undefined : process.argv[tagIndex + 1];
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const outputIndex = process.argv.indexOf("--output");
    const verifyIndex = process.argv.indexOf("--verify-artifacts");
    const dryRunIndex = process.argv.indexOf("--dry-run-artifacts");
    const result =
      outputIndex >= 0
        ? await prepareReleaseArtifacts({ rootDir, artifactDir: path.resolve(process.argv[outputIndex + 1]), tag })
        : dryRunIndex >= 0
          ? await dryRunReleaseArtifacts({ artifactDir: path.resolve(process.argv[dryRunIndex + 1]), tag })
          : verifyIndex >= 0
            ? await verifyReleaseArtifacts({ artifactDir: path.resolve(process.argv[verifyIndex + 1]), tag })
            : failure("Specify --output, --dry-run-artifacts, or --verify-artifacts.");
    if (!result.ok) {
      console.error(result.error);
      process.exitCode = 1;
    } else {
      console.log(
        JSON.stringify({
          ok: true,
          version: result.version,
          npmTag: result.npmTag,
          packages: result.manifest?.packages,
        }),
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
