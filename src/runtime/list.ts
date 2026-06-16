import { setClassPresence } from "./class";
import { delegate } from "./event";
import { setText, textAt } from "./text";

type TextBinding = {
  kind: "text";
  path: number[];
  expression: string;
};

type ClassBinding = {
  kind: "class";
  path: number[];
  className: string;
  expression: string;
};

type EventBinding = {
  kind: "event";
  path: number[];
  eventName: string;
  handler: string;
};

type Binding = TextBinding | ClassBinding | EventBinding;

type KeyedListOptions = {
  key: string;
  itemName: string;
  templateHtml: string;
  bindings: Binding[];
};

type RowRecord = {
  key: PropertyKey;
  element: Element;
  scope: Record<string, unknown>;
  cleanups: Array<() => void>;
};

type ListState = {
  templateHtml: string;
  records: Map<PropertyKey, RowRecord>;
  template: HTMLTemplateElement;
};

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

const scopedItem = (itemName: string, item: unknown): Record<string, unknown> => ({ [itemName]: item });

const nodeAt = (root: Node, path: readonly number[]): Node => {
  let current = root;
  for (const index of path) {
    current = current.childNodes[index] as Node;
  }
  return current;
};

const createTemplate = (templateHtml: string): HTMLTemplateElement => {
  const template = document.createElement("template");
  template.innerHTML = templateHtml;
  return template;
};

const getListState = (container: Element, options: KeyedListOptions): ListState => {
  const current = listStates.get(container);
  if (current && current.templateHtml === options.templateHtml) {
    return current;
  }
  current?.records.forEach((record) => cleanupRecord(record));
  const next = {
    templateHtml: options.templateHtml,
    records: new Map<PropertyKey, RowRecord>(),
    template: createTemplate(options.templateHtml),
  };
  listStates.set(container, next);
  return next;
};

const cleanupRecord = (record: RowRecord): void => {
  for (const cleanup of record.cleanups) {
    cleanup();
  }
  record.cleanups.length = 0;
};

const applyRowBindings = (row: Element, scope: Record<string, unknown>, options: KeyedListOptions): void => {
  for (const binding of options.bindings) {
    if (binding.kind === "text") {
      setText(textAt(row, binding.path), readPath(scope, binding.expression));
    } else if (binding.kind === "class") {
      setClassPresence(nodeAt(row, binding.path) as Element, binding.className, readPath(scope, binding.expression));
    }
  }
};

const bindRowEvents = (row: Element, scope: Record<string, unknown>, options: KeyedListOptions): Array<() => void> => {
  const cleanups: Array<() => void> = [];
  for (const binding of options.bindings) {
    if (binding.kind !== "event") {
      continue;
    }
    const listener: EventListener = (event) => {
      const handler = readPath(scope, binding.handler);
      if (typeof handler === "function") {
        (handler as EventListener)(event);
      }
    };
    cleanups.push(delegate(row, binding.eventName, binding.path, listener));
  }
  return cleanups;
};

const keyFor = (item: unknown, options: KeyedListOptions): PropertyKey => {
  const key = readPath(scopedItem(options.itemName, item), options.key);
  if (typeof key === "string" || typeof key === "number" || typeof key === "symbol") {
    return key;
  }
  return String(key);
};

const createRecord = (
  state: ListState,
  key: PropertyKey,
  item: unknown,
  options: KeyedListOptions,
): RowRecord | undefined => {
  const row = state.template.content.firstElementChild?.cloneNode(true);
  if (!(row instanceof Element)) {
    return undefined;
  }
  const scope = scopedItem(options.itemName, item);
  const record = {
    key,
    element: row,
    scope,
    cleanups: [] as Array<() => void>,
  };
  applyRowBindings(record.element, record.scope, options);
  record.cleanups = bindRowEvents(record.element, record.scope, options);
  return record;
};

const updateRecord = (record: RowRecord, item: unknown, options: KeyedListOptions): void => {
  record.scope[options.itemName] = item;
  applyRowBindings(record.element, record.scope, options);
};

const moveBefore = (container: Element, node: Node, before: Node | null): void => {
  const movableContainer = container as MoveBeforeElement;
  if (typeof movableContainer.moveBefore === "function") {
    movableContainer.moveBefore(node, before);
  } else {
    container.insertBefore(node, before);
  }
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
  if (!items) {
    state.records.forEach((record) => {
      cleanupRecord(record);
      record.element.remove();
    });
    state.records.clear();
    return;
  }
  const nextRecords = new Map<PropertyKey, RowRecord>();
  const orderedRecords: RowRecord[] = [];
  for (const item of items) {
    const key = keyFor(item, options);
    const existing = state.records.get(key);
    const record = existing ?? createRecord(state, key, item, options);
    if (!record) {
      continue;
    }
    updateRecord(record, item, options);
    nextRecords.set(key, record);
    orderedRecords.push(record);
  }
  state.records.forEach((record, key) => {
    if (!nextRecords.has(key)) {
      cleanupRecord(record);
      record.element.remove();
    }
  });
  for (let index = 0; index < orderedRecords.length; index++) {
    const record = orderedRecords[index] as RowRecord;
    const currentNode = container.childNodes[index] ?? null;
    if (currentNode !== record.element) {
      moveBefore(container, record.element, currentNode);
    }
  }
  state.records = nextRecords;
};
