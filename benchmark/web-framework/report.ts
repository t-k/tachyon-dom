export type WebFrameworkMetric = {
  framework: string;
  staticRequestsPerSecond: number;
  staticLatencyP95Ms: number;
  dynamicRequestsPerSecond: number;
  dynamicLatencyP95Ms: number;
  streamTtfbMs: number;
  streamCompleteMs: number;
  clientNavigationMs: number;
  clientBundleBytes: number;
  routeStreamEvidence?: {
    cancellationObserved: boolean;
    completedStreams: number;
    emittedChunks: number;
    startingRssBytes: number;
    peakRssBytes: number;
    peakRssDeltaBytes: number;
    peakRssDeltaLimitBytes: number;
    streamTtfbMs: number;
    streamTtfbLimitMs: number;
  };
};

export type WebFrameworkRankingRow = WebFrameworkMetric & {
  score: number;
  rank: number;
};

const finitePositive = (value: number): boolean => Number.isFinite(value) && value > 0;

const finiteNonNegative = (value: number): boolean => Number.isFinite(value) && value >= 0;

const minPositive = (values: readonly number[]): number => Math.min(...values.filter(finitePositive));

const minNonNegative = (values: readonly number[]): number => Math.min(...values.filter(finiteNonNegative));

const maxPositive = (values: readonly number[]): number => Math.max(...values.filter(finitePositive));

const geomean = (values: readonly number[]): number =>
  Math.exp(values.reduce((total, value) => total + Math.log(value), 0) / values.length);

export const scoreWebFrameworkMetrics = (metrics: readonly WebFrameworkMetric[]): WebFrameworkRankingRow[] => {
  const bestStaticRps = maxPositive(metrics.map((metric) => metric.staticRequestsPerSecond));
  const bestDynamicRps = maxPositive(metrics.map((metric) => metric.dynamicRequestsPerSecond));
  const bestStaticP95 = minPositive(metrics.map((metric) => metric.staticLatencyP95Ms));
  const bestDynamicP95 = minPositive(metrics.map((metric) => metric.dynamicLatencyP95Ms));
  const bestTtfb = minPositive(metrics.map((metric) => metric.streamTtfbMs));
  const bestStreamComplete = minPositive(metrics.map((metric) => metric.streamCompleteMs));
  const bestNavigation = minPositive(metrics.map((metric) => metric.clientNavigationMs));
  const bestClientBundle = minNonNegative(metrics.map((metric) => metric.clientBundleBytes));

  return metrics
    .map((metric) => {
      const clientBundleRatio =
        bestClientBundle === 0 ? metric.clientBundleBytes + 1 : metric.clientBundleBytes / bestClientBundle;
      const score = geomean([
        bestStaticRps / metric.staticRequestsPerSecond,
        bestDynamicRps / metric.dynamicRequestsPerSecond,
        metric.staticLatencyP95Ms / bestStaticP95,
        metric.dynamicLatencyP95Ms / bestDynamicP95,
        metric.streamTtfbMs / bestTtfb,
        metric.streamCompleteMs / bestStreamComplete,
        metric.clientNavigationMs / bestNavigation,
        clientBundleRatio,
      ]);
      return { ...metric, score, rank: 0 };
    })
    .sort((a, b) => a.score - b.score)
    .map((row, index) => ({ ...row, rank: index + 1 }));
};

const formatNumber = (value: number, digits = 1): string => value.toFixed(digits);

const formatMilliseconds = (value: number): string => `${value < 1 ? value.toFixed(2) : value.toFixed(1)}ms`;

const formatBytes = (value: number): string => {
  if (value < 1024) {
    return `${value.toFixed(0)}B`;
  }
  const kib = value / 1024;
  return `${kib < 100 ? kib.toFixed(1) : kib.toFixed(0)}KiB`;
};

export const formatWebFrameworkRanking = (rows: readonly WebFrameworkRankingRow[]): string => {
  const lines = [
    "| Rank | Framework | Score | Static req/s | Static p95 | Dynamic req/s | Dynamic p95 | Stream TTFB | Stream done | Client nav | Client bundle |",
    "|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.rank} | ${row.framework} | ${row.score.toFixed(3)}x | ${formatNumber(row.staticRequestsPerSecond, 0)} | ${formatMilliseconds(row.staticLatencyP95Ms)} | ${formatNumber(row.dynamicRequestsPerSecond, 0)} | ${formatMilliseconds(row.dynamicLatencyP95Ms)} | ${formatMilliseconds(row.streamTtfbMs)} | ${formatMilliseconds(row.streamCompleteMs)} | ${formatMilliseconds(row.clientNavigationMs)} | ${formatBytes(row.clientBundleBytes)} |`,
    );
  }
  return lines.join("\n");
};
