import { balancedOrder } from "../shared/statistical-authority.js";

export type LocalRunPlan = {
  runId: string;
  runIndex: number;
  seed: number;
  implementationOrder: string[];
  scenarioOrder: string[];
};

export const createLocalRunPlan = (
  implementations: readonly string[],
  scenarios: readonly string[],
  identity: { runId: string; runIndex: number; seed: number },
): LocalRunPlan => ({
  ...identity,
  implementationOrder: balancedOrder(implementations, identity.runIndex, identity.seed),
  scenarioOrder: balancedOrder(scenarios, identity.runIndex, identity.seed ^ 0x9e3779b9),
});
