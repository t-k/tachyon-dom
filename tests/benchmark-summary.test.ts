import { describe, expect, it } from "vitest";
import { rankMetric } from "../benchmark/summary/ranking";

describe("benchmark Summary ranking", () => {
  it("小さい値を優位として競技順位と最速比を計算する", () => {
    expect(
      rankMetric(
        [
          { name: "slow", value: 20 },
          { name: "fast-a", value: 10 },
          { name: "fast-b", value: 10 },
          { name: "middle", value: 15 },
        ],
        "lower",
      ),
    ).toEqual([
      { name: "fast-a", value: 10, rank: 1, ratioToBest: 1 },
      { name: "fast-b", value: 10, rank: 1, ratioToBest: 1 },
      { name: "middle", value: 15, rank: 3, ratioToBest: 1.5 },
      { name: "slow", value: 20, rank: 4, ratioToBest: 2 },
    ]);
  });

  it("大きい値を優位として最速比を1以上に正規化する", () => {
    expect(
      rankMetric(
        [
          { name: "a", value: 200 },
          { name: "b", value: 100 },
        ],
        "higher",
      ),
    ).toEqual([
      { name: "a", value: 200, rank: 1, ratioToBest: 1 },
      { name: "b", value: 100, rank: 2, ratioToBest: 2 },
    ]);
  });

  it("空、非有限値、負値、ゼロ値を拒否する", () => {
    expect(() => rankMetric([], "lower")).toThrow("at least one metric value");
    expect(() => rankMetric([{ name: "a", value: Number.NaN }], "lower")).toThrow("finite");
    expect(() => rankMetric([{ name: "a", value: -1 }], "lower")).toThrow("non-negative");
    expect(() => rankMetric([{ name: "a", value: 0 }], "higher")).toThrow("positive");
    expect(() => rankMetric([{ name: "a", value: 0 }], "lower")).toThrow("positive");
  });
});
