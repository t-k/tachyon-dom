import { rankMetric, type MetricDirection, type RankedMetric } from "./ranking";

type RecordValue = Record<string, unknown>;

type Provenance = {
  commit: string;
  node: string;
  platform: string;
  cpu: string;
};

type WebMetric = {
  framework: string;
  staticRequestsPerSecond: number;
  staticLatencyP95Ms: number;
  dynamicRequestsPerSecond: number;
  dynamicLatencyP95Ms: number;
  streamTtfbMs: number;
  streamCompleteMs: number;
  clientNavigationMs: number;
  clientBundleBytes: number;
};

type WebResult = {
  provenance: Provenance;
  metrics: WebMetric[];
  ranking: { framework: string; rank: number; score: number }[];
};

type LocalSummary = {
  id: string;
  label: string;
  implementation: string;
  trimmedMean: number;
};

type AuxiliarySummary = {
  id: string;
  label: string;
  implementation: string;
  unit: "ms" | "mb" | "count" | "kib";
  value: number;
};

type LocalResult = {
  provenance: Provenance;
  implementations: string[];
  summaries: LocalSummary[];
  auxiliaryMetrics: AuxiliarySummary[];
};

export type SummaryInput =
  | { suite: "web-framework"; webFramework: unknown }
  | { suite: "js-framework"; localCompare: unknown }
  | { suite: "all"; webFramework: unknown; localCompare: unknown };

const isRecord = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requiredRecord = (value: unknown, message: string): RecordValue => {
  if (!isRecord(value)) throw new Error(message);
  return value;
};

const requiredString = (value: unknown, message: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new Error(message);
  return value;
};

const requiredNumber = (value: unknown, message: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(message);
  return value;
};

const parseProvenance = (value: unknown, message: string): Provenance => {
  const provenance = requiredRecord(value, message);
  const git = requiredRecord(provenance.git, message);
  const runtime = requiredRecord(provenance.runtime, message);
  const host = requiredRecord(provenance.host, message);
  return {
    commit: requiredString(git.commit, message),
    node: requiredString(runtime.node, message),
    platform: requiredString(runtime.platform ?? host.platform, message),
    cpu: requiredString(host.cpuModel ?? host.cpu, message),
  };
};

const webMetricFields = [
  "staticRequestsPerSecond",
  "staticLatencyP95Ms",
  "dynamicRequestsPerSecond",
  "dynamicLatencyP95Ms",
  "streamTtfbMs",
  "streamCompleteMs",
  "clientNavigationMs",
  "clientBundleBytes",
] as const;

const parseWebFrameworkResult = (value: unknown): WebResult => {
  const message = "Invalid web-framework benchmark result.";
  const root = requiredRecord(value, message);
  const benchmark = requiredRecord(root.benchmark, message);
  if (benchmark.name !== "web-framework") throw new Error(message);
  const measurements = requiredRecord(root.measurements, message);
  if (!Array.isArray(measurements.metrics) || measurements.metrics.length === 0) throw new Error(message);
  if (!Array.isArray(measurements.ranking) || measurements.ranking.length !== measurements.metrics.length) {
    throw new Error(message);
  }
  const metrics = measurements.metrics.map((item): WebMetric => {
    const metric = requiredRecord(item, message);
    return {
      framework: requiredString(metric.framework, message),
      ...Object.fromEntries(webMetricFields.map((field) => [field, requiredNumber(metric[field], message)])),
    } as WebMetric;
  });
  const ranking = measurements.ranking.map((item) => {
    const row = requiredRecord(item, message);
    return {
      framework: requiredString(row.framework, message),
      rank: requiredNumber(row.rank, message),
      score: requiredNumber(row.score, message),
    };
  });
  if (new Set(metrics.map((metric) => metric.framework)).size !== metrics.length) throw new Error(message);
  if (ranking.some((row) => !metrics.some((metric) => metric.framework === row.framework))) throw new Error(message);
  return { provenance: parseProvenance(root.provenance, message), metrics, ranking };
};

const auxiliaryUnits = new Set(["ms", "mb", "count", "kib"]);

const parseLocalCompareResult = (value: unknown): LocalResult => {
  const message = "Invalid local-compare benchmark result.";
  const root = requiredRecord(value, message);
  const benchmark = requiredRecord(root.benchmark, message);
  if (benchmark.name !== "local-compare") throw new Error(message);
  const workload = requiredRecord(root.workload, message);
  const measurements = requiredRecord(root.measurements, message);
  if (!Array.isArray(workload.implementations) || workload.implementations.length === 0) throw new Error(message);
  const implementations = workload.implementations.map((item) => requiredString(item, message));
  if (new Set(implementations).size !== implementations.length) throw new Error(message);
  if (!Array.isArray(measurements.summaries) || !Array.isArray(measurements.auxiliaryMetrics)) throw new Error(message);
  const summaries = measurements.summaries.map((item): LocalSummary => {
    const row = requiredRecord(item, message);
    return {
      id: requiredString(row.id, message),
      label: requiredString(row.label, message),
      implementation: requiredString(row.implementation, message),
      trimmedMean: requiredNumber(row.trimmedMean, message),
    };
  });
  const auxiliaryMetrics = measurements.auxiliaryMetrics.map((item): AuxiliarySummary => {
    const row = requiredRecord(item, message);
    const unit = requiredString(row.unit, message);
    if (!auxiliaryUnits.has(unit)) throw new Error(message);
    return {
      id: requiredString(row.id, message),
      label: requiredString(row.label, message),
      implementation: requiredString(row.implementation, message),
      unit: unit as AuxiliarySummary["unit"],
      value: requiredNumber(row.value, message),
    };
  });
  const scenarioIds = [...new Set(summaries.map((row) => row.id))];
  const auxiliaryIds = [...new Set(auxiliaryMetrics.map((row) => row.id))];
  if (
    scenarioIds.length === 0 ||
    implementations.some((implementation) =>
      scenarioIds.some(
        (id) => summaries.filter((row) => row.implementation === implementation && row.id === id).length !== 1,
      ),
    ) ||
    implementations.some((implementation) =>
      auxiliaryIds.some(
        (id) => auxiliaryMetrics.filter((row) => row.implementation === implementation && row.id === id).length !== 1,
      ),
    )
  ) {
    throw new Error(message);
  }
  return { provenance: parseProvenance(root.provenance, message), implementations, summaries, auxiliaryMetrics };
};

export const escapeMarkdownCell = (value: string): string =>
  value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replaceAll("|", "\\|")
    .trim();

const formatEnvironment = (provenance: Provenance): string =>
  [
    `- Commit: \`${escapeMarkdownCell(provenance.commit)}\``,
    `- Runtime: Node ${escapeMarkdownCell(provenance.node)}`,
    `- Host: ${escapeMarkdownCell(provenance.platform)} / ${escapeMarkdownCell(provenance.cpu)}`,
  ].join("\n");

const formatRankedTable = (rows: readonly RankedMetric[], formatValue: (value: number) => string): string => {
  const lines = ["| 順位 | 対象 | 実測値 | 最速比 |", "|---:|---|---:|---:|"];
  for (const row of rows) {
    lines.push(
      `| ${row.rank} | ${escapeMarkdownCell(row.name)} | ${formatValue(row.value)} | ${row.ratioToBest.toFixed(3)}x |`,
    );
  }
  return lines.join("\n");
};

const webDefinitions: readonly {
  key: keyof Omit<WebMetric, "framework">;
  label: string;
  direction: MetricDirection;
  format: (value: number) => string;
}[] = [
  {
    key: "staticRequestsPerSecond",
    label: "静的リクエスト数/秒",
    direction: "higher",
    format: (value) => `${value.toFixed(0)} req/s`,
  },
  {
    key: "staticLatencyP95Ms",
    label: "静的p95レイテンシ",
    direction: "lower",
    format: (value) => `${value.toFixed(2)} ms`,
  },
  {
    key: "dynamicRequestsPerSecond",
    label: "動的リクエスト数/秒",
    direction: "higher",
    format: (value) => `${value.toFixed(0)} req/s`,
  },
  {
    key: "dynamicLatencyP95Ms",
    label: "動的p95レイテンシ",
    direction: "lower",
    format: (value) => `${value.toFixed(2)} ms`,
  },
  { key: "streamTtfbMs", label: "ストリーミングTTFB", direction: "lower", format: (value) => `${value.toFixed(2)} ms` },
  {
    key: "streamCompleteMs",
    label: "ストリーミング完了時間",
    direction: "lower",
    format: (value) => `${value.toFixed(2)} ms`,
  },
  {
    key: "clientNavigationMs",
    label: "クライアント遷移時間",
    direction: "lower",
    format: (value) => `${value.toFixed(2)} ms`,
  },
  {
    key: "clientBundleBytes",
    label: "クライアントバンドルサイズ",
    direction: "lower",
    format: (value) => `${(value / 1024).toFixed(2)} KiB`,
  },
];

const formatWebFrameworkSummary = (result: WebResult): string => {
  const overall = [
    "## Web Framework総合ランキング",
    "",
    "| 順位 | Framework | Score |",
    "|---:|---|---:|",
    ...result.ranking.map((row) => `| ${row.rank} | ${escapeMarkdownCell(row.framework)} | ${row.score.toFixed(3)}x |`),
  ].join("\n");
  const metrics = webDefinitions.map((definition) => {
    const ranked = rankMetric(
      result.metrics.map((metric) => ({ name: metric.framework, value: metric[definition.key] })),
      definition.direction,
    );
    return `### ${definition.label}\n\n${formatRankedTable(ranked, definition.format)}`;
  });
  return `${formatEnvironment(result.provenance)}\n\n${overall}\n\n## Web Framework項目別ランキング\n\n${metrics.join("\n\n")}`;
};

const geomean = (values: readonly number[]): number =>
  Math.exp(values.reduce((total, value) => total + Math.log(value), 0) / values.length);

const formatAuxiliaryValue = (unit: AuxiliarySummary["unit"]): ((value: number) => string) => {
  if (unit === "ms") return (value) => `${value.toFixed(2)} ms`;
  if (unit === "mb") return (value) => `${value.toFixed(2)} MiB`;
  if (unit === "kib") return (value) => `${value.toFixed(2)} KiB`;
  return (value) => value.toFixed(0);
};

const formatLocalCompareSummary = (result: LocalResult): string => {
  const scenarios = [...new Map(result.summaries.map((row) => [row.id, { id: row.id, label: row.label }])).values()];
  const overallValues = result.implementations.map((implementation) => ({
    name: implementation,
    value: geomean(
      scenarios.map((scenario) => {
        const values = result.summaries.filter((row) => row.id === scenario.id);
        const best = Math.min(...values.map((row) => row.trimmedMean));
        return (values.find((row) => row.implementation === implementation)?.trimmedMean as number) / best;
      }),
    ),
  }));
  const overall = formatRankedTable(rankMetric(overallValues, "lower"), (value) => `${value.toFixed(3)}x`);
  const operationTables = scenarios.map((scenario) => {
    const rows = result.summaries.filter((row) => row.id === scenario.id);
    return `### ${escapeMarkdownCell(scenario.label)}\n\n${formatRankedTable(
      rankMetric(
        rows.map((row) => ({ name: row.implementation, value: row.trimmedMean })),
        "lower",
      ),
      (value) => `${value.toFixed(2)} ms`,
    )}`;
  });
  const auxiliaryDefinitions = [...new Map(result.auxiliaryMetrics.map((row) => [row.id, row])).values()];
  const auxiliaryTables = auxiliaryDefinitions.map((definition) => {
    const rows = result.auxiliaryMetrics.filter((row) => row.id === definition.id);
    return `### ${escapeMarkdownCell(definition.label)}\n\n${formatRankedTable(
      rankMetric(
        rows.map((row) => ({ name: row.implementation, value: row.value })),
        "lower",
      ),
      formatAuxiliaryValue(definition.unit),
    )}`;
  });
  return `${formatEnvironment(result.provenance)}\n\n> js-framework-benchmarkの操作モデルに沿ったtachyon-domリポジトリ内の比較です。上流公式ランナーの結果ではありません。\n\n## js-framework-benchmark準拠比較 総合ランキング\n\n${overall}\n\n## 操作別ランキング\n\n${operationTables.join("\n\n")}\n\n## 補助指標ランキング\n\n${auxiliaryTables.join("\n\n")}`;
};

export const formatBenchmarkSummary = (input: SummaryInput): string => {
  const sections = [
    "# Benchmark Results",
    `- Suite: \`${input.suite}\``,
    "> この結果は単一Dispatch内の参考ランキングであり、権威的ランキングではありません。",
  ];
  if (input.suite === "web-framework" || input.suite === "all") {
    sections.push(formatWebFrameworkSummary(parseWebFrameworkResult(input.webFramework)));
  }
  if (input.suite === "js-framework" || input.suite === "all") {
    sections.push(formatLocalCompareSummary(parseLocalCompareResult(input.localCompare)));
  }
  return `${sections.join("\n\n")}\n`;
};
