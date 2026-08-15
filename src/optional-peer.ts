export const optionalPeerError = (packageName: string, feature: string, cause?: unknown): Error =>
  new Error(
    `${feature} requires the optional peer dependency ${JSON.stringify(packageName)}. Install it with "pnpm add ${packageName}".`,
    { cause },
  );
