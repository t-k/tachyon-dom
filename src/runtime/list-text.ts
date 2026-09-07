import { setText, textAt } from "./text.js";
import { createSignal, effect, onOwnerCleanup, read, untrack, type Signal } from "./signal.js";
import { cleanupOwnedSubtree, registerOwnedSubtree, runCleanups } from "./subtree.js";
import { normalizeListKey } from "./key.js";

type ExpressionReader = (scope: Record<string, unknown>) => unknown;

type TextBinding = {
  kind: "text";
  path: number[];
  expression?: string;
  read?: ExpressionReader;
};

type TextKeyedListOptions = {
  signature?: string;
  key: string;
  /** Parent scope names the compiler proved these rows can read. */
  parentScopeKeys?: readonly string[];
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

type GeneratedTextBinding = Omit<TextBinding, "read"> & {
  read: ExpressionReader;
  /**
   * Applies the value to the row node the compiler resolved. Omitted for a text binding, whose node is the
   * template's text node. Supplying it here keeps class, attribute, and style setters out of this module.
   */
  apply?: (node: Node, value: unknown) => void;
};

/** Registers a row listener and returns its disposer; the generated module owns the event runtime. */
type GeneratedRowEvent = {
  path: number[];
  bind: (element: Element, scope: Record<string, unknown>) => () => void;
};

type GeneratedTextKeyedListOptionsBase = {
  signature: string;
  events?: readonly GeneratedRowEvent[];
  key: string;
  /** Parent scope names the compiler proved these rows can read. */
  parentScopeKeys?: readonly string[];
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
  events?: readonly GeneratedRowEvent[];
  parentScopeKeys?: readonly string[];
  itemName: string;
  indexName?: string;
  updatePolicy?: "always" | "reference";
  region?: TextKeyedListRegion;
  scope?: Record<string, unknown>;
  templateHtml: string;
  bindings: TextBinding[];
  readKey: (item: unknown, index: number) => unknown;
  readBinding: (scope: Record<string, unknown>, binding: TextBinding) => unknown;
  a: (container: Element, region: TextKeyedListRegion) => ChildNode | null | undefined;
};

type TextKeyedListRegion = {
  before: number;
  after: number;
  logicalBefore?: number;
  logicalAfter?: number;
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
  appliedParentScope: ParentScopeSnapshot;
  revision: Signal<number>;
};

type ParentScopeSnapshot = {
  scope: Record<string, unknown> | undefined;
  values: ReadonlyMap<string, unknown>;
};

type ListState = {
  signature: string;
  options: TextKeyedListRuntimeOptions;
  parentScope: ParentScopeSnapshot;
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

const parentScopeNames = (
  scope: Record<string, unknown> | undefined,
  keys: readonly string[] | undefined,
): readonly string[] => (scope ? (keys ?? Object.keys(scope)) : []);

const parentScopeValuesFor = (
  scope: Record<string, unknown> | undefined,
  keys: readonly string[] | undefined,
): Map<string, unknown> =>
  new Map(parentScopeNames(scope, keys).map((key) => [key, scope?.[key]] as const));

const emptyParentScope: ParentScopeSnapshot = { scope: undefined, values: new Map() };

/**
 * Compares the parent scope once per list update and shares one snapshot with every row. The comparison reads
 * the live scope instead of a fresh copy, so an update that changes nothing reads each parent key once for the
 * whole list rather than once per row, and allocates no map at all. Rows detect a change by snapshot identity.
 */
const syncParentScope = (
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

const readItemPath = (item: unknown, expression: string, itemName: string): unknown => {
  if (expression === itemName) return item;
  const prefix = `${itemName}.`;
  if (!expression.startsWith(prefix)) return undefined;
  return readPath(item as Record<string, unknown>, expression.slice(prefix.length));
};

// Row scopes are built from the same restricted parent snapshot that updates apply.
const scopedItemFromSnapshot = (
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

const scopedItem = (
  itemName: string,
  item: unknown,
  indexName: string | undefined,
  index: number,
  scope: Record<string, unknown> | undefined,
): Record<string, unknown> => ({ ...scope, [itemName]: item, ...(indexName ? { [indexName]: index } : {}) });

const nodeAt = (root: Node, path: readonly number[]): Node => {
  let current = root;
  for (const index of path) {
    // Skip SSR hydration marker comments so template paths stay valid on adopted rows.
    let cursor = 0;
    let next: Node | undefined;
    for (const child of Array.from(current.childNodes)) {
      if (child.nodeType === 8 && (child.nodeValue ?? "").startsWith("tachyon-hydrate:")) continue;
      if (cursor++ === index) {
        next = child;
        break;
      }
    }
    current = next as Node;
  }
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
    ...(options.parentScopeKeys ? { parentScopeKeys: options.parentScopeKeys } : {}),
    ...(options.events ? { events: options.events } : {}),
    templateHtml: options.templateHtml,
    bindings: options.bindings,
    readKey,
    readBinding: (scope, binding) => read((binding as GeneratedTextBinding).read(scope)),
    a: defaultAfterNode,
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
    ...(options.parentScopeKeys ? { parentScopeKeys: options.parentScopeKeys } : {}),
    templateHtml: options.templateHtml,
    bindings: options.bindings,
    readKey,
    readBinding: (scope, binding) => read(binding.read ? binding.read(scope) : readPath(scope, binding.expression ?? "")),
    a: defaultAfterNode,
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
    parentScope: emptyParentScope,
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

const nodeAtRecord = (record: RowRecord, path: readonly number[]): Node => {
  if (record.nodes.length <= 1) return nodeAt(record.element, path);
  const [firstIndex, ...rest] = path;
  return nodeAt(record.nodes[firstIndex ?? 0] ?? record.element, rest);
};

const bindRow = (record: RowRecord, options: TextKeyedListRuntimeOptions): void => {
  // The row scope object is mutated in place by updates, so a listener bound once always sees the current item.
  for (const event of options.events ?? []) {
    const element = nodeAtRecord(record, event.path);
    if (element instanceof Element) record.cleanups.push(event.bind(element, record.scope));
  }
  if (options.bindings.length === 0) return;
  record.cleanups.push(
    untrack(() =>
      effect(() => {
        record.revision();
        for (let index = 0; index < options.bindings.length; index++) {
          const binding = options.bindings[index] as GeneratedTextBinding;
          const value = options.readBinding(record.scope, binding);
          if (Object.is(record.lastValues[index], value)) continue;
          record.lastValues[index] = value;
          if (binding.apply) binding.apply(nodeAtRecord(record, binding.path), value);
          else setText(textAtRecord(record, binding.path), value);
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
  parentScope: ParentScopeSnapshot,
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
    scope: scopedItemFromSnapshot(options.itemName, item, options.indexName, index, parentScope.values),
    cleanups: [],
    lastValues: [],
    item,
    index,
    appliedParentScope: parentScope,
    revision: createSignal(0),
  };
  bindRow(record, options);
  return record;
};

const updateRecord = (
  record: RowRecord,
  item: unknown,
  index: number,
  options: TextKeyedListRuntimeOptions,
  parentScope: ParentScopeSnapshot,
): void => {
  const scopeChanged = record.appliedParentScope !== parentScope;
  if (scopeChanged) {
    for (const key of record.appliedParentScope.values.keys()) {
      if (!parentScope.values.has(key) && key !== options.itemName && key !== options.indexName) {
        record.scope[key] = undefined;
      }
    }
    for (const [key, value] of parentScope.values) {
      if (key === options.itemName || key === options.indexName) continue;
      record.scope[key] = value;
    }
    record.appliedParentScope = parentScope;
  }
  record.scope[options.itemName] = item;
  if (options.indexName) record.scope[options.indexName] = index;
  const itemChanged = !Object.is(record.item, item);
  const indexChanged = record.index !== index;
  record.item = item;
  record.index = index;
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

const defaultAfterNode = (container: Element, region: TextKeyedListRegion): ChildNode | undefined =>
  region.after ? Array.from(container.children).at(-region.after) : undefined;

const boundaryAfterNode = (container: Element, region: TextKeyedListRegion): ChildNode | undefined =>
  Array.from(container.childNodes).find((child) => (child.nodeType & 8) && child.nodeValue == "tachyon-list") ||
  defaultAfterNode(container, region);

const positionRecords = (
  container: Element,
  orderedRecords: readonly RowRecord[],
  previousRecords: ReadonlyMap<PropertyKey, RowRecord>,
  region: TextKeyedListRegion | undefined,
  afterNode: (container: Element, region: TextKeyedListRegion) => ChildNode | null | undefined,
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
  const staticAfter = region ? (afterNode(container, region) ?? null) : null;
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
  const start = Math.max(0, region.before);
  const end = Math.max(start, elements.length - region.after);
  return elements.slice(start, end);
};

const replaceDynamicRegion = (
  container: Element,
  region: TextKeyedListRegion,
  nodes: readonly Node[],
  afterNode: (container: Element, region: TextKeyedListRegion) => ChildNode | null | undefined,
): void => {
  const childNodes = Array.from(container.childNodes);
  const firstAfter = afterNode(container, region);
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
  const afterNode = options.a;
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
  const parentScope = syncParentScope(state, options.scope, options.parentScopeKeys);
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
      const record =
        existing ?? createRecord(state, entry.key, entry.item, options, parentScope, adoptable, entry.index);
      if (!record) continue;
      if (existing) updateRecord(record, entry.item, entry.index, options, parentScope);
      else createdRecords.push(record);
      nextRecords.set(entry.key, record);
      orderedRecords.push(record);
    }
    if (canAdoptServerRows && options.region) {
      replaceDynamicRegion(
        container,
        options.region,
        orderedRecords.flatMap((record) => record.nodes),
        afterNode,
      );
    } else if (canAdoptServerRows) container.replaceChildren(...orderedRecords.flatMap((record) => record.nodes));
    else if (canAppendWithoutMoving(nextRecords, orderedRecords, previousRecords)) {
      const previousKeys = new Set(previousRecords.keys());
      for (const record of orderedRecords) {
        if (!previousKeys.has(record.key)) {
          const staticAfter = options.region ? afterNode(container, options.region) : undefined;
          if (!staticAfter) {
            container.append(...record.nodes);
          } else for (const node of record.nodes) container.insertBefore(node, staticAfter);
        }
      }
    } else positionRecords(container, orderedRecords, previousRecords, options.region, afterNode);
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

export const mountGeneratedTextKeyedListWithBoundary = (
  root: Element,
  path: readonly number[],
  items: readonly unknown[] | undefined,
  options: GeneratedTextKeyedListOptions,
): void => {
  mountTextKeyedListResolved(root, path, items, {
    ...resolveGeneratedOptions(options),
    a: boundaryAfterNode,
  });
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
  const resolved = resolveLegacyOptions(options);
  mountTextKeyedListResolved(
    root,
    path,
    items,
    options.region?.logicalAfter === undefined ? resolved : { ...resolved, a: boundaryAfterNode },
  );
};
