import { balancedOrder } from "../shared/statistical-authority.js";

export const LOCAL_COMPARE_ENVELOPE_SCHEMA_VERSION = 2 as const;
export const LOCAL_COMPARE_CONTRACT_VERSION = 3 as const;

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
