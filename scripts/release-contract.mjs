import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
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

export const verifyReleaseRepository = async ({ rootDir, tag }) => {
  const createDir = path.join(rootDir, "packages", "create-tachyon-dom");
  const identity = verifyReleaseIdentity({
    tag,
    rootPackage: await readPackageJson(rootDir),
    createPackage: await readPackageJson(createDir),
  });
  if (!identity.ok) return identity;

  const [rootManifest, createManifest, rootLicense, createLicense] = await Promise.all([
    inspectPackageDryRun({ packageDir: rootDir, requiredFiles: ["package.json", "README.md", "LICENSE", "dist/cli.js"] }),
    inspectPackageDryRun({
      packageDir: createDir,
      requiredFiles: ["package.json", "README.md", "LICENSE", "dist/index.js"],
    }),
    readFile(path.join(rootDir, "LICENSE")),
    readFile(path.join(createDir, "LICENSE")),
  ]);
  if (!rootManifest.ok) return rootManifest;
  if (!createManifest.ok) return createManifest;
  if (!rootLicense.equals(createLicense)) return failure("The create-tachyon-dom LICENSE bytes must equal the root LICENSE.");
  return { ...identity, packages: { root: rootManifest.files, create: createManifest.files } };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tagIndex = process.argv.indexOf("--tag");
  const tag = tagIndex < 0 ? undefined : process.argv[tagIndex + 1];
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const result = await verifyReleaseRepository({ rootDir, tag });
    if (!result.ok) {
      console.error(result.error);
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify(result));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
