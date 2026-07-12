export type ScoredStreamWorkload = {
  delayDependencies: 1;
  delayMs: 20;
  items: 80;
  deferredBoundaries: 1;
};

const scoredStreamWorkload = (): ScoredStreamWorkload => ({
  delayDependencies: 1,
  delayMs: 20,
  items: 80,
  deferredBoundaries: 1,
});

export const SCORED_STREAM_WORKLOADS = {
  "tachyon-dom": scoredStreamWorkload(),
  "next-app-router": scoredStreamWorkload(),
  "solid-start": scoredStreamWorkload(),
  "tanstack-start": scoredStreamWorkload(),
  "marko-run": scoredStreamWorkload(),
  "mreact-app-router": scoredStreamWorkload(),
} as const;

export const createWebRunPlan = (
  frameworks: readonly string[],
  identity: { runId: string; runIndex: number; seed: number },
) => ({ ...identity, frameworkOrder: balancedOrder(frameworks, identity.runIndex, identity.seed) });
import { balancedOrder } from "../shared/statistical-authority.js";
