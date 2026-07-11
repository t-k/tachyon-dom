export const preflightReleasePublication: (options: {
  artifactDir: string;
  tag: string;
  registryUrl?: string | undefined;
}) => Promise<{
  version: string;
  npmTag: "latest" | "next";
  packages: Record<
    "root" | "create",
    { publication: "publish" | "skip"; distTag: "update" | "noop"; previousTag?: string }
  >;
}>;
