import { describe, expect, it } from "vitest";
import {
  TEMPLATE_REPRESENTATIVE_OPERATIONS,
  TEMPLATE_REPRESENTATIVE_PATHS,
  runRepresentativeBenchmark,
} from "../benchmark/template-representative";

describe("representative template benchmark", () => {
  it("compares equivalent DOM results and preserves raw measurement samples", async () => {
    const result = await runRepresentativeBenchmark({ iterations: 2, warmup: 0, itemCount: 8, appendCount: 3 });

    expect(result.workload.paths).toEqual(TEMPLATE_REPRESENTATIVE_PATHS);
    expect(result.workload.operations).toEqual(TEMPLATE_REPRESENTATIVE_OPERATIONS);
    for (const pathName of TEMPLATE_REPRESENTATIVE_PATHS) {
      expect(result.measurements.paths[pathName].samples).toHaveLength(2);
      expect(result.measurements.paths[pathName].samples[0]).toMatchObject({
        operationDurationsMs: expect.any(Object),
        operationDomHashes: expect.any(Object),
      });
      expect(result.measurements.paths[pathName].samples.every((sample) => sample.allocationBytes >= 0)).toBe(true);
    }
    expect(Object.values(result.measurements.domOracle)).toHaveLength(6);
  });
});
