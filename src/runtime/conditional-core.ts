import { setAttributeValue, setStyleValue } from "./attr.js";
import { setClassPresence } from "./class.js";
import { delegate } from "./event.js";
import { onOwnerCleanup, read } from "./signal.js";
import { cleanupOwnedSubtree, registerOwnedSubtree, runCleanups } from "./subtree.js";
import { setText, textAt } from "./text.js";
import {
  preparedConditionalNodeCount,
  registerPreparedAnchor,
  setPreparedConditionalNodeCount,
  setPreparedConditionalNodes,
  takePreparedConditionalNodes,
} from "./conditional-prepared.js";

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

export type ConditionalCoreAnchorDescriptor = {
  path: readonly number[];
  visible: unknown;
  templateHtml: string;
  parentTagName?: string;
};

type PreparedConditional = {
  path: readonly number[];
  key: string;
  parentKey: string;
  index: number;
  nodeCount: number;
};

type PreparedPathPlan = {
  byParent: Map<string, PreparedConditional[]>;
  modes: Map<string, "placeholder" | "expanded" | "omitted">;
  invalid: Set<string>;
};

const states = new WeakMap<Comment, ConditionalCoreState>();
const ownerCleanupDisposers = new WeakMap<Comment, () => void>();
const anchorsByRoot = new WeakMap<Node, Map<string, Comment>>();
const initialSnapshots = new WeakMap<Node, { topLevel: Node[]; nodes: Map<string, Node> }>();
const preparedPathPlans = new WeakMap<Node, PreparedPathPlan>();

const pathKey = (path: readonly number[]): string => path.join(".");

const isHydrationMarker = (node: Node): boolean =>
  node.nodeType === Node.COMMENT_NODE && (node.nodeValue ?? "").startsWith("tachyon-hydrate:");

const logicalChildren = (node: Node): Node[] =>
  Array.from(node.childNodes).filter((child) => !isHydrationMarker(child));

const snapshotNodes = (root: Node): Map<string, Node> => {
  const nodes = new Map<string, Node>();
  const visit = (node: Node, path: readonly number[]): void => {
    nodes.set(pathKey(path), node);
    for (const [index, child] of logicalChildren(node).entries()) visit(child, [...path, index]);
  };
  visit(root, []);
  return nodes;
};

const initialNodesFor = (root: Node): Map<string, Node> => {
  const currentTopLevel = logicalChildren(root);
  const anchors = anchorsByRoot.get(root);
  const hasAttachedAnchor = Array.from(anchors?.values() ?? []).some((anchor) => anchor.parentNode !== null);
  const previous = initialSnapshots.get(root);
  if (
    previous &&
    (hasAttachedAnchor ||
      (previous.topLevel.length === currentTopLevel.length &&
        previous.topLevel.every((node, index) => node === currentTopLevel[index])))
  ) {
    return previous.nodes;
  }
  const next = { topLevel: currentTopLevel, nodes: snapshotNodes(root) };
  initialSnapshots.set(root, next);
  return next.nodes;
};

const registeredAnchorFor = (root: Node, path: readonly number[]): Comment | undefined => {
  const anchors = anchorsByRoot.get(root);
  const key = pathKey(path);
  const anchor = anchors?.get(key);
  if (anchor?.parentNode) return anchor;
  anchors?.delete(key);
  return undefined;
};

const registerAnchor = (root: Node, path: readonly number[], anchor: Comment): void => {
  const anchors = anchorsByRoot.get(root) ?? new Map<string, Comment>();
  anchors.set(pathKey(path), anchor);
  anchorsByRoot.set(root, anchors);
  registerPreparedAnchor(root, pathKey(path), anchor);
};

const expectedNodeCount = (templateHtml: string): number => createNodes(templateHtml).length;

const orderedPreparedConditionals = (descriptors: readonly ConditionalCoreAnchorDescriptor[]): PreparedConditional[] =>
  descriptors
    .map((descriptor) => ({
      path: descriptor.path,
      key: pathKey(descriptor.path),
      parentKey: pathKey(descriptor.path.slice(0, -1)),
      index: descriptor.path.at(-1) ?? 0,
      nodeCount: expectedNodeCount(descriptor.templateHtml),
    }))
    .sort((left, right) => {
      if (left.path.length !== right.path.length) return left.path.length - right.path.length;
      for (let index = 0; index < left.path.length; index++) {
        const difference = (left.path[index] ?? 0) - (right.path[index] ?? 0);
        if (difference !== 0) return difference;
      }
      return 0;
    });

const rawIndexFor = (plan: PreparedPathPlan, parentKey: string, logicalIndex: number): number => {
  let index = logicalIndex;
  for (const descriptor of plan.byParent.get(parentKey) ?? []) {
    if (descriptor.index >= logicalIndex) continue;
    const mode = plan.modes.get(descriptor.key);
    if (mode === "expanded") index += descriptor.nodeCount - 1;
    else if (mode === "omitted") index -= 1;
  }
  return index;
};

const insertedAnchorCountBefore = (plan: PreparedPathPlan, parentKey: string, logicalIndex: number): number => {
  let count = 0;
  for (const descriptor of plan.byParent.get(parentKey) ?? []) {
    if (descriptor.index >= logicalIndex) continue;
    const mode = plan.modes.get(descriptor.key);
    if (mode === "expanded" || mode === "omitted") count++;
  }
  return count;
};

const initialNodeAt = (
  root: Node,
  path: readonly number[],
  plan: PreparedPathPlan,
  initialNodes: ReadonlyMap<string, Node>,
): Node | undefined => {
  const rawPath: number[] = [];
  const parentPath: number[] = [];
  for (const logicalIndex of path) {
    rawPath.push(rawIndexFor(plan, pathKey(parentPath), logicalIndex));
    parentPath.push(logicalIndex);
  }
  return initialNodes.get(pathKey(rawPath)) ?? (rawPath.length === 0 ? root : undefined);
};

const preparedNodeFor = (root: Node, path: readonly number[], plan: PreparedPathPlan): Node | undefined => {
  let current: Node | undefined = root;
  const parentPath: number[] = [];
  for (const logicalIndex of path) {
    if (!current) return undefined;
    const parentKey = pathKey(parentPath);
    let actualIndex = logicalIndex;
    for (const descriptor of plan.byParent.get(parentKey) ?? []) {
      if (descriptor.index >= logicalIndex) continue;
      const anchor = anchorsByRoot.get(root)?.get(descriptor.key);
      const state = anchor ? states.get(anchor) : undefined;
      const preparedCount = preparedConditionalNodeCount(root, descriptor.key);
      if (preparedCount !== undefined) actualIndex += preparedCount;
      else if (state && state.nodes.length > 0) actualIndex += state.nodes.length;
      else if (plan.modes.get(descriptor.key) === "expanded") actualIndex += descriptor.nodeCount;
    }
    current = logicalChildren(current)[actualIndex];
    parentPath.push(logicalIndex);
  }
  return current;
};

/**
 * Reserves every lightweight conditional anchor before any branch is mounted.
 * SSR omits false branches, so the client path alone cannot identify a later
 * sibling until the active server branches have been accounted for.
 */
export const prepareConditionalCore = (root: Node, descriptors: readonly ConditionalCoreAnchorDescriptor[]): void => {
  const initialNodes = initialNodesFor(root);
  const ordered = orderedPreparedConditionals(descriptors);
  const byParent = new Map<string, PreparedConditional[]>();
  for (const descriptor of ordered) {
    const siblings = byParent.get(descriptor.parentKey) ?? [];
    siblings.push(descriptor);
    byParent.set(descriptor.parentKey, siblings);
  }
  const plan: PreparedPathPlan = { byParent, modes: new Map(), invalid: new Set() };
  preparedPathPlans.set(root, plan);

  for (const descriptor of ordered) {
    const source = descriptors.find((candidate) => pathKey(candidate.path) === descriptor.key);
    const parentPath = descriptor.path.slice(0, -1);
    const parent = initialNodeAt(root, parentPath, plan, initialNodes);
    const expectedParentTag = source?.parentTagName?.toLowerCase();
    if (!parent || (expectedParentTag && (!(parent instanceof Element) || parent.localName !== expectedParentTag))) {
      plan.invalid.add(descriptor.key);
      continue;
    }
    const rawIndex = rawIndexFor(plan, descriptor.parentKey, descriptor.index);
    const index = rawIndex + insertedAnchorCountBefore(plan, descriptor.parentKey, descriptor.index);
    const candidate = logicalChildren(parent)[index];
    if (candidate instanceof Comment && !isHydrationMarker(candidate)) {
      plan.modes.set(descriptor.key, "placeholder");
      registerAnchor(root, descriptor.path, candidate);
      continue;
    }
    const expected = createNodes(source?.templateHtml ?? "");
    const visible = Boolean(source?.visible);
    const adopted = visible ? adoptableNodes(parent, index, expected) : undefined;
    if (visible && !adopted) {
      plan.invalid.add(descriptor.key);
      continue;
    }
    const anchor = document.createComment("");
    parent.insertBefore(anchor, candidate ?? null);
    registerAnchor(root, descriptor.path, anchor);
    if (adopted) {
      plan.modes.set(descriptor.key, "expanded");
      setPreparedConditionalNodes(anchor, adopted);
    } else {
      plan.modes.set(descriptor.key, "omitted");
    }
  }
};

/** Resolves a generated binding path after conditional anchors and SSR branches are prepared. */
export const preparedNodeAt = (root: Node, path: readonly number[]): Node => {
  const plan = preparedPathPlans.get(root);
  if (!plan) {
    const node = nodeAt(root, path);
    if (!node) throw new TypeError(`Missing generated binding node at path ${path.join(".")}.`);
    return node;
  }
  if (path.some((_, index) => plan.invalid.has(pathKey(path.slice(0, index + 1))))) {
    throw new TypeError(`Cannot resolve generated binding path ${path.join(".")}.`);
  }
  const node = preparedNodeFor(root, path, plan);
  if (!node) throw new TypeError(`Missing generated binding node at path ${path.join(".")}.`);
  return node;
};

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
  const preparedPlan = preparedPathPlans.get(root);
  if (preparedPlan?.invalid.has(pathKey(path))) return undefined;
  const registered = registeredAnchorFor(root, path);
  if (registered) {
    const adoptedNodes = takePreparedConditionalNodes(registered);
    return { anchor: registered, adoptedNodes };
  }
  const initialNodes = initialNodesFor(root);
  const existing = initialNodes.get(pathKey(path)) ?? nodeAt(root, path);
  if (existing instanceof Comment && !isHydrationMarker(existing)) {
    registerAnchor(root, path, existing);
    return { anchor: existing, adoptedNodes: undefined };
  }
  const existingLocation = existing?.parentNode
    ? { parent: existing.parentNode, index: logicalChildren(existing.parentNode).indexOf(existing) }
    : undefined;
  const location = existingLocation && existingLocation.index >= 0 ? existingLocation : parentAndIndexAt(root, path);
  if (!location) return undefined;
  const expected = createNodes(templateHtml);
  const adoptedNodes = adoptableNodes(location.parent, location.index, expected);
  const anchor = document.createComment("");
  const actualChildren = logicalChildren(location.parent);
  const before = adoptedNodes?.[0] ?? actualChildren[location.index] ?? null;
  location.parent.insertBefore(anchor, before);
  registerAnchor(root, path, anchor);
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
  setPreparedConditionalNodeCount(anchor, 0);
  cleanupState(state);
};

const nodeAtState = (state: ConditionalCoreState, path: readonly number[]): Node | undefined => {
  if (state.nodes.length <= 1) return nodeAt(state.nodes[0] as Node, path);
  const [firstIndex, ...rest] = path;
  return nodeAt(state.nodes[firstIndex ?? 0] as Node, rest);
};

const textAtState = (state: ConditionalCoreState, path: readonly number[]): Text => {
  if (state.nodes.length <= 1) return textAt(state.nodes[0] as Node, path);
  const [firstIndex, ...rest] = path;
  return textAt(state.nodes[firstIndex ?? 0] as Node, rest);
};

const bindNodes = (state: ConditionalCoreState, options: ConditionalCoreOptions, bindEvents: boolean): void => {
  for (const binding of options.bindings) {
    const node = nodeAtState(state, binding.path);
    if (!node) continue;
    if (binding.kind === "text") {
      setText(textAtState(state, binding.path), readBinding(state.scope, binding));
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
    setPreparedConditionalNodeCount(anchor, 0);
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
  setPreparedConditionalNodeCount(anchor, state.nodes.length);
  bindNodes(state, options, state !== current);
};
