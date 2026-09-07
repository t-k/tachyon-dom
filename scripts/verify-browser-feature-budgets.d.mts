import type { FeatureReport } from "./browser-feature-report.d.mts";

export type FeatureBudget = { maxMinifiedBytes: number; maxBrotliBytes: number };

export const budgetsPath: string;
export const baselinePath: string;
export const defaultArtifactRoot: string;
export function createFeatureFixtures(): Record<string, string>;
export function runBrowserFeatureBudgets(options?: {
  cwd?: string;
  artifactRoot?: string;
  budgets?: Record<string, FeatureBudget>;
  features?: Record<string, string>;
  log?: (message: string) => void;
}): Promise<{ report: FeatureReport & { validation: { ok: boolean; error?: string } }; json: string; artifactPath: string }>;
