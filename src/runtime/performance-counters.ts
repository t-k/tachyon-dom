/** Integer-only counters for a production-policy diagnostic build. The regular production bundle removes every guarded call. */
export type PerformanceCounterName =
  | "keyReads"
  | "rowsVisited"
  | "rowsCreated"
  | "rowsRemoved"
  | "nodeMoves"
  | "lisCalls"
  | "targetResolutions"
  | "structuralNodesVisited"
  | "bindingEvaluations"
  | "equalitySkips"
  | "adoptedElements"
  | "topLevelCloneCalls";

type CounterHost = typeof globalThis & {
  __tachyonPerformanceCounters?: Partial<Record<PerformanceCounterName, number>>;
};

export const countPerformance = (name: PerformanceCounterName, amount = 1): void => {
  const host = globalThis as CounterHost;
  const counters = (host.__tachyonPerformanceCounters ??= {});
  counters[name] = (counters[name] ?? 0) + amount;
};
