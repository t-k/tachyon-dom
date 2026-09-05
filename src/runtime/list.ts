import { setClassPresence } from "./class.js";
import { setAttributeValue, setRef, setStyleValue } from "./attr.js";
import { setText } from "./text.js";
import { bindControl, setControlValue, writeModelValue } from "./form.js";
import { mountConditional } from "./conditional.js";
import { createSignal, effect, onOwnerCleanup, read, untrack, type Signal } from "./signal.js";
import { cleanupOwnedSubtree, registerOwnedSubtree, runCleanups } from "./subtree.js";
import { normalizeListKey } from "./key.js";

type ExpressionReader = (scope: Record<string, unknown>) => unknown;
type ExpressionWriter = (scope: Record<string, unknown>, value: unknown) => void;

type TextBinding = {
  kind: "text";
  path: number[];
  expression: string;
  read?: ExpressionReader;
};

type ClassBinding = {
  kind: "class";
  path: number[];
  className: string;
  expression: string;
  read?: ExpressionReader;
};

type EventBinding = {
  kind: "event";
  path: number[];
  eventName: string;
  handler: string;
  read?: ExpressionReader;
};

type AttributeBinding = {
  kind: "attr";
  path: number[];
  name: string;
  expression: string;
  read?: ExpressionReader;
};

type StyleBinding = {
  kind: "style";
  path: number[];
  name: string;
  expression: string;
  read?: ExpressionReader;
};

type RefBinding = {
  kind: "ref";
  path: number[];
  expression: string;
};

type ModelBinding = {
  kind: "model";
  path: number[];
  property: "value" | "checked";
  expression: string;
  read?: ExpressionReader;
  write?: ExpressionWriter;
};

type NestedListBinding = {
  kind: "list";
  signature?: string;
  path: number[];
  each: string;
  read?: ExpressionReader;
  key: string;
  keyRead?: ExpressionReader;
  keyReadItem?: (item: unknown) => unknown;
  itemName: string;
  indexName?: string;
  updatePolicy?: "always" | "reference";
  templateHtml: string;
  bindings: Binding[];
};

type NestedConditionalBinding = {
  kind: "if";
  signature?: string;
  path: number[];
  test: string;
  read?: ExpressionReader;
  templateHtml: string;
  bindings: Binding[];
};

type Binding =
  | TextBinding
  | ClassBinding
  | EventBinding
  | AttributeBinding
  | StyleBinding
  | RefBinding
  | ModelBinding
  | NestedListBinding
  | NestedConditionalBinding;

type KeyedListOptions = {
  signature?: string;
  key: string;
  keyRead?: ExpressionReader;
  keyReadItem?: (item: unknown) => unknown;
  itemName: string;
  indexName?: string;
  updatePolicy?: "always" | "reference";
  scope?: Record<string, unknown>;
  templateHtml: string;
  bindings: Binding[];
};

type RowRecord = {
  key: PropertyKey;
  element: Element;
  nodes: Node[];
  scope: Record<string, unknown>;
  cleanups: Array<() => void>;
  refCleanups?: Map<number, () => void>;
  lastValues: unknown[];
  item: unknown;
  index: number;
  sourceScope: Record<string, unknown> | undefined;
  revision: Signal<number>;
};

type ListState = {
  signature: string;
  options: KeyedListOptions;
  templateHtml: string;
  records: Map<PropertyKey, RowRecord>;
  template: HTMLTemplateElement;
  elementIndices: number[];
  cleanups: Array<() => void>;
  ownerCleanupDispose: (() => void) | undefined;
};

type CleanupOutcome = { failed: false } | { failed: true; error: unknown };

type MoveBeforeElement = Element & {
  moveBefore?: (node: Node, child: Node | null) => void;
};

const listStates = new WeakMap<Element, ListState>();

const readPath = (scope: Record<string, unknown>, expression: string): unknown => {
  const parts = expression.split(".");
  let current: unknown = scope;
  for (const part of parts) {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
};

const readItemPath = (item: unknown, expression: string, itemName: string): unknown => {
  if (expression === itemName) {
    return item;
  }
  const prefix = `${itemName}.`;
  if (!expression.startsWith(prefix)) {
    return undefined;
  }
  return readPath(item as Record<string, unknown>, expression.slice(prefix.length));
};

const writePath = (scope: Record<string, unknown>, expression: string, value: unknown): void => {
  const parts = expression.split(".");
  const property = parts.pop();
  let current: unknown = scope;
  for (const part of parts) {
    current = current && typeof current === "object" ? (current as Record<string, unknown>)[part] : undefined;
  }
  if (property && current && typeof current === "object") {
    (current as Record<string, unknown>)[property] = value;
  }
};

const readBinding = (
  scope: Record<string, unknown>,
  binding: { expression: string; read?: ExpressionReader },
): unknown => read(binding.read ? binding.read(scope) : readPath(scope, binding.expression));

const readHandler = (scope: Record<string, unknown>, binding: EventBinding): unknown =>
  binding.read ? binding.read(scope) : readPath(scope, binding.handler);

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
    current = current.childNodes[index] as Node;
  }
  return current;
};

const nodeAtRecord = (record: RowRecord, path: readonly number[]): Node => {
  if (record.nodes.length <= 1) {
    return nodeAt(record.element, path);
  }
  const [firstIndex, ...rest] = path;
  const root = record.nodes[firstIndex ?? 0] ?? record.element;
  return nodeAt(root, rest);
};

const createTemplate = (templateHtml: string): HTMLTemplateElement => {
  const template = document.createElement("template");
  template.innerHTML = templateHtml;
  return template;
};

const optionsSignature = (options: KeyedListOptions): string =>
  options.signature ??
  JSON.stringify({
    key: options.key,
    itemName: options.itemName,
    indexName: options.indexName,
    updatePolicy: options.updatePolicy,
    templateHtml: options.templateHtml,
    bindings: options.bindings,
  });

const cleanupListState = (state: ListState): void => {
  state.ownerCleanupDispose?.();
  state.ownerCleanupDispose = undefined;
  let firstError: unknown;
  let failed = false;
  try {
    runCleanups(state.cleanups);
  } catch (error) {
    firstError = error;
    failed = true;
  }
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

const getListState = (container: Element, options: KeyedListOptions): ListState => {
  const current = listStates.get(container);
  if (current && current.options === options) {
    return current;
  }
  const signature = optionsSignature(options);
  if (current && current.signature === signature) {
    current.options = options;
    return current;
  }
  if (current) {
    cleanupOwnedSubtree(container);
  }
  const template = createTemplate(options.templateHtml);
  const elementIndices = Array.from(template.content.childNodes).flatMap((node, index) =>
    node instanceof Element ? [index] : [],
  );
  const next: ListState = {
    signature,
    options,
    templateHtml: options.templateHtml,
    records: new Map<PropertyKey, RowRecord>(),
    template,
    elementIndices,
    cleanups: [] as Array<() => void>,
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

const cleanupRecord = (record: RowRecord): void => {
  let firstError: unknown;
  let failed = false;
  try {
    runCleanups(record.cleanups);
  } catch (error) {
    firstError = error;
    failed = true;
  }
  const refCleanups = record.refCleanups ? Array.from(record.refCleanups.values()) : [];
  record.refCleanups?.clear();
  try {
    runCleanups(refCleanups);
  } catch (error) {
    if (!failed) firstError = error;
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

const shouldApplyValue = (record: RowRecord, index: number, value: unknown): boolean => {
  if (Object.is(record.lastValues[index], value)) {
    return false;
  }
  record.lastValues[index] = value;
  return true;
};

const applyRowBinding = (
  record: RowRecord,
  scope: Record<string, unknown>,
  options: KeyedListOptions,
  binding: Binding,
  index: number,
): void => {
  record.revision();
  if (binding.kind === "text") {
    const value = readBinding(scope, binding);
    if (shouldApplyValue(record, index, value)) {
      setText(nodeAtRecord(record, binding.path) as Text, value);
    }
  } else if (binding.kind === "class") {
    const value = readBinding(scope, binding);
    if (shouldApplyValue(record, index, value)) {
      setClassPresence(nodeAtRecord(record, binding.path) as Element, binding.className, value);
    }
  } else if (binding.kind === "attr") {
    const value = readBinding(scope, binding);
    if (shouldApplyValue(record, index, value)) {
      setAttributeValue(nodeAtRecord(record, binding.path) as Element, binding.name, value);
    }
  } else if (binding.kind === "style") {
    const value = readBinding(scope, binding);
    if (shouldApplyValue(record, index, value)) {
      setStyleValue(nodeAtRecord(record, binding.path) as Element, binding.name, value);
    }
  } else if (binding.kind === "ref") {
    record.refCleanups?.get(index)?.();
    const refCleanups = record.refCleanups ?? (record.refCleanups = new Map());
    refCleanups.set(index, setRef(scope, binding.expression, nodeAtRecord(record, binding.path) as Element));
  } else if (binding.kind === "model") {
    const value = readBinding(scope, binding);
    if (shouldApplyValue(record, index, value)) {
      setControlValue(
        nodeAtRecord(record, binding.path) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
        binding.property,
        value,
      );
    }
  } else if (binding.kind === "list") {
    const eachBinding = binding.read ? { expression: binding.each, read: binding.read } : { expression: binding.each };
    const value = readBinding(scope, eachBinding) as readonly unknown[] | undefined;
    const container = nodeAtRecord(record, binding.path);
    if (container instanceof Element) {
      mountKeyedList(container, [], value, { ...binding, scope });
    }
  } else if (binding.kind === "if") {
    const testBinding = binding.read ? { expression: binding.test, read: binding.read } : { expression: binding.test };
    const value = readBinding(scope, testBinding);
    mountConditional(nodeAtRecord(record, binding.path), [], value, scope, binding);
  }
};

const bindRowBindings = (record: RowRecord, options: KeyedListOptions): void => {
  const rowBindings = options.bindings
    .map((binding, index) => ({ binding, index }))
    .filter(
      (entry): entry is { binding: Exclude<Binding, EventBinding>; index: number } => entry.binding.kind !== "event",
    );
  if (rowBindings.length === 0) {
    return;
  }
  record.cleanups.push(
    untrack(() =>
      effect(() => {
        for (const { binding, index } of rowBindings) {
          applyRowBinding(record, record.scope, options, binding, index);
        }
      }),
    ),
  );
};

const bindRowEvents = (record: RowRecord, options: KeyedListOptions): void => {
  const delegateKeys = new Set<string>();
  for (const binding of options.bindings) {
    if (binding.kind !== "event") {
      continue;
    }
    const delegateKey = `${binding.eventName}:${binding.path.join(".")}:${binding.handler}`;
    if (delegateKeys.has(delegateKey)) {
      continue;
    }
    delegateKeys.add(delegateKey);
    const target = nodeAtRecord(record, binding.path);
    if (!(target instanceof Element)) {
      continue;
    }
    const listener: EventListener = (event) => {
      const handler = readHandler(record.scope, binding);
      if (typeof handler === "function") {
        (handler as EventListener)(event);
      }
    };
    target.addEventListener(binding.eventName, listener);
    record.cleanups.push(() => target.removeEventListener(binding.eventName, listener));
  }
};

const bindRowControls = (record: RowRecord, options: KeyedListOptions): void => {
  for (const binding of options.bindings) {
    if (binding.kind !== "model") {
      continue;
    }
    const element = nodeAtRecord(record, binding.path) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    record.cleanups.push(
      bindControl(
        element,
        binding.property,
        () => readBinding(record.scope, binding),
        (value) => {
          if (binding.write) {
            binding.write(record.scope, value);
            return;
          }
          const target = binding.read ? binding.read(record.scope) : readPath(record.scope, binding.expression);
          writeModelValue(target, value, () => writePath(record.scope, binding.expression, value));
        },
      ),
    );
  }
};

const keyFor = (item: unknown, index: number, options: KeyedListOptions): PropertyKey => {
  const key = options.keyReadItem
    ? options.keyReadItem(item)
    : options.keyRead
      ? options.keyRead(scopedItem(options.itemName, item, options.indexName, index, options.scope))
      : readItemPath(item, options.key, options.itemName);
  return normalizeListKey(read(key));
};

const isProductionEnvironment = (): boolean => typeof process !== "undefined" && process.env.NODE_ENV === "production";

const warnDuplicateKey = (key: PropertyKey, options: KeyedListOptions): void => {
  if (isProductionEnvironment() || typeof console.warn !== "function") {
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
  options: KeyedListOptions,
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
  if (!element) {
    return undefined;
  }
  const scope = scopedItem(options.itemName, item, options.indexName, index, options.scope);
  const record = {
    key,
    element,
    nodes,
    scope,
    cleanups: [],
    lastValues: [],
    item,
    index,
    sourceScope: options.scope,
    revision: createSignal(0),
  };
  try {
    bindRowEvents(record, options);
    bindRowBindings(record, options);
    untrack(() => bindRowControls(record, options));
    return record;
  } catch (error) {
    try {
      cleanupRecord(record);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "List row creation and cleanup failed.");
    } finally {
    }
    throw error;
  }
};

const updateRecord = (record: RowRecord, item: unknown, index: number, options: KeyedListOptions): void => {
  const scopeChanged = record.sourceScope !== options.scope;
  if (options.scope) {
    Object.assign(record.scope, options.scope);
  }
  record.scope[options.itemName] = item;
  if (options.indexName) record.scope[options.indexName] = index;
  const itemChanged = !Object.is(record.item, item);
  const indexChanged = record.index !== index;
  record.item = item;
  record.index = index;
  record.sourceScope = options.scope;
  if (options.updatePolicy === "reference" && !itemChanged && !indexChanged && !scopeChanged) {
    return;
  }
  record.revision.update((value) => value + 1);
};

const moveBefore = (container: Element, node: Node, before: Node | null): void => {
  const movableContainer = container as MoveBeforeElement;
  if (typeof movableContainer.moveBefore === "function") {
    try {
      movableContainer.moveBefore(node, before);
      return;
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "HierarchyRequestError")) {
        throw error;
      }
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
    if (value < 0) {
      continue;
    }
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((tails[middle] as number) < value) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    if (low > 0) {
      predecessors[index] = tailPositions[low - 1] as number;
    }
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
): void => {
  const previousOrder = new Map<PropertyKey, number>();
  Array.from(previousRecords.keys()).forEach((key, index) => previousOrder.set(key, index));
  const stablePositions = longestIncreasingSubsequencePositions(
    orderedRecords.map((record) => previousOrder.get(record.key) ?? -1),
  );
  let anchor: Node | null = null;
  for (let index = orderedRecords.length - 1; index >= 0; index--) {
    const record = orderedRecords[index] as RowRecord;
    if (stablePositions.has(index)) {
      anchor = record.nodes[0] ?? anchor;
      continue;
    }
    for (let nodeIndex = record.nodes.length - 1; nodeIndex >= 0; nodeIndex--) {
      const node = record.nodes[nodeIndex] as Node;
      if (node.parentNode !== container || node.nextSibling !== anchor) {
        moveBefore(container, node, anchor);
      }
      anchor = node;
    }
  }
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

export const mountKeyedList = (
  root: Element,
  path: readonly number[],
  items: readonly unknown[] | undefined,
  options: KeyedListOptions,
): void => {
  const container = nodeAt(root, path);
  if (!(container instanceof Element)) {
    return;
  }
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
  const serverElements = Array.from(container.children);
  const canAdoptServerRows =
    state.records.size === 0 &&
    state.elementIndices.length > 0 &&
    serverElements.length >= entries.length * state.elementIndices.length;
  try {
    for (const [entryIndex, entry] of entries.entries()) {
      const existing = state.records.get(entry.key);
      const adoptable = canAdoptServerRows
        ? serverElements.slice(entryIndex * state.elementIndices.length, (entryIndex + 1) * state.elementIndices.length)
        : undefined;
      const record = existing ?? createRecord(state, entry.key, entry.item, options, adoptable, entry.index);
      if (!record) {
        continue;
      }
      if (existing) {
        updateRecord(record, entry.item, entry.index, options);
      } else {
        createdRecords.push(record);
      }
      nextRecords.set(entry.key, record);
      orderedRecords.push(record);
    }
    if (canAdoptServerRows) {
      container.replaceChildren(...orderedRecords.flatMap((record) => record.nodes));
    } else if (canAppendWithoutMoving(nextRecords, orderedRecords, previousRecords)) {
      const previousKeys = new Set(previousRecords.keys());
      for (const record of orderedRecords) {
        if (!previousKeys.has(record.key)) container.append(...record.nodes);
      }
    } else {
      positionRecords(container, orderedRecords, previousRecords);
    }
    state.records = nextRecords;
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
      } finally {
      }
    }
    if (cleanupFailed) {
      throw new AggregateError([error, firstCleanupError], "List update and rollback failed.");
    }
    throw error;
  }
};
