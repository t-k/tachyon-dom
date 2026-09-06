import { setAttributeValue, setStyleValue } from "./attr.js";
import { setClassPresence } from "./class.js";
import { delegate } from "./event.js";
import { onOwnerCleanup, read } from "./signal.js";
import { cleanupOwnedSubtree, registerOwnedSubtree, runCleanups } from "./subtree.js";
import { setText } from "./text.js";

type ExpressionReader = (scope: Record<string, unknown>) => unknown;

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

type ConditionalCoreBinding = TextBinding | ClassBinding | EventBinding | AttributeBinding | StyleBinding;

export type ConditionalCoreOptions = {
  signature?: string;
  templateHtml: string;
  bindings: ConditionalCoreBinding[];
};

type ConditionalCoreState = {
  signature: string;
  anchor: Comment;
  nodes: Node[];
  scope: Record<string, unknown>;
  cleanups: Array<() => void>;
};

type AnchorResolution = {
  anchor: Comment;
  adoptedNodes: Node[] | undefined;
};

const states = new WeakMap<Comment, ConditionalCoreState>();
const ownerCleanupDisposers = new WeakMap<Comment, () => void>();

const isHydrationMarker = (node: Node): boolean =>
  node.nodeType === Node.COMMENT_NODE && (node.nodeValue ?? "").startsWith("tachyon-hydrate:");

const logicalChildren = (node: Node): Node[] =>
  Array.from(node.childNodes).filter((child) => !isHydrationMarker(child));

const childAt = (node: Node, index: number): Node | undefined => logicalChildren(node)[index];

const nodeAt = (root: Node, path: readonly number[]): Node | undefined => {
  let current: Node | undefined = root;
  for (const index of path) {
    current = current ? childAt(current, index) : undefined;
  }
  return current;
};

const parentAndIndexAt = (root: Node, path: readonly number[]): { parent: Node; index: number } | undefined => {
  if (path.length === 0) {
    return root.parentNode
      ? { parent: root.parentNode, index: logicalChildren(root.parentNode).indexOf(root) }
      : undefined;
  }
  let parent: Node | undefined = root;
  for (const index of path.slice(0, -1)) parent = parent ? childAt(parent, index) : undefined;
  const index = path.at(-1);
  return parent && index !== undefined ? { parent, index } : undefined;
};

const createNodes = (templateHtml: string): Node[] => {
  const template = document.createElement("template");
  template.innerHTML = templateHtml;
  return Array.from(template.content.childNodes).map((node) => node.cloneNode(true));
};

const sameNodeShape = (expected: Node, actual: Node): boolean => {
  if (expected.nodeType !== actual.nodeType) return false;
  if (expected instanceof Element && actual instanceof Element) {
    return expected.localName === actual.localName;
  }
  return expected.nodeType === Node.TEXT_NODE || expected.nodeType === Node.COMMENT_NODE;
};

const adoptableNodes = (parent: Node, index: number, expected: readonly Node[]): Node[] | undefined => {
  if (expected.length === 0) return undefined;
  const actual = logicalChildren(parent).slice(index, index + expected.length);
  return actual.length === expected.length &&
    expected.every((node, nodeIndex) => sameNodeShape(node, actual[nodeIndex] as Node))
    ? actual
    : undefined;
};

const resolveAnchor = (
  root: Node,
  path: readonly number[],
  visible: unknown,
  templateHtml: string,
): AnchorResolution | undefined => {
  const existing = nodeAt(root, path);
  if (existing instanceof Comment && !isHydrationMarker(existing)) {
    return { anchor: existing, adoptedNodes: undefined };
  }
  const location = parentAndIndexAt(root, path);
  if (!location) return undefined;
  const expected = createNodes(templateHtml);
  const adoptedNodes = adoptableNodes(location.parent, location.index, expected);
  const anchor = document.createComment("");
  const actualChildren = logicalChildren(location.parent);
  const before = adoptedNodes?.[0] ?? actualChildren[location.index] ?? null;
  location.parent.insertBefore(anchor, before);
  if (!visible && adoptedNodes) {
    for (const node of adoptedNodes) {
      cleanupOwnedSubtree(node);
      node.parentNode?.removeChild(node);
    }
    return { anchor, adoptedNodes: undefined };
  }
  return { anchor, adoptedNodes };
};

const readPath = (scope: Record<string, unknown>, expression: string): unknown => {
  let current: unknown = scope;
  for (const part of expression.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
};

const readBinding = (scope: Record<string, unknown>, binding: Exclude<ConditionalCoreBinding, EventBinding>): unknown =>
  read(binding.read ? binding.read(scope) : readPath(scope, binding.expression));

const cleanupState = (state: ConditionalCoreState): void => {
  let firstError: unknown;
  let failed = false;
  try {
    runCleanups(state.cleanups);
  } catch (error) {
    firstError = error;
    failed = true;
  }
  for (const node of state.nodes) {
    try {
      cleanupOwnedSubtree(node);
    } catch (error) {
      if (!failed) firstError = error;
      failed = true;
    } finally {
      node.parentNode?.removeChild(node);
    }
  }
  state.nodes.length = 0;
  if (failed) throw firstError;
};

const detachOwnerCleanup = (anchor: Comment): void => {
  ownerCleanupDisposers.get(anchor)?.();
  ownerCleanupDisposers.delete(anchor);
};

const disposeState = (anchor: Comment, state: ConditionalCoreState): void => {
  if (states.get(anchor) !== state) return;
  states.delete(anchor);
  detachOwnerCleanup(anchor);
  cleanupState(state);
};

const nodeAtState = (state: ConditionalCoreState, path: readonly number[]): Node | undefined => {
  if (state.nodes.length <= 1) return nodeAt(state.nodes[0] as Node, path);
  const [firstIndex, ...rest] = path;
  return nodeAt(state.nodes[firstIndex ?? 0] as Node, rest);
};

const bindNodes = (state: ConditionalCoreState, options: ConditionalCoreOptions, bindEvents: boolean): void => {
  for (const binding of options.bindings) {
    const node = nodeAtState(state, binding.path);
    if (!node) continue;
    if (binding.kind === "text") {
      setText(node as Text, readBinding(state.scope, binding));
    } else if (binding.kind === "class") {
      setClassPresence(node as Element, binding.className, readBinding(state.scope, binding));
    } else if (binding.kind === "attr") {
      setAttributeValue(node as Element, binding.name, readBinding(state.scope, binding));
    } else if (binding.kind === "style") {
      setStyleValue(node as Element, binding.name, readBinding(state.scope, binding));
    } else if (bindEvents) {
      const element = node as Element;
      if (!(element instanceof Element)) continue;
      const listener: EventListener = (event) => {
        const handler = binding.read ? binding.read(state.scope) : readPath(state.scope, binding.handler);
        if (typeof handler === "function") (handler as EventListener)(event);
      };
      state.cleanups.push(delegate(element, binding.eventName, [], listener));
    }
  }
};

const signatureFor = (options: ConditionalCoreOptions): string => options.signature ?? JSON.stringify(options);

/** Mounts a compiler-proven conditional that only contains text, class, attr, style, and event bindings. */
export const mountConditionalCore = (
  root: Node,
  path: readonly number[],
  visible: unknown,
  scope: Record<string, unknown>,
  options: ConditionalCoreOptions,
): void => {
  const resolution = resolveAnchor(root, path, visible, options.templateHtml);
  if (!resolution) return;
  const { anchor, adoptedNodes } = resolution;
  const current = states.get(anchor);
  if (!visible) {
    if (current) {
      try {
        cleanupOwnedSubtree(anchor);
      } finally {
        states.delete(anchor);
        detachOwnerCleanup(anchor);
      }
    }
    return;
  }
  const signature = signatureFor(options);
  if (current && current.signature !== signature) cleanupOwnedSubtree(anchor);
  const state =
    current && current.signature === signature
      ? current
      : {
          signature,
          anchor,
          nodes: adoptedNodes ?? createNodes(options.templateHtml),
          scope,
          cleanups: [],
        };
  states.set(anchor, state);
  if (state !== current) {
    if (!adoptedNodes) anchor.after(...state.nodes);
    registerOwnedSubtree(anchor, () => disposeState(anchor, state));
    const disposer = onOwnerCleanup(() => cleanupOwnedSubtree(anchor));
    if (disposer) ownerCleanupDisposers.set(anchor, disposer);
  } else {
    state.scope = scope;
  }
  bindNodes(state, options, state !== current);
};
