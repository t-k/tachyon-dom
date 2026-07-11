import { describe, expect, it } from "vitest";
import { analyzeRatios, balancedOrder } from "../benchmark/shared/statistical-authority";
import { createLocalRunPlan } from "../benchmark/local-compare/run-plan";
import { createWebRunPlan } from "../benchmark/web-framework/workload";

describe("benchmark statistical authority", () => {
  it("classifies a stable one-percent-or-better win as meaningful", () => {
    expect(analyzeRatios([0.98, 0.98, 0.98, 0.98, 0.98], { seed: 7, resamples: 10_000 })).toEqual({
      status: "meaningful-win",
      medianRatio: 0.98,
      oneSided95UpperBound: 0.98,
      independentRunCount: 5,
    });
  });

  it("keeps a noisy apparent win inconclusive", () => {
    expect(analyzeRatios([0.8, 1.2, 0.82, 1.18, 0.9], { seed: 7, resamples: 10_000 }).status).toBe(
      "inconclusive",
    );
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
    expect(() => analyzeRatios([0.9, 0.9, 0.9, 0.9, 0.9], { seed: 7, resamples: 0 })).toThrow(
      "positive integer",
    );
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

  it("creates reproducible local implementation and scenario orders", () => {
    const implementations = ["a", "b", "c"];
    const scenarios = ["one", "two", "three"];
    expect(createLocalRunPlan(implementations, scenarios, { runId: "run-2", runIndex: 2, seed: 9 })).toEqual(
      createLocalRunPlan(implementations, scenarios, { runId: "run-2", runIndex: 2, seed: 9 }),
    );
    expect(
      new Set(
        [0, 1, 2].map(
          (runIndex) => createLocalRunPlan(implementations, scenarios, { runId: `run-${runIndex}`, runIndex, seed: 9 }).implementationOrder[0],
        ),
      ),
    ).toEqual(new Set(implementations));
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
