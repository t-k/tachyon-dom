export type MetricDirection = "lower" | "higher";

export type MetricValue = {
  name: string;
  value: number;
};

export type RankedMetric = MetricValue & {
  rank: number;
  ratioToBest: number;
};

export const rankMetric = (values: readonly MetricValue[], direction: MetricDirection): RankedMetric[] => {
  if (values.length === 0) {
    throw new Error("Ranking requires at least one metric value.");
  }
  for (const item of values) {
    if (!Number.isFinite(item.value)) {
      throw new Error(`${item.name} must be finite.`);
    }
    if (item.value < 0) {
      throw new Error(`${item.name} must be non-negative.`);
    }
    if (item.value === 0) {
      throw new Error(`${item.name} must be positive.`);
    }
  }

  const sorted = [...values].sort((left, right) =>
    direction === "lower" ? left.value - right.value : right.value - left.value,
  );
  const best = sorted[0]?.value as number;
  const ranked: RankedMetric[] = [];
  for (const [index, item] of sorted.entries()) {
    const previous = ranked.at(-1);
    ranked.push({
      ...item,
      rank: previous && previous.value === item.value ? previous.rank : index + 1,
      ratioToBest: direction === "lower" ? item.value / best : best / item.value,
    });
  }
  return ranked;
};
