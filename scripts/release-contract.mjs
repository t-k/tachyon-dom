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
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
