import { describe, expect, it } from "vitest";
import {
  TEMPLATE_REPRESENTATIVE_CONTRACT_VERSION,
  TEMPLATE_REPRESENTATIVE_INTERACTIVE_OPERATIONS,
  TEMPLATE_REPRESENTATIVE_INTERACTIVE_PATHS,
  TEMPLATE_REPRESENTATIVE_OPERATIONS,
  TEMPLATE_REPRESENTATIVE_PATHS,
  runRepresentativeBenchmark,
} from "../benchmark/template-representative";

describe("representative template benchmark", () => {
  it("compares nested DOM, identity, live input, and real interactions across paths", async () => {
    const result = await runRepresentativeBenchmark({
      iterations: 2,
      warmup: 0,
      itemCount: 8,
      appendCount: 3,
      childCount: 2,
    });

    expect(result.benchmark.contractVersion).toBe(TEMPLATE_REPRESENTATIVE_CONTRACT_VERSION);
    expect(result.workload.paths).toEqual(TEMPLATE_REPRESENTATIVE_PATHS);
    expect(result.workload.operations).toEqual(TEMPLATE_REPRESENTATIVE_OPERATIONS);
    expect(result.workload.interactivePaths).toEqual(TEMPLATE_REPRESENTATIVE_INTERACTIVE_PATHS);
    expect(result.workload.interactiveOutOfScope["text-template"]).toContain("no model or event bindings");
    expect(result.workload.timingScope).toBe("warm-dom-operations-excluding-oracles");
    expect(result.workload.generatedTemplateSources["mixed-template"]).toContain("<for each={row.tags}");

    for (const pathName of TEMPLATE_REPRESENTATIVE_PATHS) {
      const measurement = result.measurements.paths[pathName];
      expect(measurement.samples).toHaveLength(2);
      for (const sample of measurement.samples) {
        expect(Number.isFinite(sample.heapDeltaBytes)).toBe(true);
        expect(sample.allocatedBytes).toBeNull();
        for (const operation of TEMPLATE_REPRESENTATIVE_OPERATIONS) {
          const { liveInputValues, ...rest } = sample.operationOracles[operation];
          const { liveInputValues: expectedInputs, ...expectedRest } = result.measurements.oracle[operation];
          expect(rest).toEqual(expectedRest);
          if (result.workload.liveInputPaths.includes(pathName)) expect(liveInputValues).toEqual(expectedInputs);
        }
      }
    }
    const oracle = result.measurements.oracle;
    // Nested children: every row has two tags initially, reorder keeps child
    // identity, and child-empty clears every fourth row.
    expect(oracle.create.childCounts).toEqual(Array.from({ length: 8 }, () => 2));
    expect(oracle.create.liveInputValues[0]).toBe("Row 0");
    expect(oracle["partial-update"].liveInputValues[0]).toBe("Row 0 !");
    expect(oracle.swap.preservedRowIdentities).toBe(oracle.swap.rowCount);
    expect(oracle.swap.preservedChildIdentities).toBe(oracle.swap.childCounts.reduce((total, count) => total + count, 0));
    expect(oracle["child-reorder"].preservedChildIdentities).toBe(
      oracle["child-reorder"].childCounts.reduce((total, count) => total + count, 0),
    );
    expect(oracle["child-empty"].childCounts.filter((count) => count === 0).length).toBeGreaterThan(0);
    expect(oracle["mount-dispose"].rowCount).toBe(0);

    const interactiveOracle = result.measurements.interactiveOracle;
    for (const pathName of TEMPLATE_REPRESENTATIVE_INTERACTIVE_PATHS) {
      for (const sample of result.measurements.interactive[pathName].samples) {
        expect(sample.operationOracles).toEqual(interactiveOracle);
      }
    }
    expect(interactiveOracle.input.inputValue).toBe("typed");
    expect(interactiveOracle.input.modelLabel).toBe("typed");
    expect(interactiveOracle.click.clickCount).toBe(2);
    expect(interactiveOracle["selected-toggle"].selectedClassStates.filter(Boolean)).toHaveLength(1);
    expect(interactiveOracle["selected-toggle"].selectedClassStates[4]).toBe(true);
    expect(interactiveOracle["selected-toggle"].handlerRunsAfterDispose).toBe(0);
    expect(TEMPLATE_REPRESENTATIVE_INTERACTIVE_OPERATIONS).toEqual(["input", "click", "selected-toggle"]);

    for (const name of ["text-template", "mixed-template"] as const) {
      expect(result.measurements.cold[name].compileMs).toBeGreaterThanOrEqual(0);
      expect(result.measurements.cold[name].importMs).toBeGreaterThanOrEqual(0);
    }
    expect(result.workload.buildMode).toBe("generated-client-source");
    expect(result.workload.memoryMeasurement).toBe("heap-delta-only");
    // Runs the full representative workload with real compilation, so it needs more than the default timeout.
  }, 60_000);
});
