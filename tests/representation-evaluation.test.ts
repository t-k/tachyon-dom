import { describe, expect, it } from "vitest";
import { runRepresentationEvaluation } from "../benchmark/representation-evaluation";

describe("runtime representation evaluations", () => {
  it("records raw samples and explicit adoption decisions", async () => {
    const result = await runRepresentationEvaluation({ iterations: 2, warmup: 0 });

    expect(result.measurements.rowCodegen.domEquivalent).toBe(true);
    expect(result.measurements.rowCodegen.generic.rawSamples).toHaveLength(2);
    expect(result.measurements.rowCodegen.specialized.rawSamples).toHaveLength(2);
    expect(Object.keys(result.measurements.signal.distributions)).toEqual(["0", "1", "4", "16"]);
    expect(result.measurements.signal.distributions["4"]?.rawSamples).toHaveLength(4);
    expect(result.measurements.metadata.rawSamples).toHaveLength(2);
    expect(
      result.measurements.signal.distributions["4"]?.rawSamples.every(
        (sample) => Number.isFinite(sample.heapDeltaBytes) && sample.allocatedBytes === null,
      ),
    ).toBe(true);
    expect(
      Object.values(result.measurements.signal.distributions).every(({ rawSamples }) =>
        rawSamples.every((sample) => sample.contractEquivalent),
      ),
    ).toBe(true);
    expect(
      result.measurements.rowCodegen.generic.rawSamples.every(
        (sample) =>
          sample.evidence.identityPreserved && sample.evidence.finalEmpty && sample.evidence.cleanupEquivalent,
      ),
    ).toBe(true);
    expect(
      result.measurements.rowCodegen.specialized.rawSamples.every(
        (sample) =>
          sample.evidence.identityPreserved && sample.evidence.finalEmpty && sample.evidence.cleanupEquivalent,
      ),
    ).toBe(true);
    expect(
      result.measurements.metadata.rawSamples.every(
        (sample) =>
          sample.currentMinifiedBytes > 0 &&
          sample.compactMinifiedBytes > 0 &&
          sample.currentBrotliBytes > 0 &&
          sample.compactBrotliBytes > 0 &&
          sample.currentParseDurationMs >= 0 &&
          sample.compactParseDurationMs >= 0 &&
          sample.metadataEquivalent &&
          sample.hmrSafe &&
          sample.scopesIndependent,
      ),
    ).toBe(true);
    expect(result.measurements.rowCodegen.decision.reason).toBeTruthy();
    expect(result.measurements.signal.decision.reason).toBeTruthy();
    expect(result.measurements.metadata.decision.reason).toBeTruthy();
  });
});
