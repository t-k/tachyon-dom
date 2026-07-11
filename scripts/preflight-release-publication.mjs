import path from "node:path";

import { decidePublication, verifyReleaseArtifacts } from "./release-contract.mjs";
import { decideDistTagTransition, readRegistryState } from "./npm-registry-state.mjs";

export const preflightReleasePublication = async ({ artifactDir, tag, registryUrl }) => {
  const verified = await verifyReleaseArtifacts({ artifactDir, tag });
  if (!verified.ok) throw new Error(verified.error);
  const packages = {};
  for (const key of ["root", "create"]) {
    const entry = verified.manifest.packages[key];
    const registry = await readRegistryState({ registryUrl, name: entry.name, version: verified.version });
    const publication = decidePublication({
      expectedIntegrity: entry.integrity,
      publishedIntegrity: registry.integrity,
    });
    if (!publication.ok) throw new Error(`${entry.name}: ${publication.error}`);
    const distTag = decideDistTagTransition({
      currentVersion: registry.distTags[verified.npmTag],
      targetVersion: verified.version,
    });
    if (!distTag.ok) throw new Error(`${entry.name}: ${distTag.error}`);
    packages[key] = {
      publication: publication.action,
      distTag: distTag.action,
      previousTag: registry.distTags[verified.npmTag],
    };
  }
  return { version: verified.version, npmTag: verified.npmTag, packages };
};

if (process.argv[1]?.endsWith("preflight-release-publication.mjs")) {
  const artifactIndex = process.argv.indexOf("--artifact-dir");
  const tagIndex = process.argv.indexOf("--tag");
  const result = await preflightReleasePublication({
    artifactDir: path.resolve(process.argv[artifactIndex + 1]),
    tag: process.argv[tagIndex + 1],
  });
  console.log(JSON.stringify(result));
}
