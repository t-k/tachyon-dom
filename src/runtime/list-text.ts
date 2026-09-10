import { setText, textAt } from "./text.js";
import { createSignal, detachFromEffectOwner, effect, onOwnerCleanup, read, type Signal } from "./signal.js";
import { cleanupOwnedSubtree, registerOwnedSubtree, runCleanups } from "./subtree.js";
import { normalizeListKey } from "./key.js";
import {
  canAppendWithoutMoving,
  dynamicElementsFor,
  emptyParentScope,
  positionRecords,
  readItemPath,
  readPath,
  replaceDynamicRegion,
  scopedItemFromSnapshot,
  syncParentScope,
  type ParentScopeSnapshot,
} from "./list-core.js";

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

const listStates = new WeakMap<Element, ListState>();

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
      if (
        child.nodeType === 8 &&
        ((child.nodeValue ?? "").startsWith("tachyon-hydrate:") || child.nodeValue === "/tachyon-if")
      )
        continue;
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

/**
 * Releases a row's registered work. `preservedNodes` are server-rendered nodes this row adopted rather than
 * created: a row that fails while binding releases its listeners but leaves that markup where it was, which is
 * what the general keyed list does.
 */
const cleanupRecord = (record: RowRecord, preservedNodes?: ReadonlySet<Node>): void => {
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
      if (!preservedNodes?.has(node)) node.parentNode?.removeChild(node);
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
  // The row effect outlives the list effect run that created it; the row releases it through `cleanups`.
  record.cleanups.push(
    detachFromEffectOwner(() =>
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
  // A row that fails part way through binding never reaches the caller's created list, so it releases what it
  // already registered here instead of leaving listeners on markup nobody owns.
  try {
    bindRow(record, options);
  } catch (error) {
    try {
      cleanupRecord(record, new Set(existingElements ?? []));
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Text list row creation and cleanup failed.");
    }
    throw error;
  }
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

const defaultAfterNode = (container: Element, region: TextKeyedListRegion): ChildNode | undefined =>
  region.after ? Array.from(container.children).at(-region.after) : undefined;

const boundaryAfterNode = (container: Element, region: TextKeyedListRegion): ChildNode | undefined =>
  Array.from(container.childNodes).find((child) => (child.nodeType & 8) && child.nodeValue == "tachyon-list") ||
  defaultAfterNode(container, region);

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
        afterNode(container, options.region),
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
    } else {
      positionRecords(
        container,
        orderedRecords,
        previousRecords,
        options.region ? (afterNode(container, options.region) ?? null) : null,
      );
    }
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
