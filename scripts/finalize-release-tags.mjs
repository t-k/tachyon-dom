import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { decideOwnedTagMutation, npmRegistryUrl, readRegistryState, stagingTagFor } from "./npm-registry-state.mjs";
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
      const entry = verified.manifest.packages[key];
      const registry = await readRegistryState({ name: entry.name, version: verified.version });
      const ownership = decideOwnedTagMutation({
        currentVersion: registry.distTags[verified.npmTag],
        expectedVersion: plan.previousTag,
        nextVersion: verified.version,
      });
      if (!ownership.ok) throw new Error(`${entry.name}: ${ownership.error}`);
      if (ownership.action === "noop") continue;
      await addDistTag(entry.name, verified.version, verified.npmTag);
      changed.push({ name: entry.name, previousTag: plan.previousTag });
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const change of changed.reverse()) {
      try {
        const registry = await readRegistryState({ name: change.name, version: verified.version });
        const ownership = decideOwnedTagMutation({
          currentVersion: registry.distTags[verified.npmTag],
          expectedVersion: verified.version,
          nextVersion: change.previousTag,
        });
        if (!ownership.ok) throw new Error(`${change.name}: ${ownership.error}`);
        if (ownership.action === "remove") await removeDistTag(change.name, verified.npmTag, verified.version);
        else if (ownership.action === "update") await addDistTag(change.name, change.previousTag, verified.npmTag);
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

  const stagingTag = stagingTagFor(verified.version);
  for (const key of ["root", "create"]) {
    const entry = verified.manifest.packages[key];
    const registry = await readRegistryState({ name: entry.name, version: verified.version });
    const currentStaging = registry.distTags[stagingTag];
    if (currentStaging === undefined) continue;
    if (currentStaging !== verified.version) {
      throw new Error(`${entry.name}: staging dist-tag ownership changed to ${currentStaging}.`);
    }
    await removeDistTag(entry.name, stagingTag, verified.version);
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
