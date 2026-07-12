import {
  analyzeRatios,
  median,
  validateCompletePositionCycles,
  type RatioAnalysis,
} from "../shared/statistical-authority.js";
import { createWebRunPlan } from "./workload.js";
import { verifyArtifactManifest } from "../shared/artifact-manifest.js";

export type WebFrameworkMetric = {
  framework: string;
  staticRequestsPerSecond: number;
  staticLatencyP95Ms: number;
  dynamicRequestsPerSecond: number;
  dynamicLatencyP95Ms: number;
  streamTtfbMs: number;
  streamCompleteMs: number;
  streamWarmups: number;
  streamSamples: readonly {
    ttfb: number;
    complete: number;
    chunkArrivalMs: readonly number[];
  }[];
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

type WebStreamRun = {
  benchmark: { contractVersion: number };
  provenance: {
    git: { commit: string; dirty: boolean; workingTreeSha256: string };
    runtime: unknown;
    host: unknown;
    browser: unknown;
    dependencies: unknown;
  };
  workload: {
    runId: string;
    runIndex: number;
    seed: number;
    frameworkOrder: readonly string[];
    smoke: boolean;
    buildMode: string;
    durationSeconds: number;
    connections: number;
    streamMinimumChunkGapMs: number;
    frameworks: unknown;
  };
  measurements: {
    metrics: readonly Pick<
      WebFrameworkMetric,
      "framework" | "streamCompleteMs" | "streamWarmups" | "streamSamples"
    >[];
  };
};

export type WebStreamAuthority =
  | { ok: true; ratios: number[]; analysis: RatioAnalysis }
  | { ok: false; reasons: string[] };

export const analyzeWebStreamRuns = (
  runs: readonly WebStreamRun[],
  options: { seed: number; resamples: number },
): WebStreamAuthority => {
  const reasons: string[] = [];
  if (runs.length < 7) reasons.push("at least seven fresh-process runs are required");
  if (new Set(runs.map((run) => run.workload.runId)).size !== runs.length) reasons.push("run IDs must be unique");
  if (new Set(runs.map((run) => run.workload.runIndex)).size !== runs.length) reasons.push("run indexes must be unique");
  if (new Set(runs.map((run) => run.workload.seed)).size !== 1) reasons.push("authority seed must be identical");
  const processIdentities = runs.map((run, index) => {
    if (!verifyArtifactManifest(run)) reasons.push(`${run.workload.runId}: invalid artifact manifest`);
    const manifest = (run as unknown as { manifest?: { pid?: unknown; processStartedAt?: unknown } }).manifest;
    if (!Number.isInteger(manifest?.pid) || typeof manifest?.processStartedAt !== "string") {
      reasons.push(`${run.workload.runId}: invalid process identity`);
      return `invalid-${index}`;
    }
    return `${manifest.pid}:${manifest.processStartedAt}`;
  });
  if (new Set(processIdentities).size !== processIdentities.length) reasons.push("process identities must be unique");
  const compatibilityFor = (run: WebStreamRun): string =>
    JSON.stringify({
      git: {
        commit: run.provenance.git.commit,
        workingTreeSha256: run.provenance.git.workingTreeSha256,
      },
      runtime: run.provenance.runtime,
      host: run.provenance.host,
      browser: run.provenance.browser,
      dependencies: run.provenance.dependencies,
      workload: {
        smoke: run.workload.smoke,
        buildMode: run.workload.buildMode,
        durationSeconds: run.workload.durationSeconds,
        connections: run.workload.connections,
        streamMinimumChunkGapMs: run.workload.streamMinimumChunkGapMs,
        frameworks: run.workload.frameworks,
      },
    });
  const expectedCompatibility = runs[0] ? compatibilityFor(runs[0]) : "";
  for (const run of runs) {
    if (run.benchmark.contractVersion !== 5) reasons.push(`${run.workload.runId}: contract version`);
    if (run.provenance.git.dirty) reasons.push(`${run.workload.runId}: dirty tree`);
    if (compatibilityFor(run) !== expectedCompatibility) reasons.push(`${run.workload.runId}: incompatible controls`);
    for (const metric of run.measurements.metrics) {
      if (metric.streamWarmups < 5) reasons.push(`${run.workload.runId}: ${metric.framework} warmups`);
      if (metric.streamSamples.length < 20) reasons.push(`${run.workload.runId}: ${metric.framework} samples`);
      if (!Number.isFinite(metric.streamCompleteMs) || metric.streamCompleteMs <= 0) {
        reasons.push(`${run.workload.runId}: ${metric.framework} stream complete`);
      }
      for (const sample of metric.streamSamples) {
        const arrivals = sample.chunkArrivalMs;
        const chronological = arrivals.every((arrival, index) => index === 0 || arrival >= (arrivals[index - 1] ?? 0));
        const gap = (arrivals.at(-1) ?? 0) - (arrivals[0] ?? 0);
        if (
          !Number.isFinite(sample.ttfb) ||
          !Number.isFinite(sample.complete) ||
          sample.ttfb < 0 ||
          sample.complete < sample.ttfb ||
          arrivals.length < 2 ||
          !arrivals.every((arrival) => Number.isFinite(arrival) && arrival >= 0) ||
          !chronological ||
          gap < run.workload.streamMinimumChunkGapMs
        ) {
          reasons.push(`${run.workload.runId}: ${metric.framework} invalid stream sample`);
          break;
        }
      }
      if (
        metric.streamSamples.length > 0 &&
        Math.abs(metric.streamCompleteMs - median(metric.streamSamples.map((sample) => sample.complete))) > 1e-9
      ) {
        reasons.push(`${run.workload.runId}: ${metric.framework} stream summary mismatch`);
      }
    }
  }
  const frameworks = runs[0]?.workload.frameworkOrder ?? [];
  if (!validateCompletePositionCycles(runs.map((run) => run.workload.frameworkOrder), frameworks)) {
    reasons.push("framework orders must contain complete position cycles");
  }
  for (const run of runs) {
    const expected = createWebRunPlan(frameworks, {
      runId: run.workload.runId,
      runIndex: run.workload.runIndex,
      seed: run.workload.seed,
    }).frameworkOrder;
    if (JSON.stringify(run.workload.frameworkOrder) !== JSON.stringify(expected)) {
      reasons.push(`${run.workload.runId}: framework order does not match seed and run index`);
    }
  }
  if (reasons.length > 0) return { ok: false, reasons: [...new Set(reasons)] };
  const ratios = runs.map((run) => {
    const candidate = run.measurements.metrics.find((metric) => metric.framework === "tachyon-dom");
    const best = Math.min(
      ...run.measurements.metrics
        .filter((metric) => metric.framework !== "tachyon-dom")
        .map((metric) => median(metric.streamSamples.map((sample) => sample.complete))),
    );
    if (!candidate || !Number.isFinite(best)) throw new Error("Every run requires Tachyon and a comparison framework");
    return median(candidate.streamSamples.map((sample) => sample.complete)) / best;
  });
  return { ok: true, ratios, analysis: analyzeRatios(ratios, options) };
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
