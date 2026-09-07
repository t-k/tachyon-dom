export type FeatureReport = {
  schemaVersion: number;
  provenance: {
    commit: string;
    dirty: boolean;
    node: string;
    esbuild: string;
    minify: boolean;
    define: { __TACHYON_PRODUCTION__: string };
    compression: string;
  };
  fixtures: Array<{ name: string; inputHash: string; minifiedBytes: number; brotliBytes: number }>;
};
export const featureNames: readonly string[];
export function validateFeatureReport(report: unknown): FeatureReport;
export function renderFeatureTable(report: FeatureReport): string;
export function updateFeatureDocumentation(source: string, report: FeatureReport): string;
export function checkFeatureMeasurements(baseline: FeatureReport, current: FeatureReport): void;
export function reproducibilityConditions(report: FeatureReport): {
  nodeMajor: string;
  esbuild: string;
  minify: boolean;
  define: { __TACHYON_PRODUCTION__: string };
  compression: string;
};
