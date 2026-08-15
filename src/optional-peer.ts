export const optionalPeerError = (packageName: string, feature: string, cause?: unknown): Error =>
  new Error(
    `${feature} requires the optional peer dependency ${JSON.stringify(packageName)}. Install it with "pnpm add ${packageName}".`,
    { cause },
  );

type NodeProcessWithBuiltinModule = {
  process?: {
    getBuiltinModule?: (name: string) => unknown;
  };
};

type CreateRequireModule = {
  createRequire?: (filename: string) => (specifier: string) => unknown;
};

const optionalPeerCache = new Map<string, unknown>();

export const requireOptionalPeer = <Module>(packageName: string, feature: string, specifier = packageName): Module => {
  if (optionalPeerCache.has(specifier)) {
    return optionalPeerCache.get(specifier) as Module;
  }
  try {
    const moduleApi = (globalThis as NodeProcessWithBuiltinModule).process?.getBuiltinModule?.("module") as
      | CreateRequireModule
      | undefined;
    const require = moduleApi?.createRequire?.(import.meta.url);
    if (!require) {
      throw new Error("The current runtime does not expose Node.js module loading.");
    }
    const loaded = require(specifier) as Module;
    optionalPeerCache.set(specifier, loaded);
    return loaded;
  } catch (cause) {
    throw optionalPeerError(packageName, feature, cause);
  }
};
