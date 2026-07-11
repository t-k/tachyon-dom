import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { npmRegistryUrl, readRegistryState } from "./npm-registry-state.mjs";
import { preflightReleasePublication } from "./preflight-release-publication.mjs";
import { verifyReleaseArtifacts } from "./release-contract.mjs";

const execFile = promisify(execFileCallback);

const addDistTag = async (name, version, tag) => {
  try {
    await execFile("npm", ["dist-tag", "add", `${name}@${version}`, tag, "--registry", npmRegistryUrl]);
  } catch (error) {
    const registry = await readRegistryState({ name, version });
    if (registry.distTags[tag] !== version) throw error;
  }
};

const removeDistTag = async (name, tag, version) => {
  try {
    await execFile("npm", ["dist-tag", "rm", name, tag, "--registry", npmRegistryUrl]);
  } catch (error) {
    const registry = await readRegistryState({ name, version });
    if (registry.distTags[tag] !== undefined) throw error;
  }
};

export const finalizeReleaseTags = async ({ artifactDir, tag }) => {
  const verified = await verifyReleaseArtifacts({ artifactDir, tag });
  if (!verified.ok) throw new Error(verified.error);
  const preflight = await preflightReleasePublication({ artifactDir, tag });
  for (const key of ["root", "create"]) {
    if (preflight.packages[key].publication !== "skip") {
      throw new Error(
        `${verified.manifest.packages[key].name}@${verified.version} is not published with verified integrity.`,
      );
    }
  }

  const changed = [];
  try {
    for (const key of ["root", "create"]) {
      const plan = preflight.packages[key];
      if (plan.distTag === "noop") continue;
      const entry = verified.manifest.packages[key];
      await addDistTag(entry.name, verified.version, verified.npmTag);
      changed.push({ name: entry.name, previousTag: plan.previousTag });
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const change of changed.reverse()) {
      try {
        if (change.previousTag === undefined) await removeDistTag(change.name, verified.npmTag, verified.version);
        else await addDistTag(change.name, change.previousTag, verified.npmTag);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} Rollback failed: ${rollbackErrors.join("; ")}`,
      );
    }
    throw error;
  }

  for (const key of ["root", "create"]) {
    const entry = verified.manifest.packages[key];
    const registry = await readRegistryState({ name: entry.name, version: verified.version });
    if (registry.distTags["tachyon-staging"] === verified.version) {
      await removeDistTag(entry.name, "tachyon-staging", verified.version);
    }
  }
  return { version: verified.version, npmTag: verified.npmTag };
};

if (process.argv[1]?.endsWith("finalize-release-tags.mjs")) {
  const artifactIndex = process.argv.indexOf("--artifact-dir");
  const tagIndex = process.argv.indexOf("--tag");
  const result = await finalizeReleaseTags({
    artifactDir: path.resolve(process.argv[artifactIndex + 1]),
    tag: process.argv[tagIndex + 1],
  });
  console.log(JSON.stringify(result));
}
