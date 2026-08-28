import { describe, expect, it } from "vitest";

type Density = "inert" | "dense-decoy";
type Measurement = { id: string; codeUnits: number; density: Density; medianRatio: number };
type Controls = { samples: number; warmups: number; fixedIterations: number | null; maxCodeUnits: number };
type Evaluation = {
  eligible: boolean;
  complete: boolean;
  canonicalControls: boolean;
  shortPass: boolean;
  longInertPass: boolean;
  densePass: boolean;
};
type Evaluator = (measurements: readonly Measurement[], controls: Controls) => Evaluation;

const loadEvaluator = async (): Promise<Evaluator | undefined> => {
  try {
    const modulePath = "../benchmark/raw-text-scan/evaluation";
    return (await import(/* @vite-ignore */ modulePath)).evaluateRawTextScanEligibility;
  } catch {
    return undefined;
  }
};

const canonicalControls: Controls = {
  samples: 9,
  warmups: 2,
  fixedIterations: null,
  maxCodeUnits: 1024 * 1024,
};

const measurementsAtThresholds = (): Measurement[] =>
  [16, 256, 4 * 1024, 64 * 1024, 1024 * 1024].flatMap((codeUnits) =>
    (["inert", "dense-decoy"] as const).flatMap((density) =>
      Array.from({ length: 4 }, (_, stateIndex) => ({
        id: `${codeUnits}-${density}-${stateIndex}`,
        codeUnits,
        density,
        medianRatio:
          codeUnits === 64 * 1024 && density === "inert"
            ? 1 / 1.5
            : codeUnits === 16 || codeUnits === 256 || density === "dense-decoy"
              ? 1.1
              : 1,
      })),
    ),
  );

const withRatio = (measurements: Measurement[], id: string, medianRatio: number): Measurement[] =>
  measurements.map((measurement) => (measurement.id === id ? { ...measurement, medianRatio } : measurement));

describe("raw-text scanner benchmark evaluation", () => {
  it("accepts the exact canonical matrix at every approved threshold", async () => {
    const evaluate = await loadEvaluator();
    expect(evaluate).toBeTypeOf("function");
    if (!evaluate) return;

    expect(evaluate(measurementsAtThresholds(), canonicalControls)).toEqual({
      eligible: true,
      complete: true,
      canonicalControls: true,
      shortPass: true,
      longInertPass: true,
      densePass: true,
    });
  });

  it("rejects a ratio above each approved threshold", async () => {
    const evaluate = await loadEvaluator();
    expect(evaluate).toBeTypeOf("function");
    if (!evaluate) return;

    const measurements = measurementsAtThresholds();
    expect(evaluate(withRatio(measurements, "16-inert-0", 1.100_001), canonicalControls)).toMatchObject({
      eligible: false,
      shortPass: false,
    });
    expect(evaluate(withRatio(measurements, "65536-inert-0", 1 / 1.5 + 0.000_001), canonicalControls)).toMatchObject({
      eligible: false,
      longInertPass: false,
    });
    expect(evaluate(withRatio(measurements, "4096-dense-decoy-0", 1.100_001), canonicalControls)).toMatchObject({
      eligible: false,
      densePass: false,
    });
  });

  it("rejects incomplete workload groups and noncanonical controls", async () => {
    const evaluate = await loadEvaluator();
    expect(evaluate).toBeTypeOf("function");
    if (!evaluate) return;

    const measurements = measurementsAtThresholds();
    for (const missingId of ["16-inert-0", "65536-inert-0", "4096-dense-decoy-0"]) {
      expect(
        evaluate(
          measurements.filter(({ id }) => id !== missingId),
          canonicalControls,
        ),
      ).toMatchObject({
        eligible: false,
        complete: false,
      });
    }

    for (const controls of [
      { ...canonicalControls, samples: 8 },
      { ...canonicalControls, warmups: 1 },
      { ...canonicalControls, fixedIterations: 1 },
      { ...canonicalControls, maxCodeUnits: 64 * 1024 },
    ]) {
      expect(evaluate(measurements, controls)).toMatchObject({
        eligible: false,
        complete: false,
        canonicalControls: false,
      });
    }
  });
});
