export const npmRegistryUrl: "https://registry.npmjs.org/";
export const compareSemVer: (leftVersion: string, rightVersion: string) => -1 | 0 | 1;
export const decideDistTagTransition: (options: {
  currentVersion?: string | undefined;
  targetVersion: string;
}) => { ok: true; action: "update" | "noop" } | { ok: false; error: string };
export const readRegistryState: (options: {
  registryUrl?: string;
  name: string;
  version: string;
}) => Promise<{ integrity: string | null; distTags: Record<string, string> }>;
