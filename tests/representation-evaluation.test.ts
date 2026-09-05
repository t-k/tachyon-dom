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
    expect(result.measurements.rowCodegen.decision.reason).toBeTruthy();
    expect(result.measurements.signal.decision.reason).toBeTruthy();
    expect(result.measurements.metadata.decision.reason).toBeTruthy();
  });
});
