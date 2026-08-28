export type RawTextScanEvaluationControls = {
  samples: number;
  warmups: number;
  fixedIterations: number | null;
  maxCodeUnits: number;
};

export type RawTextScanEvaluationMeasurement = {
  codeUnits: number;
  density: "inert" | "dense-decoy";
  medianRatio: number;
};

export type RawTextScanEvaluation = {
  eligible: boolean;
  complete: boolean;
  canonicalControls: boolean;
  shortPass: boolean;
  longInertPass: boolean;
  densePass: boolean;
};

const ratiosPass = (
  entries: readonly RawTextScanEvaluationMeasurement[],
  expectedCount: number,
  maximum: number,
): boolean => entries.length === expectedCount && entries.every(({ medianRatio }) => medianRatio <= maximum);

export const evaluateRawTextScanEligibility = (
  measurements: readonly RawTextScanEvaluationMeasurement[],
  controls: RawTextScanEvaluationControls,
): RawTextScanEvaluation => {
  const shortWorkloads = measurements.filter(({ codeUnits }) => codeUnits === 16 || codeUnits === 256);
  const longInertWorkloads = measurements.filter(
    ({ codeUnits, density }) => codeUnits === 64 * 1024 && density === "inert",
  );
  const denseWorkloads = measurements.filter(({ density }) => density === "dense-decoy");
  const shortPass = ratiosPass(shortWorkloads, 16, 1.1);
  const longInertPass = ratiosPass(longInertWorkloads, 4, 1 / 1.5);
  const densePass = ratiosPass(denseWorkloads, 20, 1.1);
  const canonicalControls =
    controls.samples === 9 &&
    controls.warmups === 2 &&
    controls.fixedIterations === null &&
    controls.maxCodeUnits === 1024 * 1024;
  const complete =
    canonicalControls &&
    measurements.length === 40 &&
    shortWorkloads.length === 16 &&
    longInertWorkloads.length === 4 &&
    denseWorkloads.length === 20;

  return {
    eligible: complete && shortPass && longInertPass && densePass,
    complete,
    canonicalControls,
    shortPass,
    longInertPass,
    densePass,
  };
};
