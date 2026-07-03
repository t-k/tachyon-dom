import { setClassPresence } from "./class.js";
import { setAttributeValue, setRef, setStyleValue } from "./attr.js";
import { setText } from "./text.js";
import { bindControl, setControlValue } from "./form.js";

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

type Binding = TextBinding | ClassBinding | EventBinding | AttributeBinding | StyleBinding | RefBinding | ModelBinding;

type KeyedListOptions = {
  signature?: string;
  key: string;
  keyRead?: ExpressionReader;
  itemName: string;
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
  lastValues: unknown[];
};

type ListState = {
  signature: string;
  options: KeyedListOptions;
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
): unknown => (binding.read ? binding.read(scope) : readPath(scope, binding.expression));

const readHandler = (scope: Record<string, unknown>, binding: EventBinding): unknown =>
  binding.read ? binding.read(scope) : readPath(scope, binding.handler);

const scopedItem = (
  itemName: string,
  item: unknown,
  scope: Record<string, unknown> | undefined,
): Record<string, unknown> => ({ ...scope, [itemName]: item });

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
      const record = state.recordsByElement.get(row);
      const target = record ? nodeAtRecord(record, binding.path) : nodeAt(row, binding.path);
      if (!(event.target instanceof Node) || !(target instanceof Element) || !target.contains(event.target)) {
        return;
      }
      const handler = record ? readHandler(record.scope, binding) : undefined;
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
    cleanupListState(current);
  }
  const next = {
    signature,
    options,
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
  for (const node of record.nodes) {
    node.parentNode?.removeChild(node);
  }
};

const shouldApplyValue = (record: RowRecord, index: number, value: unknown): boolean => {
  if (Object.is(record.lastValues[index], value)) {
    return false;
  }
  record.lastValues[index] = value;
  return true;
};

const applyRowBindings = (record: RowRecord, scope: Record<string, unknown>, options: KeyedListOptions): void => {
  for (let index = 0; index < options.bindings.length; index++) {
    const binding = options.bindings[index] as Binding;
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
      setRef(scope, binding.expression, nodeAtRecord(record, binding.path) as Element);
    } else if (binding.kind === "model") {
      const value = readBinding(scope, binding);
      if (shouldApplyValue(record, index, value)) {
        setControlValue(
          nodeAtRecord(record, binding.path) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
          binding.property,
          value,
        );
      }
    }
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
          writePath(record.scope, binding.expression, value);
        },
      ),
    );
  }
};

const keyFor = (item: unknown, options: KeyedListOptions): PropertyKey => {
  const scope = scopedItem(options.itemName, item, options.scope);
  const key = options.keyRead ? options.keyRead(scope) : readPath(scope, options.key);
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
  const nodes = existingElement
    ? [existingElement]
    : Array.from(state.template.content.childNodes).map((node) => node.cloneNode(true));
  const element = nodes.find((node): node is Element => node instanceof Element);
  if (!element) {
    return undefined;
  }
  const scope = scopedItem(options.itemName, item, options.scope);
  const record = {
    key,
    element,
    nodes,
    scope,
    cleanups: [],
    lastValues: [],
  };
  for (const node of nodes) {
    if (node instanceof Element) {
      state.recordsByElement.set(node, record);
    }
  }
  applyRowBindings(record, record.scope, options);
  bindRowControls(record, options);
  return record;
};

const updateRecord = (record: RowRecord, item: unknown, options: KeyedListOptions): void => {
  if (options.scope) {
    Object.assign(record.scope, options.scope);
  }
  record.scope[options.itemName] = item;
  applyRowBindings(record, record.scope, options);
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
  const seenKeys = new Set<PropertyKey>();
  for (const item of items) {
    const key = keyFor(item, options);
    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);
    const existing = state.records.get(key);
    const adoptable = canAdoptServerRows ? container.children[orderedRecords.length] : undefined;
    const record = existing ?? createRecord(state, key, item, options, adoptable);
    if (!record) {
      continue;
    }
    if (existing) {
      updateRecord(record, item, options);
    }
    nextRecords.set(key, record);
    orderedRecords.push(record);
  }
  state.records.forEach((record, key) => {
    if (!nextRecords.has(key)) {
      cleanupRecord(record);
      for (const node of record.nodes) {
        if (node instanceof Element) {
          state.recordsByElement.delete(node);
        }
      }
    }
  });
  if (canAdoptServerRows) {
    for (const element of Array.from(container.children).slice(orderedRecords.length)) {
      element.parentNode?.removeChild(element);
    }
  }
  let elementIndex = 0;
  let nodeIndex = 0;
  for (let index = 0; index < orderedRecords.length; index++) {
    const record = orderedRecords[index] as RowRecord;
    for (const node of record.nodes) {
      const currentNode =
        node instanceof Element
          ? (container.children[elementIndex] ?? null)
          : (container.childNodes[nodeIndex] ?? null);
      if (currentNode !== node) {
        moveBefore(container, node, currentNode);
      }
      if (node instanceof Element) {
        elementIndex++;
      }
      nodeIndex++;
    }
  }
  state.records = nextRecords;
};
