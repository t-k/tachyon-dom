import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { propertyParameters, resolveFastCheckParameters } from "./fast-check-config";

describe("fast-check run configuration", () => {
  it("uses stable defaults", () => {
    expect(resolveFastCheckParameters({})).toEqual({ seed: 0x7a11c0de, numRuns: 100 });
  });

  it("uses property defaults when environment overrides are absent", () => {
    expect(resolveFastCheckParameters({}, { seed: 123, numRuns: 256 })).toEqual({ seed: 123, numRuns: 256 });
  });

  it("applies seed, path, and run-count overrides", () => {
    expect(
      resolveFastCheckParameters(
        { FAST_CHECK_SEED: "-42", FAST_CHECK_PATH: "1:0:2", FAST_CHECK_NUM_RUNS: "512" },
        { seed: 123, numRuns: 256 },
      ),
    ).toEqual({ seed: -42, path: "1:0:2", numRuns: 512 });
  });

  it("treats an empty replay path as absent", () => {
    expect(resolveFastCheckParameters({ FAST_CHECK_PATH: "" })).toEqual({ seed: 0x7a11c0de, numRuns: 100 });
  });

  it.each([
    ["FAST_CHECK_SEED", { FAST_CHECK_SEED: "1.5" }, "a safe integer"],
    ["FAST_CHECK_SEED", { FAST_CHECK_SEED: "NaN" }, "a safe integer"],
    ["FAST_CHECK_NUM_RUNS", { FAST_CHECK_NUM_RUNS: "0" }, "a positive safe integer"],
    ["FAST_CHECK_NUM_RUNS", { FAST_CHECK_NUM_RUNS: "2.5" }, "a positive safe integer"],
  ] as const)("rejects invalid %s", (name, environment, requirement) => {
    expect(() => resolveFastCheckParameters(environment)).toThrow(`${name} must be ${requirement}.`);
  });

  it("matches the globally configured parameters", () => {
    expect(fc.readConfigureGlobal()).toMatchObject(propertyParameters());
  });
});
