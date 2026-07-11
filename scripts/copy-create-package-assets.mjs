import { copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

export const copyCreatePackageAssets = async ({
  rootDir = path.resolve(scriptDir, ".."),
  packageDir = path.resolve(rootDir, "packages/create-tachyon-dom"),
} = {}) => {
  await copyFile(path.join(rootDir, "LICENSE"), path.join(packageDir, "LICENSE"));
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await copyCreatePackageAssets();
}
