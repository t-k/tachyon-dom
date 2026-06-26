import { elementAt, setClassPresence } from "./class.js";
import { setAttributeValue, setRef, setStyleValue } from "./attr.js";
import { delegate } from "./event.js";
import { bindControl, setControlValue } from "./form.js";
import { setText, textAt } from "./text.js";

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

type ConditionalBinding =
  | TextBinding
  | ClassBinding
  | EventBinding
  | AttributeBinding
  | StyleBinding
  | RefBinding
  | ModelBinding;

export type ConditionalOptions = {
  templateHtml: string;
  bindings: ConditionalBinding[];
};

type ConditionalState = {
  signature: string;
  nodes: Node[];
  cleanups: Array<() => void>;
};

const states = new WeakMap<Comment, ConditionalState>();

const nodeAt = (root: Node, path: readonly number[]): Node => {
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

const signatureFor = (options: ConditionalOptions): string => JSON.stringify(options);

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

const bindNodes = (
  anchor: Comment,
  state: ConditionalState,
  scope: Record<string, unknown>,
  options: ConditionalOptions,
): void => {
  const firstElement = state.nodes.find((node): node is Element => node instanceof Element);
  if (!firstElement) {
    return;
  }
  for (const binding of options.bindings) {
    if (binding.kind === "text") {
      setText(textAt(firstElement, binding.path), readPath(scope, binding.expression));
    } else if (binding.kind === "class") {
      setClassPresence(elementAt(firstElement, binding.path), binding.className, readPath(scope, binding.expression));
    } else if (binding.kind === "attr") {
      setAttributeValue(elementAt(firstElement, binding.path), binding.name, readPath(scope, binding.expression));
    } else if (binding.kind === "style") {
      setStyleValue(elementAt(firstElement, binding.path), binding.name, readPath(scope, binding.expression));
    } else if (binding.kind === "ref") {
      setRef(scope, binding.expression, elementAt(firstElement, binding.path));
    } else if (binding.kind === "model") {
      setControlValue(
        elementAt(firstElement, binding.path) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
        binding.property,
        readPath(scope, binding.expression),
      );
    }
  }
  if (state.cleanups.length === 0) {
    for (const binding of options.bindings) {
      if (binding.kind === "event") {
        const handler = readPath(scope, binding.handler);
        if (typeof handler === "function") {
          state.cleanups.push(delegate(firstElement, binding.eventName, binding.path, handler as EventListener));
        }
      } else if (binding.kind === "model") {
        const element = elementAt(firstElement, binding.path) as
          | HTMLInputElement
          | HTMLSelectElement
          | HTMLTextAreaElement;
        state.cleanups.push(
          bindControl(
            element,
            binding.property,
            () => readPath(scope, binding.expression),
            (value) => writePath(scope, binding.expression, value),
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
  root: Element,
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
        };
  states.set(anchor, state);
  bindNodes(anchor, state, scope, options);
};
