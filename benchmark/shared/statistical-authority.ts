export type AuthorityStatus = "meaningful-win" | "reproducible-win" | "tie-or-loss" | "inconclusive";

export type RatioAnalysis = {
  status: AuthorityStatus;
  medianRatio: number;
  oneSided95UpperBound: number;
  independentRunCount: number;
};

const createRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const validateRawValues = (values: readonly number[]): void => {
  if (values.length === 0) throw new Error("raw samples must be non-empty");
  if (values.some((value) => !Number.isFinite(value))) throw new Error("raw samples must be finite");
};

export const median = (values: readonly number[]): number => {
  validateRawValues(values);
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
};

export const trimmedMean = (values: readonly number[], trimFraction: number): number => {
  validateRawValues(values);
  if (!Number.isFinite(trimFraction) || trimFraction < 0 || trimFraction >= 0.5) {
    throw new Error("trim fraction must be finite and in [0, 0.5)");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const trimCount = Math.floor(sorted.length * trimFraction);
  const retained = sorted.slice(trimCount, sorted.length - trimCount);
  return retained.reduce((total, value) => total + value, 0) / retained.length;
};

const percentile = (values: readonly number[], fraction: number): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(fraction * sorted.length) - 1] as number;
};

export const balancedOrder = <T>(items: readonly T[], runIndex: number, seed: number): T[] => {
  if (items.length === 0) return [];
  if (!Number.isInteger(runIndex) || runIndex < 0) throw new Error("runIndex must be a non-negative integer");
  if (!Number.isInteger(seed)) throw new Error("seed must be an integer");

  const random = createRandom(seed);
  const base = [...items];
  for (let index = base.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [base[index], base[swapIndex]] = [base[swapIndex] as T, base[index] as T];
  }
  const offset = runIndex % base.length;
  return [...base.slice(offset), ...base.slice(0, offset)];
};

export const analyzeRatios = (
  ratios: readonly number[],
  options: { seed: number; resamples: number },
): RatioAnalysis => {
  if (ratios.some((ratio) => !Number.isFinite(ratio) || ratio <= 0)) {
    throw new Error("ratios must contain only finite positive values");
  }
  if (!Number.isInteger(options.resamples) || options.resamples <= 0) {
    throw new Error("resamples must be a positive integer");
  }
  if (!Number.isInteger(options.seed)) throw new Error("seed must be an integer");

  const medianRatio = ratios.length === 0 ? Number.NaN : median(ratios);
  if (ratios.length < 5) {
    return {
      status: "inconclusive",
      medianRatio,
      oneSided95UpperBound: Number.NaN,
      independentRunCount: ratios.length,
    };
  }

  const random = createRandom(options.seed);
  const resampledMedians = Array.from({ length: options.resamples }, () => {
    const sample = Array.from({ length: ratios.length }, () => ratios[Math.floor(random() * ratios.length)] as number);
    return median(sample);
  });
  const oneSided95UpperBound = percentile(resampledMedians, 0.95);
  const status: AuthorityStatus =
    oneSided95UpperBound <= 0.99
      ? "meaningful-win"
      : oneSided95UpperBound < 1
        ? "reproducible-win"
        : medianRatio >= 1
          ? "tie-or-loss"
          : "inconclusive";
  return { status, medianRatio, oneSided95UpperBound, independentRunCount: ratios.length };
};
