/**
 * The reconciliation core both keyed list runtimes share.
 *
 * `list.ts` drives every binding kind from descriptors; `list-text.ts` drives compiler-generated rows from
 * injected setters. What they have in common is how rows are keyed, ordered, and moved, and how a row scope is
 * assembled from its parent. That part lives here so the two runtimes cannot drift apart, and so a page that
 * loads both ships one copy of it.
 *
 * Everything here is written against the smallest shape it needs: a positioned row is `{ key, nodes }` and a
 * region is `{ before, after }`. Neither runtime's record type is named, so neither constrains the other.
 */

export type PositionedRow = {
  key: PropertyKey;
  nodes: Node[];
};

export type ListCoreRegion = {
  before: number;
  after: number;
};

export type ParentScopeSnapshot = {
  scope: Record<string, unknown> | undefined;
  values: ReadonlyMap<string, unknown>;
};

type MoveBeforeElement = Element & {
  moveBefore?: (node: Node, before: Node | null) => void;
};

export const readPath = (scope: Record<string, unknown>, expression: string): unknown => {
  let current: unknown = scope;
  for (const part of expression.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
};

export const readItemPath = (item: unknown, expression: string, itemName: string): unknown => {
  if (expression === itemName) return item;
  const prefix = `${itemName}.`;
  if (!expression.startsWith(prefix)) return undefined;
  return readPath(item as Record<string, unknown>, expression.slice(prefix.length));
};

export const parentScopeNames = (
  scope: Record<string, unknown> | undefined,
  keys: readonly string[] | undefined,
): readonly string[] => (scope ? (keys ?? Object.keys(scope)) : []);

export const parentScopeValuesFor = (
  scope: Record<string, unknown> | undefined,
  keys: readonly string[] | undefined,
): Map<string, unknown> => new Map(parentScopeNames(scope, keys).map((key) => [key, scope?.[key]] as const));

export const emptyParentScope: ParentScopeSnapshot = { scope: undefined, values: new Map() };

/**
 * Compares the parent scope once per list update and shares one snapshot with every row. The comparison reads
 * the live scope instead of a fresh copy, so an update that changes nothing reads each parent key once for the
 * whole list rather than once per row, and allocates no map at all. Rows detect a change by snapshot identity.
 */
export const syncParentScope = (
  state: { parentScope: ParentScopeSnapshot },
  scope: Record<string, unknown> | undefined,
  parentScopeKeys: readonly string[] | undefined,
): ParentScopeSnapshot => {
  const previous = state.parentScope;
  const keys = parentScopeNames(scope, parentScopeKeys);
  if (
    previous.scope === scope &&
    keys.length === previous.values.size &&
    keys.every((key) => previous.values.has(key) && Object.is(previous.values.get(key), scope?.[key]))
  ) {
    return previous;
  }
  state.parentScope = { scope, values: parentScopeValuesFor(scope, parentScopeKeys) };
  return state.parentScope;
};

export const scopedItemFromSnapshot = (
  itemName: string,
  item: unknown,
  indexName: string | undefined,
  index: number,
  parent: ReadonlyMap<string, unknown>,
): Record<string, unknown> => {
  const scope: Record<string, unknown> = {};
  for (const [key, value] of parent) scope[key] = value;
  scope[itemName] = item;
  if (indexName) scope[indexName] = index;
  return scope;
};

export const moveBefore = (container: Element, node: Node, before: Node | null): void => {
  const movableContainer = container as MoveBeforeElement;
  if (typeof movableContainer.moveBefore === "function") {
    try {
      movableContainer.moveBefore(node, before);
      return;
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "HierarchyRequestError")) throw error;
    }
  }
  container.insertBefore(node, before);
};

export const longestIncreasingSubsequencePositions = (values: readonly number[]): Set<number> => {
  const predecessors = Array(values.length).fill(-1) as number[];
  const tails: number[] = [];
  const tailPositions: number[] = [];
  for (let index = 0; index < values.length; index++) {
    const value = values[index] as number;
    if (value < 0) continue;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((tails[middle] as number) < value) low = middle + 1;
      else high = middle;
    }
    if (low > 0) predecessors[index] = tailPositions[low - 1] as number;
    tails[low] = value;
    tailPositions[low] = index;
  }
  const positions = new Set<number>();
  let cursor = tailPositions[tails.length - 1] ?? -1;
  while (cursor >= 0) {
    positions.add(cursor);
    cursor = predecessors[cursor] as number;
  }
  return positions;
};

/**
 * Moves the rows that have to move and no others. The shared prefix and suffix are skipped outright, and inside
 * what is left the longest increasing subsequence of retained rows stays put, so a reorder touches the minimum
 * number of nodes. `staticAfter` is the first node that follows the list, which each runtime resolves its own
 * way, or null when the list owns everything to the end of its container.
 */
export const positionRecords = (
  container: Element,
  orderedRecords: readonly PositionedRow[],
  previousRecords: ReadonlyMap<PropertyKey, PositionedRow>,
  staticAfter: Node | null,
): void => {
  const previousKeys = Array.from(previousRecords.keys());
  const nextKeys = orderedRecords.map((record) => record.key);
  const sharedLength = Math.min(previousKeys.length, nextKeys.length);
  let prefixLength = 0;
  while (prefixLength < sharedLength && previousKeys[prefixLength] === nextKeys[prefixLength]) {
    prefixLength++;
  }
  let suffixLength = 0;
  while (
    suffixLength < sharedLength - prefixLength &&
    previousKeys[previousKeys.length - suffixLength - 1] === nextKeys[nextKeys.length - suffixLength - 1]
  ) {
    suffixLength++;
  }
  const previousOrder = new Map<PropertyKey, number>();
  for (let index = prefixLength; index < previousKeys.length - suffixLength; index++) {
    previousOrder.set(previousKeys[index] as PropertyKey, index);
  }
  const stablePositions = longestIncreasingSubsequencePositions(
    nextKeys.map((key, index) =>
      index < prefixLength || index >= nextKeys.length - suffixLength ? -1 : (previousOrder.get(key) ?? -1),
    ),
  );
  let anchor: Node | null = orderedRecords[nextKeys.length - suffixLength]?.nodes[0] ?? staticAfter;
  for (let index = nextKeys.length - suffixLength - 1; index >= prefixLength; index--) {
    const record = orderedRecords[index] as PositionedRow;
    if (stablePositions.has(index)) {
      anchor = record.nodes[0] ?? anchor;
      continue;
    }
    for (let nodeIndex = record.nodes.length - 1; nodeIndex >= 0; nodeIndex--) {
      const node = record.nodes[nodeIndex] as Node;
      if (node.parentNode !== container || node.nextSibling !== anchor) moveBefore(container, node, anchor);
      anchor = node;
    }
  }
};

export const dynamicElementsFor = (container: Element, region: ListCoreRegion | undefined): Element[] => {
  const elements = Array.from(container.children);
  if (!region) return elements;
  const start = Math.min(elements.length, Math.max(0, region.before));
  const end = Math.max(start, elements.length - Math.max(0, region.after));
  return elements.slice(start, end);
};

export const replaceDynamicRegion = (
  container: Element,
  region: ListCoreRegion,
  nodes: readonly Node[],
  firstAfter: ChildNode | null | undefined,
): void => {
  const childNodes = Array.from(container.childNodes);
  const firstDynamic = dynamicElementsFor(container, region)[0];
  const startNode = firstDynamic ?? firstAfter;
  const start = startNode ? childNodes.indexOf(startNode) : childNodes.length;
  const end = firstAfter ? childNodes.indexOf(firstAfter) : childNodes.length;
  for (const node of childNodes.slice(Math.max(0, start), Math.max(start, end))) node.remove();
  const fragment = document.createDocumentFragment();
  fragment.append(...nodes);
  if (firstAfter?.parentNode === container) container.insertBefore(fragment, firstAfter);
  else container.append(fragment);
};

/** True when the next order keeps every retained row in place, so new rows only have to be appended. */
export const canAppendWithoutMoving = (
  nextRecords: ReadonlyMap<PropertyKey, unknown>,
  orderedRecords: readonly PositionedRow[],
  previousRecords: ReadonlyMap<PropertyKey, unknown>,
): boolean => {
  const previousKeys = Array.from(previousRecords.keys());
  const nextKeys = orderedRecords.map((record) => record.key);
  const retainedPrevious = previousKeys.filter((key) => nextRecords.has(key));
  const retainedNext = nextKeys.filter((key) => previousRecords.has(key));
  if (retainedPrevious.length !== retainedNext.length) return false;
  for (let index = 0; index < retainedPrevious.length; index++) {
    if (retainedPrevious[index] !== retainedNext[index]) return false;
  }
  return nextKeys.slice(0, retainedNext.length).every((key) => previousRecords.has(key));
};
