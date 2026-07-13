import { setClassPresence } from "./class.js";
import { setAttributeValue, setRef, setStyleValue } from "./attr.js";
import { delegate } from "./event.js";
import { bindControl, setControlValue } from "./form.js";
import { mountKeyedList } from "./list.js";
import { setText } from "./text.js";

type TextBinding = {
  kind: "text";
  path: number[];
  expression: string;
  read?: (scope: Record<string, unknown>) => unknown;
};

type ClassBinding = {
  kind: "class";
  path: number[];
  className: string;
  expression: string;
  read?: (scope: Record<string, unknown>) => unknown;
};

type EventBinding = {
  kind: "event";
  path: number[];
  eventName: string;
  handler: string;
  read?: (scope: Record<string, unknown>) => unknown;
};

type AttributeBinding = {
  kind: "attr";
  path: number[];
  name: string;
  expression: string;
  read?: (scope: Record<string, unknown>) => unknown;
};

type StyleBinding = {
  kind: "style";
  path: number[];
  name: string;
  expression: string;
  read?: (scope: Record<string, unknown>) => unknown;
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
  read?: (scope: Record<string, unknown>) => unknown;
  write?: (scope: Record<string, unknown>, value: unknown) => void;
};

type NestedListBinding = {
  kind: "list";
  signature?: string;
  path: number[];
  each: string;
  key: string;
  keyRead?: (scope: Record<string, unknown>) => unknown;
  keyReadItem?: (item: unknown) => unknown;
  itemName: string;
  templateHtml: string;
  bindings: ConditionalBinding[];
  read?: (scope: Record<string, unknown>) => unknown;
};

type NestedConditionalBinding = {
  kind: "if";
  signature?: string;
  path: number[];
  test: string;
  templateHtml: string;
  bindings: ConditionalBinding[];
  read?: (scope: Record<string, unknown>) => unknown;
};

type ConditionalBinding =
  | TextBinding
  | ClassBinding
  | EventBinding
  | AttributeBinding
  | StyleBinding
  | RefBinding
  | ModelBinding
  | NestedListBinding
  | NestedConditionalBinding;

export type ConditionalOptions = {
  signature?: string;
  templateHtml: string;
  bindings: ConditionalBinding[];
};

type ConditionalState = {
  signature: string;
  nodes: Node[];
  cleanups: Array<() => void>;
  scope: Record<string, unknown>;
};

const states = new WeakMap<Comment, ConditionalState>();

export const nodeAt = (root: Node, path: readonly number[]): Node => {
  let current = root;
  for (const index of path) {
    current = current.childNodes[index] as Node;
  }
  return current;
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

const signatureFor = (options: ConditionalOptions): string => options.signature ?? JSON.stringify(options);

const readBinding = (
  scope: Record<string, unknown>,
  binding: Exclude<ConditionalBinding, EventBinding | RefBinding | NestedListBinding | NestedConditionalBinding>,
): unknown => (binding.read ? binding.read(scope) : readPath(scope, binding.expression));

const readExpression = (
  scope: Record<string, unknown>,
  expression: string,
  read: ((scope: Record<string, unknown>) => unknown) | undefined,
): unknown => (read ? read(scope) : readPath(scope, expression));

const readEvent = (scope: Record<string, unknown>, binding: EventBinding): unknown =>
  binding.read ? binding.read(scope) : readPath(scope, binding.handler);

const writeBinding = (scope: Record<string, unknown>, binding: ModelBinding, value: unknown): void => {
  if (binding.write) {
    binding.write(scope, value);
    return;
  }
  writePath(scope, binding.expression, value);
};

const cleanup = (state: ConditionalState): void => {
  for (const cleanupFn of state.cleanups) {
    cleanupFn();
  }
  state.cleanups.length = 0;
  for (const node of state.nodes) {
    node.parentNode?.removeChild(node);
  }
  state.nodes.length = 0;
};

const createNodes = (templateHtml: string): Node[] => {
  const template = document.createElement("template");
  template.innerHTML = templateHtml;
  return Array.from(template.content.childNodes).map((node) => node.cloneNode(true));
};

const nodeAtState = (state: ConditionalState, path: readonly number[]): Node => {
  if (state.nodes.length <= 1) return nodeAt(state.nodes[0] as Node, path);
  const [firstIndex, ...rest] = path;
  return nodeAt(state.nodes[firstIndex ?? 0] as Node, rest);
};

const bindNodes = (
  anchor: Comment,
  state: ConditionalState,
  scope: Record<string, unknown>,
  options: ConditionalOptions,
): void => {
  state.scope = scope;
  const firstElement = state.nodes.find((node): node is Element => node instanceof Element);
  if (!firstElement) {
    return;
  }
  for (const binding of options.bindings) {
    if (binding.kind === "text") {
      setText(nodeAtState(state, binding.path) as Text, readBinding(scope, binding));
    } else if (binding.kind === "class") {
      setClassPresence(nodeAtState(state, binding.path) as Element, binding.className, readBinding(scope, binding));
    } else if (binding.kind === "attr") {
      setAttributeValue(nodeAtState(state, binding.path) as Element, binding.name, readBinding(scope, binding));
    } else if (binding.kind === "style") {
      setStyleValue(nodeAtState(state, binding.path) as Element, binding.name, readBinding(scope, binding));
    } else if (binding.kind === "ref") {
      setRef(scope, binding.expression, nodeAtState(state, binding.path) as Element);
    } else if (binding.kind === "model") {
      setControlValue(
        nodeAtState(state, binding.path) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
        binding.property,
        readBinding(scope, binding),
      );
    } else if (binding.kind === "list") {
      const container = nodeAtState(state, binding.path);
      if (!(container instanceof Element)) continue;
      mountKeyedList(
        container,
        [],
        readExpression(scope, binding.each, binding.read) as readonly unknown[] | undefined,
        { ...binding, scope },
      );
    } else if (binding.kind === "if") {
      mountConditional(nodeAtState(state, binding.path), [], readExpression(scope, binding.test, binding.read), scope, binding);
    }
  }
  if (state.cleanups.length === 0) {
    for (const binding of options.bindings) {
      if (binding.kind === "event") {
        const target = nodeAtState(state, binding.path);
        if (!(target instanceof Element)) continue;
        const listener: EventListener = (event) => {
          const handler = readEvent(state.scope, binding);
          if (typeof handler === "function") {
            (handler as EventListener)(event);
          }
        };
        state.cleanups.push(delegate(target, binding.eventName, [], listener));
      } else if (binding.kind === "model") {
        const element = nodeAtState(state, binding.path) as
          | HTMLInputElement
          | HTMLSelectElement
          | HTMLTextAreaElement;
        state.cleanups.push(
          bindControl(
            element,
            binding.property,
            () => readBinding(scope, binding),
            (value) => writeBinding(scope, binding, value),
          ),
        );
      }
    }
  }
  if (!firstElement.isConnected) {
    anchor.after(...state.nodes);
  }
};

export const mountConditional = (
  root: Node,
  path: readonly number[],
  visible: unknown,
  scope: Record<string, unknown>,
  options: ConditionalOptions,
): void => {
  const anchor = nodeAt(root, path);
  if (!(anchor instanceof Comment)) {
    return;
  }
  const signature = signatureFor(options);
  const current = states.get(anchor);
  if (!visible) {
    if (current) {
      cleanup(current);
      states.delete(anchor);
    }
    return;
  }
  const state =
    current && current.signature === signature
      ? current
      : {
          signature,
          nodes: createNodes(options.templateHtml),
          cleanups: [],
          scope,
        };
  states.set(anchor, state);
  bindNodes(anchor, state, scope, options);
};
