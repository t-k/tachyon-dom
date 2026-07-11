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

export const verifyReleaseRepository: (options: {
  rootDir: string;
  tag: unknown;
}) => Promise<
  | { ok: true; version: string; npmTag: "latest" | "next"; packages: { root: string[]; create: string[] } }
  | { ok: false; error: string }
>;
