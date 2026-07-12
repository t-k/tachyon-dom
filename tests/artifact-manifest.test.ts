import { describe, expect, it } from "vitest";
import {
  attachArtifactManifest,
  canonicalArtifactJson,
  verifyArtifactManifest,
} from "../benchmark/shared/artifact-manifest";

describe("benchmark artifact manifest", () => {
  it("canonicalizes object keys while preserving array order", () => {
    expect(canonicalArtifactJson({ z: 1, a: { y: 2, x: [3, 1] } })).toBe(
      '{"a":{"x":[3,1],"y":2},"z":1}',
    );
  });

  it("signs a complete artifact and detects raw sample mutation", () => {
    const artifact = attachArtifactManifest(
      { workload: { runId: "run-1" }, measurements: { values: [10, 11, 12] } },
      { pid: 123, processStartedAt: "2026-07-12T00:00:00.000Z" },
    );
    expect(verifyArtifactManifest(artifact)).toBe(true);
    artifact.measurements.values[0] = 1;
    expect(verifyArtifactManifest(artifact)).toBe(false);
  });

  it("rejects missing and malformed process identity", () => {
    expect(verifyArtifactManifest({ measurements: { values: [1] } })).toBe(false);
    expect(() =>
      attachArtifactManifest(
        { measurements: { values: [1] } },
        { pid: 0, processStartedAt: "not-a-date" },
      ),
    ).toThrow("process identity");
  });
});
