export type PackageMetadata = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
};

export type ReleaseIdentityResult =
  | { ok: true; version: string; npmTag: "latest" | "next" }
  | { ok: false; error: string };

export const verifyReleaseIdentity: (options: {
  tag: unknown;
  rootPackage: PackageMetadata;
  createPackage: PackageMetadata;
}) => ReleaseIdentityResult;

export const inspectPackageDryRun: (options: {
  packageDir: string;
  requiredFiles: string[];
}) => Promise<{ ok: true; files: string[] } | { ok: false; error: string }>;

export type ReleaseArtifactResult =
  | {
      ok: true;
      version: string;
      npmTag: "latest" | "next";
      manifest: any;
      packages: any;
    }
  | { ok: false; error: string };

export const prepareReleaseArtifacts: (options: {
  rootDir: string;
  artifactDir: string;
  tag: unknown;
}) => Promise<ReleaseArtifactResult>;

export const verifyReleaseArtifacts: (options: { artifactDir: string; tag: unknown }) => Promise<ReleaseArtifactResult>;

export const decidePublication: (options: {
  expectedIntegrity: string;
  publishedIntegrity: string | null;
}) => { ok: true; action: "publish" | "skip" } | { ok: false; error: string };

export const dryRunReleaseArtifacts: (options: {
  artifactDir: string;
  tag: unknown;
}) => Promise<{ ok: true; version: string; npmTag: "latest" | "next" } | { ok: false; error: string }>;
