import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { decidePublication, verifyReleaseArtifacts } from "./release-contract.mjs";
import { npmRegistryUrl, readRegistryState, stagingTagFor } from "./npm-registry-state.mjs";

const execFile = promisify(execFileCallback);

export const publishReleasePackage = async ({ artifactDir, tag, packageKey }) => {
  const verified = await verifyReleaseArtifacts({ artifactDir, tag });
  if (!verified.ok) throw new Error(verified.error);
  if (packageKey !== "root" && packageKey !== "create") throw new Error("Package key must be root or create.");
  const entry = verified.manifest.packages[packageKey];
  const registry = await readRegistryState({ name: entry.name, version: verified.version });
  const decision = decidePublication({ expectedIntegrity: entry.integrity, publishedIntegrity: registry.integrity });
  if (!decision.ok) throw new Error(decision.error);
  if (decision.action === "skip") {
    return { action: "skip", package: entry.name, version: verified.version };
  }
  const reverified = await verifyReleaseArtifacts({ artifactDir, tag });
  if (!reverified.ok) throw new Error(reverified.error);
  const { stdout, stderr } = await execFile(
    "npm",
    [
      "publish",
      entry.filename,
      "--provenance",
      "--access",
      "public",
      "--tag",
      stagingTagFor(verified.version),
      "--registry",
      npmRegistryUrl,
    ],
    { cwd: artifactDir, maxBuffer: 16 * 1024 * 1024 },
  );
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  return { action: "publish", package: entry.name, version: verified.version };
};

const artifactIndex = process.argv.indexOf("--artifact-dir");
const tagIndex = process.argv.indexOf("--tag");
const packageIndex = process.argv.indexOf("--package");
if (process.argv[1] && process.argv[1].endsWith("publish-release-package.mjs")) {
  const result = await publishReleasePackage({
    artifactDir: path.resolve(process.argv[artifactIndex + 1]),
    tag: process.argv[tagIndex + 1],
    packageKey: process.argv[packageIndex + 1],
  });
  console.log(JSON.stringify(result));
}
