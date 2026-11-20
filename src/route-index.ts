type RankedEntry<T> = { entry: T; rank: number };

export type RankedRouteTable<T> = {
  entries: readonly T[];
  index?: {
    byFirstSegment: ReadonlyMap<string, readonly T[]>;
    generic: readonly T[];
  };
};

export const firstStaticSegment = (segments: readonly string[]): string | undefined => {
  const first = segments[0];
  // Multi-segment patterns require a slash after this literal, even with a wildcard.
  return segments.length > 1 && first && !first.startsWith(":") && !first.startsWith("*") ? first : undefined;
};

const mergeByRank = <T>(bucket: readonly RankedEntry<T>[], generic: readonly RankedEntry<T>[]): T[] => {
  const candidates: T[] = [];
  let left = 0;
  let right = 0;
  while (left < bucket.length || right < generic.length) {
    const specific = bucket[left];
    const general = generic[right];
    if (specific && (!general || specific.rank < general.rank)) {
      candidates.push(specific.entry);
      left += 1;
    } else if (general) {
      candidates.push(general.entry);
      right += 1;
    }
  }
  return candidates;
};

export const indexRankedRoutes = <T extends { firstSegment: string | undefined }>(entries: readonly T[]): RankedRouteTable<T> => {
  if (entries.length < 24) return { entries };
  const buckets = new Map<string, RankedEntry<T>[]>();
  const generic: RankedEntry<T>[] = [];
  for (let rank = 0; rank < entries.length; rank += 1) {
    const entry = entries[rank] as T;
    if (entry.firstSegment === undefined) {
      generic.push({ entry, rank });
      // Keep startup work and per-segment duplication bounded for mostly dynamic tables.
      if (generic.length > 8) return { entries };
      continue;
    }
    const bucket = buckets.get(entry.firstSegment);
    if (bucket) bucket.push({ entry, rank });
    else buckets.set(entry.firstSegment, [{ entry, rank }]);
  }
  if (buckets.size < 2) return { entries };
  const byFirstSegment = new Map<string, readonly T[]>();
  for (const [segment, bucket] of buckets) {
    byFirstSegment.set(segment, mergeByRank(bucket, generic));
  }
  const index: NonNullable<RankedRouteTable<T>["index"]> = {
    byFirstSegment,
    generic: generic.map(({ entry }) => entry),
  };
  return { entries, index };
};

export const indexedRouteCandidates = <T>(table: RankedRouteTable<T>, pathname: string): readonly T[] => {
  const index = table.index;
  if (!index) return table.entries;
  const slash = pathname.indexOf("/", 1);
  if (slash <= 1 || pathname[0] !== "/") return index.generic;
  return index.byFirstSegment.get(pathname.slice(1, slash)) ?? index.generic;
};
