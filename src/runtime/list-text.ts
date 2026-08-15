import { setText, textAt } from "./text.js";
import { createSignal, effect, onCleanup, untrack, type Signal } from "./signal.js";
import { cleanupOwnedSubtree, registerOwnedSubtree } from "./subtree.js";

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
  scope?: Record<string, unknown>;
  templateHtml: string;
  bindings: TextBinding[];
};

type RowRecord = {
  key: PropertyKey;
  element: Element;
  nodes: Node[];
  scope: Record<string, unknown>;
  cleanups: Array<() => void>;
  lastValues: unknown[];
  revision: Signal<number>;
};

type ListState = {
  signature: string;
  options: TextKeyedListOptions;
  records: Map<PropertyKey, RowRecord>;
  template: HTMLTemplateElement;
  elementIndices: number[];
  ownerCleanupRegistered: boolean;
};

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

const readItemPath = (item: unknown, expression: string, itemName: string): unknown => {
  if (expression === itemName) return item;
  const prefix = `${itemName}.`;
  if (!expression.startsWith(prefix)) return undefined;
  return readPath(item as Record<string, unknown>, expression.slice(prefix.length));
};

const scopedItem = (
  itemName: string,
  item: unknown,
  scope: Record<string, unknown> | undefined,
): Record<string, unknown> => ({ ...scope, [itemName]: item });

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

const optionsSignature = (options: TextKeyedListOptions): string =>
  options.signature ??
  JSON.stringify({
    key: options.key,
    itemName: options.itemName,
    templateHtml: options.templateHtml,
    bindings: options.bindings,
  });

const cleanupRecord = (record: RowRecord): void => {
  for (const cleanup of record.cleanups) cleanup();
  record.cleanups.length = 0;
  for (const node of record.nodes) {
    cleanupOwnedSubtree(node);
    node.parentNode?.removeChild(node);
  }
};

const cleanupListState = (state: ListState): void => {
  state.records.forEach(cleanupRecord);
  state.records.clear();
};

const getListState = (container: Element, options: TextKeyedListOptions): ListState => {
  const current = listStates.get(container);
  if (current && current.options === options) return current;
  const signature = optionsSignature(options);
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
    ownerCleanupRegistered: current?.ownerCleanupRegistered ?? false,
  };
  listStates.set(container, next);
  registerOwnedSubtree(container, () => {
    if (listStates.get(container) !== next) return;
    cleanupListState(next);
    listStates.delete(container);
  });
  if (!next.ownerCleanupRegistered) {
    next.ownerCleanupRegistered = true;
    onCleanup(() => cleanupOwnedSubtree(container));
  }
  return next;
};

const readBinding = (scope: Record<string, unknown>, binding: TextBinding): unknown =>
  binding.read ? binding.read(scope) : readPath(scope, binding.expression);

const bindRow = (record: RowRecord, options: TextKeyedListOptions): void => {
  if (options.bindings.length === 0) return;
  record.cleanups.push(
    untrack(() =>
      effect(() => {
        record.revision();
        for (let index = 0; index < options.bindings.length; index++) {
          const binding = options.bindings[index] as TextBinding;
          const value = readBinding(record.scope, binding);
          if (Object.is(record.lastValues[index], value)) continue;
          record.lastValues[index] = value;
          setText(textAtRecord(record, binding.path), value);
        }
      }),
    ),
  );
};

const keyFor = (item: unknown, options: TextKeyedListOptions): PropertyKey => {
  const key = options.keyReadItem
    ? options.keyReadItem(item)
    : options.keyRead
      ? options.keyRead(scopedItem(options.itemName, item, options.scope))
      : readItemPath(item, options.key, options.itemName);
  return typeof key === "string" || typeof key === "number" || typeof key === "symbol" ? key : String(key);
};

const warnDuplicateKey = (key: PropertyKey, options: TextKeyedListOptions): void => {
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
  options: TextKeyedListOptions,
  existingElements?: readonly Element[],
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
    scope: scopedItem(options.itemName, item, options.scope),
    cleanups: [],
    lastValues: [],
    revision: createSignal(0),
  };
  bindRow(record, options);
  return record;
};

const updateRecord = (record: RowRecord, item: unknown, options: TextKeyedListOptions): void => {
  if (options.scope) Object.assign(record.scope, options.scope);
  record.scope[options.itemName] = item;
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
      if (node.parentNode !== container || node.nextSibling !== anchor) moveBefore(container, node, anchor);
      anchor = node;
    }
  }
};

/** Releases a text-only list produced by the Tachyon DOM compiler. */
export const cleanupTextKeyedList = (root: Element, path: readonly number[]): void => {
  const container = nodeAt(root, path);
  if (container instanceof Element) cleanupOwnedSubtree(container);
};

/**
 * Mounts compiler-generated text-only rows. `templateHtml` must be trusted compiler output, never untrusted input.
 */
export const mountTextKeyedList = (
  root: Element,
  path: readonly number[],
  items: readonly unknown[] | undefined,
  options: TextKeyedListOptions,
): void => {
  const container = nodeAt(root, path);
  if (!(container instanceof Element)) return;
  const state = getListState(container, options);
  if (!items) {
    state.records.forEach(cleanupRecord);
    state.records.clear();
    return;
  }
  const nextRecords = new Map<PropertyKey, RowRecord>();
  const orderedRecords: RowRecord[] = [];
  const serverElements = Array.from(container.children);
  const canAdoptServerRows =
    state.records.size === 0 &&
    state.elementIndices.length > 0 &&
    serverElements.length >= items.length * state.elementIndices.length;
  const seenKeys = new Set<PropertyKey>();
  for (const item of items) {
    const key = keyFor(item, options);
    if (seenKeys.has(key)) {
      warnDuplicateKey(key, options);
      continue;
    }
    seenKeys.add(key);
    const existing = state.records.get(key);
    const adoptable = canAdoptServerRows
      ? serverElements.slice(
          orderedRecords.length * state.elementIndices.length,
          (orderedRecords.length + 1) * state.elementIndices.length,
        )
      : undefined;
    const record = existing ?? createRecord(state, key, item, options, adoptable);
    if (!record) continue;
    if (existing) updateRecord(record, item, options);
    nextRecords.set(key, record);
    orderedRecords.push(record);
  }
  state.records.forEach((record, key) => {
    if (!nextRecords.has(key)) cleanupRecord(record);
  });
  if (canAdoptServerRows) container.replaceChildren(...orderedRecords.flatMap((record) => record.nodes));
  else positionRecords(container, orderedRecords, state.records);
  state.records = nextRecords;
};
