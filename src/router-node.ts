import { readdir } from "node:fs/promises";
import path from "node:path";
import { createFileRouteManifest, type FileRouteManifestEntry } from "./router.js";

const collectFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(directory, entry.name);
      return entry.isDirectory() ? await collectFiles(absolute) : [absolute];
    }),
  );
  return files.flat();
};

export const scanFileRoutes = async (rootDir: string): Promise<FileRouteManifestEntry[]> =>
  createFileRouteManifest(await collectFiles(rootDir), { rootDir });
