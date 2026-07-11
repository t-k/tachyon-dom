export const publishReleasePackage: (options: {
  artifactDir: string;
  tag: string;
  packageKey: "root" | "create";
}) => Promise<{ action: "publish" | "skip"; package: string; version: string }>;
