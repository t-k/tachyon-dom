export type FastCheckEnvironment = {
  FAST_CHECK_NUM_RUNS?: string;
  FAST_CHECK_PATH?: string;
  FAST_CHECK_SEED?: string;
};

export type PropertyRunParameters = {
  numRuns: number;
  path?: string;
  seed: number;
};

export type PropertyRunDefaults = {
  numRuns?: number;
  seed?: number;
};

const defaultSeed = 0x7a11c0de;
const defaultNumRuns = 100;

const safeInteger = (name: string, value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`${name} must be a safe integer.`);
  return parsed;
};

const positiveSafeInteger = (name: string, value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return parsed;
};

export const resolveFastCheckParameters = (
  environment: FastCheckEnvironment,
  defaults: PropertyRunDefaults = {},
): PropertyRunParameters => {
  const seed = safeInteger("FAST_CHECK_SEED", environment.FAST_CHECK_SEED, defaults.seed ?? defaultSeed);
  const numRuns = positiveSafeInteger(
    "FAST_CHECK_NUM_RUNS",
    environment.FAST_CHECK_NUM_RUNS,
    defaults.numRuns ?? defaultNumRuns,
  );
  const path = environment.FAST_CHECK_PATH;
  return path ? { seed, path, numRuns } : { seed, numRuns };
};

export const propertyParameters = (defaults: PropertyRunDefaults = {}): PropertyRunParameters =>
  resolveFastCheckParameters(process.env, defaults);
