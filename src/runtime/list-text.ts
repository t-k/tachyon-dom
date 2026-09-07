import { setText, textAt } from "./text.js";
import { createSignal, effect, onOwnerCleanup, read, untrack, type Signal } from "./signal.js";
import { cleanupOwnedSubtree, registerOwnedSubtree, runCleanups } from "./subtree.js";
import { normalizeListKey } from "./key.js";

type ExpressionReader = (scope: Record<string, unknown>) => unknown;

type TextBinding = {
  kind: "text";
  path: number[];
  expression: string;
  read?: ExpressionReader;
};

type TextKeyedListOptions = {
  signature?: string;
  key: string;
  keyRead?: ExpressionReader;
  keyReadItem?: (item: unknown) => unknown;
  itemName: string;
  indexName?: string;
  updatePolicy?: "always" | "reference";
  region?: TextKeyedListRegion;
  scope?: Record<string, unknown>;
  templateHtml: string;
  bindings: TextBinding[];
};

type GeneratedTextBinding = Omit<TextBinding, "read"> & { read: ExpressionReader };

type GeneratedTextKeyedListOptionsBase = {
  signature: string;
  key: string;
  itemName: string;
  indexName?: string;
  updatePolicy?: "always" | "reference";
  region?: TextKeyedListRegion;
  scope?: Record<string, unknown>;
  templateHtml: string;
  bindings: GeneratedTextBinding[];
};

type GeneratedTextKeyedListOptions = GeneratedTextKeyedListOptionsBase &
  ({ keyReadItem: (item: unknown) => unknown; keyRead?: never } | { keyRead: ExpressionReader; keyReadItem?: never });

type TextKeyedListRuntimeOptions = {
  signature: string;
  itemName: string;
  indexName?: string;
  updatePolicy?: "always" | "reference";
  region?: TextKeyedListRegion;
  scope?: Record<string, unknown>;
  templateHtml: string;
  bindings: TextBinding[];
  readKey: (item: unknown, index: number) => unknown;
  readBinding: (scope: Record<string, unknown>, binding: TextBinding) => unknown;
};

type TextKeyedListRegion = {
  before: number;
  after: number;
  logicalBefore?: number;
};

type RowRecord = {
  key: PropertyKey;
  element: Element;
  nodes: Node[];
  scope: Record<string, unknown>;
  cleanups: Array<() => void>;
  lastValues: unknown[];
  item: unknown;
  index: number;
  sourceScope: Record<string, unknown> | undefined;
  sourceScopeSnapshot: Map<string, unknown>;
  revision: Signal<number>;
};

type ListState = {
  signature: string;
  options: TextKeyedListRuntimeOptions;
  records: Map<PropertyKey, RowRecord>;
  template: HTMLTemplateElement;
  elementIndices: number[];
  initialized: boolean;
  ownerCleanupDispose: (() => void) | undefined;
};

type CleanupOutcome = { failed: false } | { failed: true; error: unknown };

type MoveBeforeElement = Element & {
  moveBefore?: (node: Node, child: Node | null) => void;
};

const listStates = new WeakMap<Element, ListState>();

const readPath = (scope: Record<string, unknown>, expression: string): unknown => {
  let current: unknown = scope;
  for (const part of expression.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
};

const sourceScopeSnapshotFor = (scope: Record<string, unknown> | undefined): Map<string, unknown> =>
  new Map(scope ? Object.keys(scope).map((key) => [key, scope[key]] as const) : []);

const sourceScopeChanged = (previous: ReadonlyMap<string, unknown>, next: ReadonlyMap<string, unknown>): boolean => {
  if (previous.size !== next.size) return true;
  for (const [key, value] of previous) {
    if (!next.has(key) || !Object.is(next.get(key), value)) return true;
  }
  return false;
};

const readItemPath = (item: unknown, expression: string, itemName: string): unknown => {
  if (expression === itemName) return item;
  const prefix = `${itemName}.`;
  if (!expression.startsWith(prefix)) return undefined;
  return readPath(item as Record<string, unknown>, expression.slice(prefix.length));
};

const scopedItem = (
  itemName: string,
  item: unknown,
  indexName: string | undefined,
  index: number,
  scope: Record<string, unknown> | undefined,
): Record<string, unknown> => ({ ...scope, [itemName]: item, ...(indexName ? { [indexName]: index } : {}) });

const nodeAt = (root: Node, path: readonly number[]): Node => {
  let current = root;
  for (const index of path) current = current.childNodes[index] as Node;
  return current;
};

const textAtRecord = (record: RowRecord, path: readonly number[]): Text => {
  if (record.nodes.length <= 1) return textAt(record.element, path);
  const [firstIndex, ...rest] = path;
  return textAt(record.nodes[firstIndex ?? 0] ?? record.element, rest);
};

const legacyOptionsSignature = (options: TextKeyedListOptions): string =>
  options.signature ??
  JSON.stringify({
    key: options.key,
    itemName: options.itemName,
    indexName: options.indexName,
    updatePolicy: options.updatePolicy,
    region: options.region,
    templateHtml: options.templateHtml,
    bindings: options.bindings,
  });

const resolveGeneratedOptions = (options: GeneratedTextKeyedListOptions): TextKeyedListRuntimeOptions => {
  const readKey = options.keyReadItem
    ? (item: unknown) => options.keyReadItem(item)
    : (item: unknown, index: number) =>
        options.keyRead(scopedItem(options.itemName, item, options.indexName, index, options.scope));
  return {
    signature: options.signature,
    itemName: options.itemName,
    ...(options.indexName ? { indexName: options.indexName } : {}),
    ...(options.updatePolicy ? { updatePolicy: options.updatePolicy } : {}),
    ...(options.region ? { region: options.region } : {}),
    ...(options.scope ? { scope: options.scope } : {}),
    templateHtml: options.templateHtml,
    bindings: options.bindings,
    readKey,
    readBinding: (scope, binding) => read((binding as GeneratedTextBinding).read(scope)),
  };
};

const resolveLegacyOptions = (options: TextKeyedListOptions): TextKeyedListRuntimeOptions => {
  const readKey = options.keyReadItem
    ? (item: unknown) => options.keyReadItem?.(item)
    : options.keyRead
      ? (item: unknown, index: number) =>
          options.keyRead?.(scopedItem(options.itemName, item, options.indexName, index, options.scope))
      : (item: unknown) => readItemPath(item, options.key, options.itemName);
  return {
    signature: legacyOptionsSignature(options),
    itemName: options.itemName,
    ...(options.indexName ? { indexName: options.indexName } : {}),
    ...(options.updatePolicy ? { updatePolicy: options.updatePolicy } : {}),
    ...(options.region ? { region: options.region } : {}),
    ...(options.scope ? { scope: options.scope } : {}),
    templateHtml: options.templateHtml,
    bindings: options.bindings,
    readKey,
    readBinding: (scope, binding) => read(binding.read ? binding.read(scope) : readPath(scope, binding.expression)),
  };
};

const cleanupRecord = (record: RowRecord): void => {
  let firstError: unknown;
  let failed = false;
  try {
    runCleanups(record.cleanups);
  } catch (error) {
    firstError = error;
    failed = true;
  }
  for (const node of record.nodes) {
    try {
      cleanupOwnedSubtree(node);
    } catch (error) {
      if (!failed) firstError = error;
      failed = true;
    } finally {
      node.parentNode?.removeChild(node);
    }
  }
  if (failed) throw firstError;
};

const cleanupListState = (state: ListState): void => {
  state.ownerCleanupDispose?.();
  state.ownerCleanupDispose = undefined;
  let firstError: unknown;
  let failed = false;
  for (const record of state.records.values()) {
    try {
      cleanupRecord(record);
    } catch (error) {
      if (!failed) firstError = error;
      failed = true;
    }
  }
  state.records.clear();
  if (failed) throw firstError;
};

const getListState = (container: Element, options: TextKeyedListRuntimeOptions): ListState => {
  const current = listStates.get(container);
  if (current && current.options === options) return current;
  const signature = options.signature;
  if (current && current.signature === signature) {
    current.options = options;
    return current;
  }
  if (current) cleanupOwnedSubtree(container);
  const template = document.createElement("template");
  template.innerHTML = options.templateHtml;
  const next: ListState = {
    signature,
    options,
    records: new Map(),
    template,
    elementIndices: Array.from(template.content.childNodes).flatMap((node, index) =>
      node instanceof Element ? [index] : [],
    ),
    initialized: false,
    ownerCleanupDispose: undefined,
  };
  listStates.set(container, next);
  registerOwnedSubtree(container, () => {
    if (listStates.get(container) !== next) return;
    try {
      cleanupListState(next);
    } finally {
      listStates.delete(container);
    }
  });
  next.ownerCleanupDispose = onOwnerCleanup(() => {
    cleanupOwnedSubtree(container);
  });
  return next;
};

const bindRow = (record: RowRecord, options: TextKeyedListRuntimeOptions): void => {
  if (options.bindings.length === 0) return;
  record.cleanups.push(
    untrack(() =>
      effect(() => {
        record.revision();
        for (let index = 0; index < options.bindings.length; index++) {
          const binding = options.bindings[index] as TextBinding;
          const value = options.readBinding(record.scope, binding);
          if (Object.is(record.lastValues[index], value)) continue;
          record.lastValues[index] = value;
          setText(textAtRecord(record, binding.path), value);
        }
      }),
    ),
  );
};

const keyFor = (item: unknown, index: number, options: TextKeyedListRuntimeOptions): PropertyKey => {
  return normalizeListKey(read(options.readKey(item, index)));
};

const warnDuplicateKey = (key: PropertyKey, options: TextKeyedListRuntimeOptions): void => {
  if ((typeof process !== "undefined" && process.env.NODE_ENV === "production") || typeof console.warn !== "function") {
    return;
  }
  const location = options.signature ? ` ${options.signature}` : "";
  console.warn(
    `Duplicate key ${JSON.stringify(String(key))} in keyed <for> list${location}. Later items with the same key were skipped.`,
  );
};

const createRecord = (
  state: ListState,
  key: PropertyKey,
  item: unknown,
  options: TextKeyedListRuntimeOptions,
  existingElements?: readonly Element[],
  index = 0,
): RowRecord | undefined => {
  const nodes = Array.from(state.template.content.childNodes).map((node) => node.cloneNode(true));
  if (existingElements) {
    state.elementIndices.forEach((nodeIndex, elementIndex) => {
      const existing = existingElements[elementIndex];
      if (existing) nodes[nodeIndex] = existing;
    });
  }
  const element = nodes.find((node): node is Element => node instanceof Element);
  if (!element) return undefined;
  const record: RowRecord = {
    key,
    element,
    nodes,
    scope: scopedItem(options.itemName, item, options.indexName, index, options.scope),
    cleanups: [],
    lastValues: [],
    item,
    index,
    sourceScope: options.scope,
    sourceScopeSnapshot: sourceScopeSnapshotFor(options.scope),
    revision: createSignal(0),
  };
  bindRow(record, options);
  return record;
};

const updateRecord = (record: RowRecord, item: unknown, index: number, options: TextKeyedListRuntimeOptions): void => {
  const nextSourceScopeSnapshot = sourceScopeSnapshotFor(options.scope);
  const scopeChanged =
    record.sourceScope !== options.scope || sourceScopeChanged(record.sourceScopeSnapshot, nextSourceScopeSnapshot);
  for (const key of record.sourceScopeSnapshot.keys()) {
    if (!nextSourceScopeSnapshot.has(key) && key !== options.itemName && key !== options.indexName) {
      record.scope[key] = undefined;
    }
  }
  for (const [key, value] of nextSourceScopeSnapshot) {
    if (key === options.itemName || key === options.indexName) continue;
    record.scope[key] = value;
  }
  record.scope[options.itemName] = item;
  if (options.indexName) record.scope[options.indexName] = index;
  const itemChanged = !Object.is(record.item, item);
  const indexChanged = record.index !== index;
  record.item = item;
  record.index = index;
  record.sourceScope = options.scope;
  record.sourceScopeSnapshot = nextSourceScopeSnapshot;
  if (options.updatePolicy === "reference" && !itemChanged && !indexChanged && !scopeChanged) return;
  record.revision.update((value) => value + 1);
};

const moveBefore = (container: Element, node: Node, before: Node | null): void => {
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

const longestIncreasingSubsequencePositions = (values: readonly number[]): Set<number> => {
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

const positionRecords = (
  container: Element,
  orderedRecords: readonly RowRecord[],
  previousRecords: ReadonlyMap<PropertyKey, RowRecord>,
  region?: TextKeyedListRegion,
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
  const staticAfter = region && region.after > 0 ? (Array.from(container.children).at(-region.after) ?? null) : null;
  let anchor: Node | null = orderedRecords[nextKeys.length - suffixLength]?.nodes[0] ?? staticAfter;
  for (let index = nextKeys.length - suffixLength - 1; index >= prefixLength; index--) {
    const record = orderedRecords[index] as RowRecord;
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

const dynamicElementsFor = (container: Element, region: TextKeyedListRegion | undefined): Element[] => {
  const elements = Array.from(container.children);
  if (!region) return elements;
  const start = Math.min(elements.length, Math.max(0, region.before));
  const end = Math.max(start, elements.length - Math.max(0, region.after));
  return elements.slice(start, end);
};

const replaceDynamicRegion = (container: Element, region: TextKeyedListRegion, nodes: readonly Node[]): void => {
  const childNodes = Array.from(container.childNodes);
  const elements = Array.from(container.children);
  const firstAfter = region.after > 0 ? elements.at(-region.after) : undefined;
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

const canAppendWithoutMoving = (
  nextRecords: ReadonlyMap<PropertyKey, RowRecord>,
  orderedRecords: readonly RowRecord[],
  previousRecords: ReadonlyMap<PropertyKey, RowRecord>,
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

/** Releases a text-only list produced by the Tachyon DOM compiler. */
export const cleanupTextKeyedList = (root: Element, path: readonly number[]): void => {
  const container = nodeAt(root, path);
  if (container instanceof Element) cleanupOwnedSubtree(container);
};

const mountTextKeyedListResolved = (
  root: Element,
  path: readonly number[],
  items: readonly unknown[] | undefined,
  options: TextKeyedListRuntimeOptions,
): void => {
  const container = nodeAt(root, path);
  if (!(container instanceof Element)) return;
  const state = getListState(container, options);
  const cleanupRecordsNotIn = (
    records: Map<PropertyKey, RowRecord>,
    keep: Pick<ReadonlySet<PropertyKey>, "has">,
  ): CleanupOutcome => {
    let firstError: unknown;
    let failed = false;
    for (const [key, record] of records) {
      if (keep.has(key)) continue;
      try {
        cleanupRecord(record);
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
      } finally {
        records.delete(key);
      }
    }
    return failed ? { failed: true, error: firstError } : { failed: false };
  };
  if (!items) {
    const cleanupResult = cleanupRecordsNotIn(state.records, new Set());
    state.records.clear();
    if (cleanupResult.failed) throw cleanupResult.error;
    return;
  }
  const entries: Array<{ item: unknown; index: number; key: PropertyKey }> = [];
  const seenKeys = new Set<PropertyKey>();
  for (const [index, item] of items.entries()) {
    const key = keyFor(item, index, options);
    if (seenKeys.has(key)) {
      warnDuplicateKey(key, options);
      continue;
    }
    seenKeys.add(key);
    entries.push({ item, index, key });
  }
  const nextRecords = new Map<PropertyKey, RowRecord>();
  const orderedRecords: RowRecord[] = [];
  const createdRecords: RowRecord[] = [];
  const previousRecords = state.records;
  const inspectServerRows = !state.initialized && state.records.size === 0 && state.elementIndices.length > 0;
  const serverElements = inspectServerRows ? Array.from(container.children) : [];
  const serverDynamicElements = inspectServerRows ? dynamicElementsFor(container, options.region) : [];
  const canAdoptServerRows =
    inspectServerRows &&
    (options.region
      ? serverDynamicElements.length > 0
      : serverElements.length >= entries.length * state.elementIndices.length);
  try {
    for (const [entryIndex, entry] of entries.entries()) {
      const existing = state.records.get(entry.key);
      const adoptable = canAdoptServerRows
        ? serverDynamicElements.slice(
            entryIndex * state.elementIndices.length,
            (entryIndex + 1) * state.elementIndices.length,
          )
        : undefined;
      const record = existing ?? createRecord(state, entry.key, entry.item, options, adoptable, entry.index);
      if (!record) continue;
      if (existing) updateRecord(record, entry.item, entry.index, options);
      else createdRecords.push(record);
      nextRecords.set(entry.key, record);
      orderedRecords.push(record);
    }
    if (canAdoptServerRows && options.region) {
      replaceDynamicRegion(
        container,
        options.region,
        orderedRecords.flatMap((record) => record.nodes),
      );
    } else if (canAdoptServerRows) container.replaceChildren(...orderedRecords.flatMap((record) => record.nodes));
    else if (canAppendWithoutMoving(nextRecords, orderedRecords, previousRecords)) {
      const previousKeys = new Set(previousRecords.keys());
      for (const record of orderedRecords) {
        if (!previousKeys.has(record.key)) {
          if (!options.region || options.region.after <= 0) {
            container.append(...record.nodes);
          } else {
            const staticAfter = Array.from(container.children).at(-options.region.after) ?? null;
            for (const node of record.nodes) container.insertBefore(node, staticAfter);
          }
        }
      }
    } else positionRecords(container, orderedRecords, previousRecords, options.region);
    state.records = nextRecords;
    state.initialized = true;
    createdRecords.length = 0;
    const cleanupResult = cleanupRecordsNotIn(previousRecords, nextRecords);
    if (cleanupResult.failed) throw cleanupResult.error;
  } catch (error) {
    let firstCleanupError: unknown;
    let cleanupFailed = false;
    for (const record of createdRecords) {
      try {
        cleanupRecord(record);
      } catch (cleanupError) {
        if (!cleanupFailed) firstCleanupError = cleanupError;
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) throw new AggregateError([error, firstCleanupError], "Text list update and rollback failed.");
    throw error;
  }
};

/** Mounts compiler-generated text-only rows using mandatory compiler readers. */
export const mountGeneratedTextKeyedList = (
  root: Element,
  path: readonly number[],
  items: readonly unknown[] | undefined,
  options: GeneratedTextKeyedListOptions,
): void => {
  mountTextKeyedListResolved(root, path, items, resolveGeneratedOptions(options));
};

/**
 * Mounts text-only rows from the compatibility descriptor. `templateHtml` must be trusted compiler output, never untrusted input.
 */
export const mountTextKeyedList = (
  root: Element,
  path: readonly number[],
  items: readonly unknown[] | undefined,
  options: TextKeyedListOptions,
): void => {
  mountTextKeyedListResolved(root, path, items, resolveLegacyOptions(options));
};
