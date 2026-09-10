import { describe, expect, it } from "vitest";
import {
  analyzeRatios,
  balancedOrder,
  median,
  trimmedMean,
  validateCompletePositionCycles,
} from "../benchmark/shared/statistical-authority";
import {
  createLocalRunPlan,
  LOCAL_COMPARE_CONTRACT_VERSION,
  LOCAL_COMPARE_ENVELOPE_SCHEMA_VERSION,
} from "../benchmark/local-compare/run-plan";
import { createWebRunPlan } from "../benchmark/web-framework/workload";

describe("benchmark statistical authority", () => {
  it("derives deterministic statistics from raw samples", () => {
    expect(median([40, 20, 30])).toBe(30);
    expect(median([10, 2, 4, 8])).toBe(6);
    expect(trimmedMean([10, 10, 11, 12, 200], 0.2)).toBe(11);
  });

  it("rejects invalid raw statistic inputs", () => {
    expect(() => median([])).toThrow("non-empty");
    expect(() => median([1, Number.NaN])).toThrow("finite");
    expect(() => trimmedMean([1, 2], 0.5)).toThrow("trim fraction");
  });

  it("keeps the shared envelope schema separate from the local benchmark contract", () => {
    expect(LOCAL_COMPARE_ENVELOPE_SCHEMA_VERSION).toBe(2);
    expect(LOCAL_COMPARE_CONTRACT_VERSION).toBe(4);
  });

  it("classifies a stable one-percent-or-better win as meaningful", () => {
    expect(analyzeRatios([0.98, 0.98, 0.98, 0.98, 0.98], { seed: 7, resamples: 10_000 })).toEqual({
      status: "meaningful-win",
      medianRatio: 0.98,
      oneSided95UpperBound: 0.98,
      independentRunCount: 5,
    });
  });

  it("keeps a noisy apparent win inconclusive", () => {
    expect(analyzeRatios([0.8, 1.2, 0.82, 1.18, 0.9], { seed: 7, resamples: 10_000 }).status).toBe("inconclusive");
  });

  it("treats fewer than five independent runs as inconclusive", () => {
    expect(analyzeRatios([0.8, 0.8, 0.8, 0.8], { seed: 7, resamples: 100 })).toMatchObject({
      status: "inconclusive",
      independentRunCount: 4,
    });
  });

  it("rejects invalid ratios and resample counts", () => {
    expect(() => analyzeRatios([0.9, 0.9, 0.9, 0.9, Number.NaN], { seed: 7, resamples: 100 })).toThrow(
      "finite positive",
    );
    expect(() => analyzeRatios([0.9, 0.9, 0.9, 0.9, 0.9], { seed: 7, resamples: 0 })).toThrow("positive integer");
  });

  it("reproduces balanced order from the same seed", () => {
    expect(balancedOrder(["a", "b", "c"], 4, 9)).toEqual(balancedOrder(["a", "b", "c"], 4, 9));
    expect(new Set([0, 1, 2].map((run) => balancedOrder(["a", "b", "c"], run, 9)[0]))).toEqual(
      new Set(["a", "b", "c"]),
    );
  });

  it("does not mutate the input order", () => {
    const input = ["a", "b", "c"];
    balancedOrder(input, 1, 9);
    expect(input).toEqual(["a", "b", "c"]);
  });

  it("accepts only complete position cycles", () => {
    const items = ["a", "b", "c"];
    const complete = items.map((_, runIndex) => balancedOrder(items, runIndex, 9));
    expect(validateCompletePositionCycles(complete, items)).toBe(true);
    expect(validateCompletePositionCycles(complete.slice(0, 2), items)).toBe(false);
    expect(validateCompletePositionCycles([...complete, complete[0]!], items)).toBe(false);
    expect(
      validateCompletePositionCycles(
        complete.map(() => [...items]),
        items,
      ),
    ).toBe(false);
  });

  it("creates reproducible local implementation and scenario orders", () => {
    const implementations = ["a", "b", "c"];
    const scenarios = ["one", "two", "three"];
    expect(createLocalRunPlan(implementations, scenarios, { runId: "run-2", runIndex: 2, seed: 9 })).toEqual(
      createLocalRunPlan(implementations, scenarios, { runId: "run-2", runIndex: 2, seed: 9 }),
    );
    expect(
      new Set(
        [0, 1, 2].map(
          (runIndex) =>
            createLocalRunPlan(implementations, scenarios, { runId: `run-${runIndex}`, runIndex, seed: 9 })
              .implementationOrder[0],
        ),
      ),
    ).toEqual(new Set(implementations));
  });

  it("balances nine scenarios across the early and late halves of seven runs", () => {
    const implementations = ["a", "b", "c", "d", "e", "f", "g"];
    const scenarios = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
    const orders = implementations.map(
      (_, runIndex) =>
        createLocalRunPlan(implementations, scenarios, { runId: `run-${runIndex}`, runIndex, seed: 9 }).scenarioOrder,
    );
    for (const scenario of scenarios) {
      const positions = orders.map((order) => order.indexOf(scenario));
      const early = positions.filter((position) => position < 4).length;
      const late = positions.filter((position) => position > 4).length;
      const meanPosition = positions.reduce((total, position) => total + position, 0) / positions.length;
      expect(Math.abs(early - late)).toBeLessThanOrEqual(1);
      expect(Math.abs(meanPosition - 4)).toBeLessThanOrEqual(1);
    }
  });

  it("balances web framework positions across fresh runs", () => {
    const frameworks = ["a", "b", "c"];
    expect(
      new Set(
        [0, 1, 2].map(
          (runIndex) => createWebRunPlan(frameworks, { runId: `run-${runIndex}`, runIndex, seed: 4 }).frameworkOrder[0],
        ),
      ),
    ).toEqual(new Set(frameworks));
  });
});
