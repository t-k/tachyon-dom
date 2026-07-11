const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const valueAtBenchmarkPath = (value: unknown, fieldPath: string): unknown =>
  fieldPath.split(".").reduce<unknown>((current, field) => (isRecord(current) ? current[field] : undefined), value);

const nonEmptyString = (value: unknown): boolean => typeof value === "string" && value.length > 0;
const nullableString = (value: unknown): boolean => value === null || nonEmptyString(value);
const nullableBoolean = (value: unknown): boolean => value === null || typeof value === "boolean";
const positiveInteger = (value: unknown): boolean => Number.isInteger(value) && Number(value) > 0;
const stringArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const validDependencies = (value: unknown): boolean =>
  isRecord(value) &&
  Object.values(value).every(
    (dependency) =>
      isRecord(dependency) &&
      (typeof dependency.version === "string" || dependency.version === null) &&
      (dependency.reason === undefined || typeof dependency.reason === "string"),
  );

const validAvailableDependencies = (value: unknown): boolean =>
  isRecord(value) &&
  Object.keys(value).length > 0 &&
  Object.values(value).every((dependency) => isRecord(dependency) && nonEmptyString(dependency.version));

const validGitMetadata = (value: unknown): boolean => {
  if (!isRecord(value) || typeof value.available !== "boolean") return false;
  if (value.available) {
    return nonEmptyString(value.commit) && typeof value.dirty === "boolean" && nonEmptyString(value.workingTreeSha256);
  }
  return (
    value.commit === null && value.dirty === null && value.workingTreeSha256 === null && nonEmptyString(value.reason)
  );
};

const baseFieldValidators: ReadonlyArray<readonly [string, (value: unknown) => boolean]> = [
  ["schemaVersion", (value) => value === 2],
  ["benchmark.name", nonEmptyString],
  ["benchmark.contractVersion", positiveInteger],
  ["provenance.capturedAt", (value) => nonEmptyString(value) && !Number.isNaN(Date.parse(String(value)))],
  ["provenance.command.argv", stringArray],
  ["provenance.command.display", nonEmptyString],
  ["provenance.command.cwd", nonEmptyString],
  ["provenance.git", validGitMetadata],
  ["provenance.git.commit", nullableString],
  ["provenance.git.dirty", nullableBoolean],
  ["provenance.git.workingTreeSha256", nullableString],
  ["provenance.runtime.node", nonEmptyString],
  ["provenance.runtime.platform", nonEmptyString],
  ["provenance.runtime.arch", nonEmptyString],
  ["provenance.runtime.osRelease", nonEmptyString],
  ["provenance.host.hostname", nonEmptyString],
  ["provenance.host.cpuModel", nonEmptyString],
  ["provenance.host.logicalCpuCount", positiveInteger],
  ["provenance.dependencies", validDependencies],
  ["workload", isRecord],
  ["measurements", isRecord],
];

export type BenchmarkValidation = { valid: true } | { valid: false; invalidFields: string[] };

export const validateBenchmarkEnvelope = (
  value: unknown,
  requiredValuePaths: readonly string[] = [],
): BenchmarkValidation => {
  const invalidFields = baseFieldValidators
    .filter(([fieldPath, validate]) => !validate(valueAtBenchmarkPath(value, fieldPath)))
    .map(([fieldPath]) => fieldPath);
  for (const fieldPath of requiredValuePaths) {
    const requiredValue = valueAtBenchmarkPath(value, fieldPath);
    const validRequiredValue =
      fieldPath === "provenance.dependencies"
        ? validAvailableDependencies(requiredValue)
        : requiredValue !== undefined && requiredValue !== null;
    if (!validRequiredValue && !invalidFields.includes(fieldPath)) {
      invalidFields.push(fieldPath);
    }
  }
  return invalidFields.length === 0 ? { valid: true } : { valid: false, invalidFields };
};
