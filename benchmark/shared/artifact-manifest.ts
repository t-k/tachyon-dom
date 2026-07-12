import { createHash } from "node:crypto";

export type ArtifactProcessIdentity = {
  pid: number;
  processStartedAt: string;
};

export type ArtifactManifest = ArtifactProcessIdentity & {
  sha256: string;
};

const canonicalValue = (value: unknown, path: readonly string[] = []): unknown => {
  if (Array.isArray(value)) return value.map((item, index) => canonicalValue(item, [...path, String(index)]));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !(path.length === 1 && path[0] === "manifest" && key === "sha256"))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item, [...path, key])]),
  );
};

export const canonicalArtifactJson = (value: unknown): string => JSON.stringify(canonicalValue(value));

const sha256 = (value: unknown): string => createHash("sha256").update(canonicalArtifactJson(value)).digest("hex");

const validIdentity = (identity: ArtifactProcessIdentity): boolean =>
  Number.isInteger(identity.pid) &&
  identity.pid > 0 &&
  Number.isFinite(Date.parse(identity.processStartedAt));

export const attachArtifactManifest = <T extends Record<string, unknown>>(
  value: T,
  identity: ArtifactProcessIdentity,
): T & { manifest: ArtifactManifest } => {
  if (!validIdentity(identity)) throw new Error("invalid process identity");
  const artifact = { ...value, manifest: { ...identity, sha256: "" } };
  artifact.manifest.sha256 = sha256(artifact);
  return artifact;
};

export const verifyArtifactManifest = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const manifest = (value as { manifest?: unknown }).manifest;
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return false;
  const identity = manifest as Partial<ArtifactManifest>;
  if (
    typeof identity.pid !== "number" ||
    typeof identity.processStartedAt !== "string" ||
    typeof identity.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(identity.sha256) ||
    !validIdentity({ pid: identity.pid, processStartedAt: identity.processStartedAt })
  ) {
    return false;
  }
  return sha256(value) === identity.sha256;
};
