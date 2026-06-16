import { setClassPresence } from "./class";
import { setAttributeValue, setRef, setStyleValue } from "./attr";
import { setText, textAt } from "./text";
import { bindControl, setControlValue } from "./form";

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

type AttributeBinding = {
  kind: "attr";
  path: number[];
  name: string;
  expression: string;
};

type StyleBinding = {
  kind: "style";
  path: number[];
  name: string;
  expression: string;
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
};

type Binding = TextBinding | ClassBinding | EventBinding | AttributeBinding | StyleBinding | RefBinding | ModelBinding;

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
  signature: string;
  templateHtml: string;
  records: Map<PropertyKey, RowRecord>;
  recordsByElement: WeakMap<Element, RowRecord>;
  template: HTMLTemplateElement;
  cleanups: Array<() => void>;
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

const optionsSignature = (options: KeyedListOptions): string =>
  JSON.stringify({
    key: options.key,
    itemName: options.itemName,
    templateHtml: options.templateHtml,
    bindings: options.bindings,
  });

const cleanupListState = (state: ListState): void => {
  for (const cleanup of state.cleanups) {
    cleanup();
  }
  state.cleanups.length = 0;
  state.records.forEach(cleanupRecord);
  state.records.clear();
};

const rowElementFromEvent = (container: Element, event: Event): Element | undefined => {
  let current = event.target instanceof Node ? event.target : undefined;
  while (current && current.parentNode !== container) {
    current = current.parentNode ?? undefined;
  }
  return current instanceof Element ? current : undefined;
};

const bindListEvents = (container: Element, state: ListState, options: KeyedListOptions): Array<() => void> => {
  const cleanups: Array<() => void> = [];
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
    const listener: EventListener = (event) => {
      const row = rowElementFromEvent(container, event);
      if (!row) {
        return;
      }
      const target = nodeAt(row, binding.path);
      if (!(event.target instanceof Node) || !target.contains(event.target)) {
        return;
      }
      const record = state.recordsByElement.get(row);
      const handler = record ? readPath(record.scope, binding.handler) : undefined;
      if (typeof handler === "function") {
        (handler as EventListener)(event);
      }
    };
    container.addEventListener(binding.eventName, listener);
    cleanups.push(() => container.removeEventListener(binding.eventName, listener));
  }
  return cleanups;
};

const getListState = (container: Element, options: KeyedListOptions): ListState => {
  const signature = optionsSignature(options);
  const current = listStates.get(container);
  if (current && current.signature === signature) {
    return current;
  }
  if (current) {
    cleanupListState(current);
  }
  const next = {
    signature,
    templateHtml: options.templateHtml,
    records: new Map<PropertyKey, RowRecord>(),
    recordsByElement: new WeakMap<Element, RowRecord>(),
    template: createTemplate(options.templateHtml),
    cleanups: [] as Array<() => void>,
  };
  next.cleanups = bindListEvents(container, next, options);
  listStates.set(container, next);
  return next;
};

const cleanupRecord = (record: RowRecord): void => {
  for (const cleanup of record.cleanups) {
    cleanup();
  }
  record.cleanups.length = 0;
  record.element.remove();
};

const applyRowBindings = (row: Element, scope: Record<string, unknown>, options: KeyedListOptions): void => {
  for (const binding of options.bindings) {
    if (binding.kind === "text") {
      setText(textAt(row, binding.path), readPath(scope, binding.expression));
    } else if (binding.kind === "class") {
      setClassPresence(nodeAt(row, binding.path) as Element, binding.className, readPath(scope, binding.expression));
    } else if (binding.kind === "attr") {
      setAttributeValue(nodeAt(row, binding.path) as Element, binding.name, readPath(scope, binding.expression));
    } else if (binding.kind === "style") {
      setStyleValue(nodeAt(row, binding.path) as Element, binding.name, readPath(scope, binding.expression));
    } else if (binding.kind === "ref") {
      setRef(scope, binding.expression, nodeAt(row, binding.path) as Element);
    } else if (binding.kind === "model") {
      setControlValue(
        nodeAt(row, binding.path) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
        binding.property,
        readPath(scope, binding.expression),
      );
    }
  }
};

const bindRowControls = (record: RowRecord, options: KeyedListOptions): void => {
  for (const binding of options.bindings) {
    if (binding.kind !== "model") {
      continue;
    }
    const element = nodeAt(record.element, binding.path) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    record.cleanups.push(
      bindControl(
        element,
        binding.property,
        () => readPath(record.scope, binding.expression),
        (value) => {
          const parts = binding.expression.split(".");
          const property = parts.pop();
          let current: unknown = record.scope;
          for (const part of parts) {
            current = current && typeof current === "object" ? (current as Record<string, unknown>)[part] : undefined;
          }
          if (property && current && typeof current === "object") {
            (current as Record<string, unknown>)[property] = value;
          }
        },
      ),
    );
  }
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
  existingElement?: Element,
): RowRecord | undefined => {
  const row = existingElement ?? state.template.content.firstElementChild?.cloneNode(true);
  if (!(row instanceof Element)) {
    return undefined;
  }
  const scope = scopedItem(options.itemName, item);
  const record = {
    key,
    element: row,
    scope,
    cleanups: [],
  };
  state.recordsByElement.set(row, record);
  applyRowBindings(record.element, record.scope, options);
  bindRowControls(record, options);
  return record;
};

const updateRecord = (record: RowRecord, item: unknown, options: KeyedListOptions): void => {
  record.scope[options.itemName] = item;
  applyRowBindings(record.element, record.scope, options);
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
      state.recordsByElement.delete(record.element);
    });
    state.records.clear();
    return;
  }
  const nextRecords = new Map<PropertyKey, RowRecord>();
  const orderedRecords: RowRecord[] = [];
  const canAdoptServerRows = state.records.size === 0 && container.children.length > 0;
  for (const item of items) {
    const key = keyFor(item, options);
    const existing = state.records.get(key);
    const adoptable = canAdoptServerRows ? container.children[orderedRecords.length] : undefined;
    const record = existing ?? createRecord(state, key, item, options, adoptable);
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
      state.recordsByElement.delete(record.element);
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
