export const finalizeReleaseTags: (options: {
  artifactDir: string;
  tag: string;
}) => Promise<{ version: string; npmTag: "latest" | "next" }>;
