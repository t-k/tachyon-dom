import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { decidePublication, verifyReleaseArtifacts } from "./release-contract.mjs";

const execFile = promisify(execFileCallback);

const publishedIntegrityFor = async (name, version) => {
  try {
    const { stdout } = await execFile("npm", ["view", `${name}@${version}`, "dist.integrity", "--json"]);
    const integrity = JSON.parse(stdout);
    if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
      throw new Error(`The registry returned invalid integrity for ${name}@${version}.`);
    }
    return integrity;
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    if (stderr.includes("E404") || stderr.includes("404 Not Found")) return null;
    throw error;
  }
};

export const publishReleasePackage = async ({ artifactDir, tag, packageKey }) => {
  const verified = await verifyReleaseArtifacts({ artifactDir, tag });
  if (!verified.ok) throw new Error(verified.error);
  if (packageKey !== "root" && packageKey !== "create") throw new Error("Package key must be root or create.");
  const entry = verified.manifest.packages[packageKey];
  const publishedIntegrity = await publishedIntegrityFor(entry.name, verified.version);
  const decision = decidePublication({ expectedIntegrity: entry.integrity, publishedIntegrity });
  if (!decision.ok) throw new Error(decision.error);
  if (decision.action === "skip") {
    await execFile("npm", ["dist-tag", "add", `${entry.name}@${verified.version}`, verified.npmTag]);
    return { action: "skip", package: entry.name, version: verified.version };
  }
  const { stdout, stderr } = await execFile(
    "npm",
    ["publish", entry.filename, "--provenance", "--access", "public", "--tag", verified.npmTag],
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
