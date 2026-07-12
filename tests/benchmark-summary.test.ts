import { describe, expect, it } from "vitest";
import { formatBenchmarkSummary } from "../benchmark/summary/markdown";
import { rankMetric } from "../benchmark/summary/ranking";

const metric = (framework: string, factor: number) => ({
  framework,
  staticRequestsPerSecond: 100 / factor,
  staticLatencyP95Ms: 2 * factor,
  dynamicRequestsPerSecond: 80 / factor,
  dynamicLatencyP95Ms: 3 * factor,
  streamTtfbMs: 4 * factor,
  streamCompleteMs: 5 * factor,
  clientNavigationMs: 6 * factor,
  clientBundleBytes: 1_024 * factor,
});

const webFixture = {
  benchmark: { name: "web-framework" },
  provenance: {
    git: { commit: "abc123" },
    runtime: { node: "v24.0.0" },
    host: { platform: "linux", cpu: "Example CPU" },
  },
  measurements: {
    metrics: [metric("fast|framework", 1), metric("slow", 2)],
    ranking: [
      { ...metric("fast|framework", 1), rank: 1, score: 1 },
      { ...metric("slow", 2), rank: 2, score: 2 },
    ],
  },
};

const summary = (id: string, label: string, implementation: string, trimmedMean: number) => ({
  id,
  label,
  implementation,
  trimmedMean,
});

const auxiliary = (id: string, label: string, unit: string, implementation: string, value: number) => ({
  id,
  label,
  unit,
  implementation,
  value,
});

const localFixture = {
  benchmark: { name: "local-compare" },
  provenance: webFixture.provenance,
  workload: { implementations: ["tachyon-dom", "other"] },
  measurements: {
    summaries: [
      summary("createRows", "create rows", "tachyon-dom", 10),
      summary("partialUpdate", "partial update", "tachyon-dom", 20),
      summary("createRows", "create rows", "other", 20),
      summary("partialUpdate", "partial update", "other", 10),
    ],
    auxiliaryMetrics: [
      auxiliary("readyHeap", "ready JS heap", "mb", "tachyon-dom", 4),
      auxiliary("entrySourceSize", "benchmark entry source size", "kib", "tachyon-dom", 8),
      auxiliary("readyHeap", "ready JS heap", "mb", "other", 8),
      auxiliary("entrySourceSize", "benchmark entry source size", "kib", "other", 4),
    ],
  },
};

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

describe("benchmark Summary markdown", () => {
  it("Web Frameworkの総合ランキングと8つの項目別ランキングを表示する", () => {
    const markdown = formatBenchmarkSummary({ suite: "web-framework", webFramework: webFixture });

    expect(markdown).toContain("# Benchmark Results");
    expect(markdown).toContain("参考ランキング");
    expect(markdown).toContain("## Web Framework総合ランキング");
    expect(markdown).toContain("## Web Framework項目別ランキング");
    expect(markdown).toContain("### 静的リクエスト数/秒");
    expect(markdown).toContain("| 1 | fast\\|framework | 100 req/s | 1.000x |");
    expect(markdown).toContain("### 静的p95レイテンシ");
    expect(markdown).toContain("| 1 | fast\\|framework | 2.00 ms | 1.000x |");
    expect(markdown.match(/^### /gm)).toHaveLength(8);
  });

  it("js-framework準拠比較の総合、操作別、補助指標ランキングを表示する", () => {
    const markdown = formatBenchmarkSummary({ suite: "js-framework", localCompare: localFixture });

    expect(markdown).toContain("## js-framework-benchmark準拠比較 総合ランキング");
    expect(markdown).toContain("### create rows");
    expect(markdown).toContain("### partial update");
    expect(markdown).toContain("### ready JS heap");
    expect(markdown).toContain("### benchmark entry source size");
    expect(markdown).toContain("tachyon-domリポジトリ内の比較");
    expect(markdown).toContain("| 1 | tachyon-dom | 10.00 ms | 1.000x |");
  });

  it("不完全な結果を拒否する", () => {
    expect(() => formatBenchmarkSummary({ suite: "web-framework", webFramework: {} })).toThrow(
      "Invalid web-framework benchmark result",
    );
    expect(() => formatBenchmarkSummary({ suite: "js-framework", localCompare: {} })).toThrow(
      "Invalid local-compare benchmark result",
    );
    expect(() => formatBenchmarkSummary({ suite: "all", webFramework: webFixture, localCompare: {} })).toThrow(
      "Invalid local-compare benchmark result",
    );
  });

  it("実行環境とcommitを表示する", () => {
    const markdown = formatBenchmarkSummary({ suite: "web-framework", webFramework: webFixture });

    expect(markdown).toContain("`abc123`");
    expect(markdown).toContain("Node v24.0.0");
    expect(markdown).toContain("linux");
    expect(markdown).toContain("Example CPU");
  });
});
