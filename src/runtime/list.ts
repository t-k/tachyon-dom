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

const nodeAt = (root: Node, path: readonly number[]): Node => {
  let current = root;
  for (const index of path) {
    current = current.childNodes[index] as Node;
  }
  return current;
};

const bindRow = (row: Element, item: unknown, options: KeyedListOptions): void => {
  const scope = { [options.itemName]: item } as Record<string, unknown>;
  for (const binding of options.bindings) {
    if (binding.kind === "text") {
      setText(textAt(row, binding.path), readPath(scope, binding.expression));
    } else if (binding.kind === "class") {
      setClassPresence(nodeAt(row, binding.path) as Element, binding.className, readPath(scope, binding.expression));
    } else {
      const handler = readPath(scope, binding.handler);
      if (typeof handler === "function") {
        delegate(row, binding.eventName, binding.path, handler as EventListener);
      }
    }
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
  container.textContent = "";
  if (!items) {
    return;
  }
  const template = document.createElement("template");
  template.innerHTML = options.templateHtml;
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const row = template.content.firstElementChild?.cloneNode(true);
    if (row instanceof Element) {
      bindRow(row, item, options);
      fragment.appendChild(row);
    }
  }
  container.appendChild(fragment);
};
