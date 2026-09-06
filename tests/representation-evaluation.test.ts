import { describe, expect, it } from "vitest";
import {
  REPRESENTATION_EVALUATION_CONTRACT_VERSION,
  runRepresentationEvaluation,
} from "../benchmark/representation-evaluation";

describe("runtime representation evaluations", () => {
  it("executes and sizes the same artifacts, validates candidates against production contracts, and records decisions", async () => {
    const result = await runRepresentationEvaluation({ iterations: 2, warmup: 0 });

    expect(result.benchmark.contractVersion).toBe(REPRESENTATION_EVALUATION_CONTRACT_VERSION);
    expect(result.workload.buildMode).toBe("bundled-artifact");

    const row = result.measurements.rowCodegen;
    expect(row.stagesEquivalent).toBe(true);
    expect(row.generic.rawSamples).toHaveLength(2);
    expect(row.specialized.rawSamples).toHaveLength(2);
    expect(row.generic.artifactHash).not.toBe(row.specialized.artifactHash);
    expect(row.generic.size.minifiedBytes).toBeGreaterThan(0);
    expect(row.specialized.size.brotliBytes).toBeGreaterThan(0);
    for (const sample of [...row.generic.rawSamples, ...row.specialized.rawSamples]) {
      expect(sample.stagesEquivalent).toBe(true);
      expect(sample.stages.map((stage) => stage.stage)).toEqual(["create", "update", "reorder", "remove", "dispose"]);
      expect(sample.stages[2]?.identityPreserved).toBe(24);
      expect(sample.stages[4]?.values).toEqual([]);
      expect(sample.allocatedBytes).toBeNull();
    }
    expect(row.fallback).toEqual({ candidateDeclined: true, classToggled: true, clickHandled: true, modelWrittenBack: true });

    const signal = result.measurements.signal;
    expect(signal.ineligible).toEqual([]);
    expect(signal.productionTrace).toContain("after-batch");
    expect(signal.productionTrace.some((entry) => entry.startsWith("caught:effect failure"))).toBe(true);
    expect(signal.productionTrace.some((entry) => entry.startsWith("cleanup-caught:cleanup failure"))).toBe(true);
    expect(signal.productionTrace.filter((entry) => entry.startsWith("sibling:"))).toContain("sibling:4");
    expect(Object.keys(signal.distributions)).toEqual(["0", "1", "4", "16"]);
    for (const { rawSamples } of Object.values(signal.distributions)) {
      expect(rawSamples).toHaveLength(6);
      expect(rawSamples.every((sample) => sample.contractEquivalent && sample.eligible)).toBe(true);
      expect(new Set(rawSamples.map((sample) => sample.representation))).toEqual(new Set(["production", "set", "array"]));
    }

    const metadata = result.measurements.metadata;
    expect(metadata.rawSamples).toHaveLength(2);
    for (const sample of metadata.rawSamples) {
      expect(sample.consumerEquivalent).toBe(true);
      expect(sample.twoInstancesIndependent).toBe(true);
      expect(sample.storeShadowingIndependent).toBe(true);
      expect(sample.hmrSafe).toBe(true);
      expect(sample.currentArtifactHash).not.toBe(sample.compactArtifactHash);
      expect(sample.currentSize.minifiedBytes).toBeGreaterThan(0);
      expect(sample.compactSize.minifiedBytes).toBeGreaterThan(0);
    }
    expect(row.decision.adopted).toBe(false);
    expect(signal.decision.adopted).toBe(false);
    expect(metadata.decision.adopted).toBe(false);
  });
});
