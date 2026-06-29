import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { err, ok, type Result } from "./result.js";

const execFileAsync = promisify(execFile);

export type PackageArtifactCheckOptions = {
  packageDir: string;
  checkPack?: boolean;
};

export type PackageArtifactCheck = {
  checkedFiles: string[];
};

type PackageJson = {
  bin?: string | Record<string, string>;
  exports?: unknown;
};

type ArtifactReference = {
  label: string;
  path: string;
};

const isDistReference = (value: string): boolean => value.startsWith("./dist/");

const normalizePackagePath = (value: string): string => value.replace(/^\.\//, "");

const collectExportReferences = (value: unknown, label: string, references: ArtifactReference[]): void => {
  if (typeof value === "string") {
    if (isDistReference(value)) {
      references.push({ label, path: value });
    }
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    collectExportReferences(nested, `${label}.${key}`, references);
  }
};

const collectArtifactReferences = (packageJson: PackageJson): ArtifactReference[] => {
  const references: ArtifactReference[] = [];
  if (typeof packageJson.bin === "string") {
    references.push({ label: "bin", path: packageJson.bin });
  } else if (packageJson.bin) {
    for (const [name, value] of Object.entries(packageJson.bin)) {
      references.push({ label: `bin.${name}`, path: value });
    }
  }
  collectExportReferences(packageJson.exports, "exports", references);
  return references.filter((reference) => isDistReference(reference.path));
};

const packedFilesFor = async (packageDir: string): Promise<Set<string>> => {
  const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"], { cwd: packageDir });
  const [pack] = JSON.parse(stdout) as Array<{ files?: Array<{ path?: string }> }>;
  return new Set((pack?.files ?? []).flatMap((file) => (file.path ? [file.path] : [])));
};

export const verifyPackageArtifacts = async (
  options: PackageArtifactCheckOptions,
): Promise<Result<PackageArtifactCheck, string>> => {
  const packageJson = JSON.parse(await readFile(`${options.packageDir}/package.json`, "utf8")) as PackageJson;
  const references = collectArtifactReferences(packageJson);
  const missing: string[] = [];
  for (const reference of references) {
    try {
      await access(`${options.packageDir}/${normalizePackagePath(reference.path)}`);
    } catch {
      missing.push(`${reference.label} -> ${reference.path}`);
    }
  }
  if (options.checkPack !== false) {
    const packedFiles = await packedFilesFor(options.packageDir);
    for (const reference of references) {
      if (!packedFiles.has(normalizePackagePath(reference.path))) {
        missing.push(`${reference.label} -> ${reference.path} is not included in npm pack output`);
      }
    }
  }
  if (missing.length > 0) {
    return err(`Package artifact verification failed:\n${missing.map((item) => `- ${item}`).join("\n")}`);
  }
  return ok({ checkedFiles: references.map((reference) => normalizePackagePath(reference.path)).sort() });
};
