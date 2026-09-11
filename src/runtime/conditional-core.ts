import { setAttributeValue, setStyleValue } from "./attr.js";
import { setClassPresence } from "./class.js";
import { delegateTarget } from "./event.js";
import {
  clearConditionalRegion,
  conditionalRegionEnd,
  isInsertionStartMarker,
  isPathInvisibleNode,
  logicalNodesBetween,
  removeInsertionRegion,
} from "../conditional-marker.js";
import { onOwnerCleanup, read } from "./signal.js";
import { cleanupOwnedSubtree, registerOwnedSubtree, runCleanups } from "./subtree.js";
import { setText, textAt } from "./text.js";
import {
  preparedConditionalAdoptionCount,
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
  expression?: string;
  read?: ExpressionReader;
};

type ClassBinding = {
  kind: "class";
  path: number[];
  className: string;
  expression?: string;
  read?: ExpressionReader;
};

type EventBinding = {
  kind: "event";
  path: number[];
  eventName: string;
  handler?: string;
  read?: ExpressionReader;
};

type AttributeBinding = {
  kind: "attr";
  path: number[];
  name: string;
  expression?: string;
  read?: ExpressionReader;
};

type StyleBinding = {
  kind: "style";
  path: number[];
  name: string;
  expression?: string;
  read?: ExpressionReader;
};

type ConditionalCoreBinding = TextBinding | ClassBinding | EventBinding | AttributeBinding | StyleBinding;

export type ConditionalCoreOptions = {
  signature?: string;
  templateHtml: string;
  bindings: ConditionalCoreBinding[];
};

/**
 * A branch binding the compiler produced. The reader is required: there is no expression string to fall back
 * to, so a descriptor that forgot one cannot be written.
 */
type GeneratedConditionalBinding = {
  path: number[];
  read: ExpressionReader;
  /**
   * Applies the value to the branch node the compiler resolved. Omitted for a text binding, whose node is the
   * template's text node. Supplying it here keeps the class, attribute, and style setters out of this module.
   */
  apply?: (node: Node, value: unknown) => void;
};

/**
 * Registers a branch listener and returns its disposer; the generated module owns the event runtime. The scope
 * arrives as a getter because a branch kept across runs is rebound to the newest scope without rebinding its
 * listeners, and the handler has to be read from that one when the event fires.
 */
type GeneratedConditionalEvent = {
  path: number[];
  bind: (element: Element, scope: () => Record<string, unknown>) => () => void;
};

export type GeneratedConditionalOptions = {
  signature: string;
  templateHtml: string;
  bindings: readonly GeneratedConditionalBinding[];
  events?: readonly GeneratedConditionalEvent[];
};

type ConditionalCoreNodeMatcher = (expected: Node, actual: Node) => boolean;

type ConditionalCoreDynamicAttribute = {
  path: readonly number[];
  name: string;
  kind?: "value" | "token";
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

export type ConditionalCoreLaterDescriptor = {
  visible: unknown;
  templateHtml: string;
  dynamicAttributes?: readonly ConditionalCoreDynamicAttribute[];
};

export type ConditionalCoreAdoptionGuard = (
  parent: Node,
  index: number,
  expected: readonly Node[],
  laterConditionals: readonly ConditionalCoreLaterDescriptor[] | undefined,
) => boolean;

/** A mount-only module only needs each conditional's template position. */
export type ConditionalCoreMountDescriptor = {
  path: readonly number[];
};

export type ConditionalCoreAnchorDescriptor = {
  path: readonly number[];
  visible: unknown;
  templateHtml: string;
  parentTagName?: string;
  laterConditionals?: readonly ConditionalCoreLaterDescriptor[];
  dynamicAttributes?: readonly ConditionalCoreDynamicAttribute[];
};

type PreparedConditional = {
  path: readonly number[];
  key: string;
  parentKey: string;
  index: number;
};

type PreparedPathPlan = {
  invalid: Set<string>;
};

type RegisteredAnchor = {
  anchor: Comment;
  parentKey: string | undefined;
  index: number;
};

export type PreparedPathChildOffset = (container: Node, parentPath: readonly number[], childIndex: number) => number;

const states = new WeakMap<Comment, ConditionalCoreState>();
const ownerCleanupDisposers = new WeakMap<Comment, () => void>();
const anchorsByRoot = new WeakMap<Node, Map<string, RegisteredAnchor>>();
const preparedPathPlans = new WeakMap<Node, PreparedPathPlan>();

const pathKey = (path: readonly number[]): string => path.join(".");

// Region end markers occupy no logical slot either; conditional region content does, and the region offsets
// account for it. List region content never does: rows are addressed by their list, so a path steps over them.
const isHydrationMarker = isPathInvisibleNode;

const logicalChildren = (node: Node): Node[] => logicalNodesBetween(node.firstChild, null);

const registeredAnchorFor = (root: Node, path: readonly number[]): Comment | undefined => {
  const anchors = anchorsByRoot.get(root);
  const key = pathKey(path);
  const registered = anchors?.get(key);
  if (registered?.anchor.parentNode) return registered.anchor;
  anchors?.delete(key);
  return undefined;
};

const registerAnchor = (root: Node, path: readonly number[], anchor: Comment): void => {
  const anchors = anchorsByRoot.get(root) ?? new Map<string, RegisteredAnchor>();
  anchors.set(pathKey(path), {
    anchor,
    parentKey: path.length > 0 ? pathKey(path.slice(0, -1)) : undefined,
    index: path.at(-1) ?? 0,
  });
  anchorsByRoot.set(root, anchors);
  registerPreparedAnchor(root, pathKey(path), anchor);
};

/**
 * Live nodes a conditional region adds beyond the slots its markers occupy in the template, so the branch
 * nodes (nested regions included) are what shift later siblings. They are read from the DOM between the
 * markers; an anchor without an end marker falls back to the count its mounts record, or before the first
 * mount to the nodes prepare adopted from the server.
 */
const conditionalRegionNodeCount = (root: Node, key: string, anchor: Comment): number => {
  const end = conditionalRegionEnd(anchor);
  return end
    ? regionNodeCount(anchor, end)
    : (preparedConditionalNodeCount(root, key) ?? preparedConditionalAdoptionCount(anchor) ?? 0);
};

const regionNodeCount = (anchor: Comment, end: Node): number => {
  return logicalNodesBetween(anchor.nextSibling, end).length;
};

/**
 * Offset from a template child index to the live child index, given the conditional regions that already
 * occupy earlier slots under the same parent. This replaces a root-scoped snapshot of every initial node:
 * only the anchors and their current node counts are needed, so hidden branches are not retained.
 */
const conditionalRegionOffset = (root: Node, parentKey: string, logicalIndex: number): number => {
  let offset = 0;
  for (const [key, registered] of anchorsByRoot.get(root) ?? []) {
    if (registered.parentKey !== parentKey || registered.index >= logicalIndex) continue;
    if (!registered.anchor.parentNode) continue;
    offset += conditionalRegionNodeCount(root, key, registered.anchor);
  }
  return offset;
};

/**
 * Walks template child indexes over the live DOM. `descendFinalRegion` picks whether the last step returns the
 * conditional anchor that owns a logical slot or steps into the branch content that follows it, which is what a
 * nested conditional or a deeper binding target needs.
 */
const liveNodeForLogicalPath = (
  root: Node,
  path: readonly number[],
  childOffset?: PreparedPathChildOffset,
  descendFinalRegion = false,
): Node | undefined => {
  let current: Node | undefined = root;
  const parentPath: number[] = [];
  for (const [step, logicalIndex] of path.entries()) {
    if (!current) return undefined;
    let actualIndex = logicalIndex + conditionalRegionOffset(root, pathKey(parentPath), logicalIndex);
    if (childOffset) actualIndex += childOffset(current, parentPath, logicalIndex);
    parentPath.push(logicalIndex);
    const key = pathKey(parentPath);
    const region = registeredAnchorFor(root, parentPath);
    if (region && (descendFinalRegion || step < path.length - 1)) {
      current =
        conditionalRegionNodeCount(root, key, region) > 0 ? logicalChildren(current)[actualIndex + 1] : undefined;
      continue;
    }
    current = logicalChildren(current)[actualIndex];
  }
  return current;
};

const liveLocationForLogicalPath = (
  root: Node,
  path: readonly number[],
): { parent: Node; index: number } | undefined => {
  if (path.length === 0) {
    return root.parentNode
      ? { parent: root.parentNode, index: logicalChildren(root.parentNode).indexOf(root) }
      : undefined;
  }
  const parentPath = path.slice(0, -1);
  const parent = liveNodeForLogicalPath(root, parentPath, undefined, true);
  const logicalIndex = path.at(-1) as number;
  return parent
    ? { parent, index: logicalIndex + conditionalRegionOffset(root, pathKey(parentPath), logicalIndex) }
    : undefined;
};

const orderedPreparedConditionals = (descriptors: readonly ConditionalCoreMountDescriptor[]): PreparedConditional[] =>
  descriptors
    .map((descriptor) => ({
      path: descriptor.path,
      key: pathKey(descriptor.path),
      parentKey: pathKey(descriptor.path.slice(0, -1)),
      index: descriptor.path.at(-1) ?? 0,
    }))
    .sort((left, right) => {
      if (left.path.length !== right.path.length) return left.path.length - right.path.length;
      for (let index = 0; index < left.path.length; index++) {
        const difference = (left.path[index] ?? 0) - (right.path[index] ?? 0);
        if (difference !== 0) return difference;
      }
      return 0;
    });

/**
 * Client-only preparation. A mount renders the template itself, so every conditional slot is the placeholder
 * comment the template carries and there is no server shape to inspect, adopt, or defer to.
 */
export const prepareConditionalCoreForMount = (
  root: Node,
  descriptors: readonly ConditionalCoreMountDescriptor[],
): void => {
  const plan: PreparedPathPlan = { invalid: new Set() };
  preparedPathPlans.set(root, plan);
  for (const descriptor of orderedPreparedConditionals(descriptors)) {
    const parent = liveNodeForLogicalPath(root, descriptor.path.slice(0, -1), undefined, true);
    const index = descriptor.index + conditionalRegionOffset(root, descriptor.parentKey, descriptor.index);
    const candidate = parent ? logicalChildren(parent)[index] : undefined;
    if (candidate instanceof Comment && !isHydrationMarker(candidate)) registerAnchor(root, descriptor.path, candidate);
    else plan.invalid.add(descriptor.key);
  }
};

type NodeListMatcher = (
  expected: readonly Node[],
  actual: readonly Node[],
  dynamicAttributes: readonly ConditionalCoreDynamicAttribute[],
) => boolean;

/**
 * Adopts the server branch between a start-marker anchor and its end marker. The content is matched against
 * the branch template; content that differs is stale server output and is dropped, so the mount renders into
 * an empty region. A lightweight branch holds no nested region, so its content is the plain sibling run after
 * the anchor; a generic branch adopts the regions nested inside it when it mounts.
 */
const adoptRegion = (
  anchor: Comment,
  templateHtml: string,
  dynamicAttributes: readonly ConditionalCoreDynamicAttribute[],
  match: NodeListMatcher,
): void => {
  const end = conditionalRegionEnd(anchor);
  if (!end || anchor.nextSibling === end) return;
  // The template's own list regions are skipped exactly as the live region count skips them.
  const expected = logicalNodesBetween(createFragment(templateHtml).firstChild, null);
  const parent = anchor.parentNode as Node;
  const liveCount = regionNodeCount(anchor, end);
  // A branch made only of list regions has no shaped nodes of its own; its rows are adopted by the list.
  const nodes =
    liveCount === expected.length
      ? expected.length === 0
        ? []
        : adoptableNodesBy(match, parent, logicalChildren(parent).indexOf(anchor) + 1, expected, dynamicAttributes)
      : undefined;
  if (nodes) setPreparedConditionalNodes(anchor, nodes);
  else clearConditionalRegion(anchor);
};

type ConditionalAdoptionDefer = (
  parent: Node,
  index: number,
  expected: readonly Node[],
  source: ConditionalCoreAnchorDescriptor | undefined,
) => boolean;

const prepareConditionalCoreWith = (
  root: Node,
  descriptors: readonly ConditionalCoreAnchorDescriptor[],
  match: NodeListMatcher,
  defer: ConditionalAdoptionDefer | undefined,
): void => {
  const plan: PreparedPathPlan = { invalid: new Set() };
  preparedPathPlans.set(root, plan);

  for (const descriptor of orderedPreparedConditionals(descriptors)) {
    const source = descriptors.find((candidate) => pathKey(candidate.path) === descriptor.key);
    const parent = liveNodeForLogicalPath(root, descriptor.path.slice(0, -1), undefined, true);
    const expectedParentTag = source?.parentTagName?.toLowerCase();
    if (!parent || (expectedParentTag && (!(parent instanceof Element) || parent.localName !== expectedParentTag))) {
      plan.invalid.add(descriptor.key);
      continue;
    }
    const index = descriptor.index + conditionalRegionOffset(root, descriptor.parentKey, descriptor.index);
    const candidate = logicalChildren(parent)[index];
    const dynamicAttributes = source?.dynamicAttributes ?? [];
    if (candidate instanceof Comment && !isHydrationMarker(candidate)) {
      registerAnchor(root, descriptor.path, candidate);
      adoptRegion(candidate, source?.templateHtml ?? "", dynamicAttributes, match);
      continue;
    }
    // Server output without region markers: the branch, when visible, sits at the slot itself.
    const expected = createNodes(source?.templateHtml ?? "");
    // The client condition describes the requested state, not the state that
    // produced the SSR DOM. Inspect the server shape independently so a
    // server-visible branch can be removed when the client starts hidden.
    const adopted = adoptableNodesBy(match, parent, index, expected, dynamicAttributes);
    // Both adoption checks must read the server DOM before the anchor shifts it.
    const deferred = adopted !== undefined && (defer?.(parent, index, expected, source) ?? false);
    const anchor = document.createComment("");
    parent.insertBefore(anchor, candidate ?? null);
    registerAnchor(root, descriptor.path, anchor);
    if (adopted && !deferred) setPreparedConditionalNodes(anchor, adopted);
  }
};

/**
 * Reserves every lightweight conditional anchor before any branch is mounted.
 * SSR omits false branches, so the client path alone cannot identify a later
 * sibling until the active server branches have been accounted for.
 */
export const prepareConditionalCore = (root: Node, descriptors: readonly ConditionalCoreAnchorDescriptor[]): void =>
  prepareConditionalCoreWith(root, descriptors, matchNodes, undefined);

const pathEquals = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length && left.every((part, index) => part === right[index]);

const dynamicAttributeFor = (
  dynamicAttributes: readonly ConditionalCoreDynamicAttribute[],
  path: readonly number[],
  name: string,
): ConditionalCoreDynamicAttribute | undefined =>
  dynamicAttributes.find(
    (attribute) => pathEquals(attribute.path, path) && attribute.name.toLowerCase() === name.toLowerCase(),
  );

const sameNodeShapeWithStaticAttributes = (
  expected: Node,
  actual: Node,
  dynamicAttributes: readonly ConditionalCoreDynamicAttribute[],
  path: readonly number[] = [],
): boolean => {
  if (
    expected.nodeType === Node.TEXT_NODE &&
    expected.nodeValue === " " &&
    actual.nodeType === Node.COMMENT_NODE &&
    actual.nodeValue === "td:text"
  ) {
    return true;
  }
  if (!sameNodeShape(expected, actual)) return false;
  if (!(expected instanceof Element) || !(actual instanceof Element)) return true;

  for (const attribute of Array.from(expected.attributes)) {
    const dynamicAttribute = dynamicAttributeFor(dynamicAttributes, path, attribute.name);
    if (dynamicAttribute?.kind === "token" && attribute.name.toLowerCase() === "class") {
      const actualTokens = new Set((actual.getAttribute(attribute.name) ?? "").split(/\s+/).filter(Boolean));
      const expectedTokens = attribute.value.split(/\s+/).filter(Boolean);
      if (expectedTokens.some((token) => !actualTokens.has(token))) return false;
    } else if (!dynamicAttribute && actual.getAttribute(attribute.name) !== attribute.value) {
      return false;
    }
  }
  for (const attribute of Array.from(actual.attributes)) {
    if (expected.hasAttribute(attribute.name)) continue;
    if (!dynamicAttributeFor(dynamicAttributes, path, attribute.name)) return false;
  }

  const expectedChildren = logicalChildren(expected);
  const actualChildren = logicalChildren(actual);
  return (
    expectedChildren.length === actualChildren.length &&
    expectedChildren.every((child, index) =>
      sameNodeShapeWithStaticAttributes(child, actualChildren[index] as Node, dynamicAttributes, [...path, index]),
    )
  );
};

const matchNodesWithStaticAttributes: NodeListMatcher = (expected, actual, dynamicAttributes) =>
  actual.length === expected.length &&
  expected.every((node, nodeIndex) =>
    sameNodeShapeWithStaticAttributes(
      node,
      actual[nodeIndex] as Node,
      dynamicAttributes,
      expected.length === 1 ? [] : [nodeIndex],
    ),
  );

const adoptableNodesWithStaticAttributes = (
  parent: Node,
  index: number,
  expected: readonly Node[],
  dynamicAttributes: readonly ConditionalCoreDynamicAttribute[],
): Node[] | undefined => adoptableNodesBy(matchNodesWithStaticAttributes, parent, index, expected, dynamicAttributes);

const deferConditionalAdoptionWithStaticAttributes = (
  parent: Node,
  index: number,
  expected: readonly Node[],
  laterConditionals: readonly ConditionalCoreLaterDescriptor[] | undefined,
): boolean => {
  const candidate = laterConditionals?.find(
    (later) =>
      Boolean(later.visible) &&
      adoptableNodesWithStaticAttributes(
        parent,
        index,
        createNodes(later.templateHtml),
        later.dynamicAttributes ?? [],
      ) !== undefined,
  );
  return (
    candidate !== undefined &&
    adoptableNodesWithStaticAttributes(
      parent,
      index + expected.length,
      createNodes(candidate.templateHtml),
      candidate.dynamicAttributes ?? [],
    ) === undefined
  );
};

export const prepareConditionalCoreWithStaticAttributes = (
  root: Node,
  descriptors: readonly ConditionalCoreAnchorDescriptor[],
): void => prepareConditionalCoreWith(root, descriptors, matchNodesWithStaticAttributes, undefined);

export const prepareConditionalCoreWithAdoptionGuard = (
  root: Node,
  descriptors: readonly ConditionalCoreAnchorDescriptor[],
): void =>
  prepareConditionalCoreWith(root, descriptors, matchNodes, (parent, index, expected, source) =>
    deferConditionalAdoption(parent, index, expected, source?.laterConditionals),
  );

export const prepareConditionalCoreWithAdoptionGuardAndStaticAttributes = (
  root: Node,
  descriptors: readonly ConditionalCoreAnchorDescriptor[],
): void =>
  prepareConditionalCoreWith(root, descriptors, matchNodesWithStaticAttributes, (parent, index, expected, source) =>
    deferConditionalAdoptionWithStaticAttributes(parent, index, expected, source?.laterConditionals),
  );

/** Resolves a generated binding path after conditional anchors and SSR branches are prepared. */
export const preparedNodeAt = (root: Node, path: readonly number[], childOffset?: PreparedPathChildOffset): Node => {
  const plan = preparedPathPlans.get(root);
  if (plan && path.some((_, index) => plan.invalid.has(pathKey(path.slice(0, index + 1))))) {
    throw new TypeError(`Cannot resolve generated binding path ${path.join(".")}.`);
  }
  const node = liveNodeForLogicalPath(root, path, childOffset);
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

const createFragment = (templateHtml: string): DocumentFragment => {
  const template = document.createElement("template");
  template.innerHTML = templateHtml;
  return template.content;
};

const createNodes = (templateHtml: string): Node[] =>
  Array.from(createFragment(templateHtml).childNodes).map((node) => node.cloneNode(true));

const sameNodeShape: ConditionalCoreNodeMatcher = (expected, actual): boolean => {
  if (expected.nodeType !== actual.nodeType) return false;
  if (expected instanceof Element && actual instanceof Element) {
    return expected.localName === actual.localName;
  }
  return expected.nodeType === Node.TEXT_NODE || expected.nodeType === Node.COMMENT_NODE;
};

const matchNodes: NodeListMatcher = (expected, actual) =>
  actual.length === expected.length &&
  expected.every((node, nodeIndex) => sameNodeShape(node, actual[nodeIndex] as Node));

/** Server output without region markers: the branch nodes sit at the slot itself when it is visible. */
const adoptableNodesBy = (
  match: NodeListMatcher,
  parent: Node,
  index: number,
  expected: readonly Node[],
  dynamicAttributes: readonly ConditionalCoreDynamicAttribute[] = [],
): Node[] | undefined => {
  if (expected.length === 0) return undefined;
  const actual = logicalChildren(parent).slice(index, index + expected.length);
  return match(expected, actual, dynamicAttributes) ? actual : undefined;
};

const adoptableNodes = (parent: Node, index: number, expected: readonly Node[]): Node[] | undefined =>
  adoptableNodesBy(matchNodes, parent, index, expected);

export const deferConditionalAdoption: ConditionalCoreAdoptionGuard = (
  parent,
  index,
  expected,
  laterConditionals,
): boolean => {
  const candidate = laterConditionals?.find(
    (later) => Boolean(later.visible) && adoptableNodes(parent, index, createNodes(later.templateHtml)) !== undefined,
  );
  return (
    candidate !== undefined &&
    adoptableNodes(parent, index + expected.length, createNodes(candidate.templateHtml)) === undefined
  );
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
  const location = liveLocationForLogicalPath(root, path);
  if (!location || location.index < 0) return undefined;
  const candidate = logicalChildren(location.parent)[location.index];
  if (candidate instanceof Comment && !isHydrationMarker(candidate)) {
    registerAnchor(root, path, candidate);
    return { anchor: candidate, adoptedNodes: undefined };
  }
  const expected = createNodes(templateHtml);
  const adoptedNodes = adoptableNodes(location.parent, location.index, expected);
  const anchor = document.createComment("");
  location.parent.insertBefore(anchor, adoptedNodes?.[0] ?? candidate ?? null);
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
  read(binding.read ? binding.read(scope) : readPath(scope, binding.expression ?? ""));

const cleanupState = (state: Pick<ConditionalCoreState, "nodes" | "cleanups">): void => {
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
      // A server-only insertion leaves with its start marker: its content and end marker are never logical nodes.
      if (isInsertionStartMarker(node)) removeInsertionRegion(node);
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

// A created branch keeps every template node so it can be inserted as a whole, but binding paths count only
// logical nodes: an insertion's end marker occupies no slot, exactly as it does not in the parent template.
const logicalStateNodes = (state: ConditionalCoreState): Node[] =>
  state.nodes.filter((node) => !isPathInvisibleNode(node));

const nodeAtState = (state: ConditionalCoreState, path: readonly number[]): Node | undefined => {
  const nodes = logicalStateNodes(state);
  if (nodes.length <= 1) return nodeAt(nodes[0] as Node, path);
  const [firstIndex, ...rest] = path;
  return nodeAt(nodes[firstIndex ?? 0] as Node, rest);
};

const textAtState = (state: ConditionalCoreState, path: readonly number[]): Text => {
  const nodes = logicalStateNodes(state);
  if (nodes.length <= 1) return textAt(nodes[0] as Node, path);
  const [firstIndex, ...rest] = path;
  return textAt(nodes[firstIndex ?? 0] as Node, rest);
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
        const handler = binding.read ? binding.read(state.scope) : readPath(state.scope, binding.handler ?? "");
        if (typeof handler === "function") (handler as EventListener)(event);
      };
      state.cleanups.push(delegateTarget(element, binding.eventName, element, listener));
    }
  }
};

const bindGeneratedNodes = (
  state: ConditionalCoreState,
  options: GeneratedConditionalOptions,
  bindEvents: boolean,
): void => {
  for (const binding of options.bindings) {
    const node = nodeAtState(state, binding.path);
    if (!node) continue;
    const value = read(binding.read(state.scope));
    if (binding.apply) binding.apply(node, value);
    else setText(textAtState(state, binding.path), value);
  }
  if (!bindEvents) return;
  const currentScope = (): Record<string, unknown> => state.scope;
  for (const event of options.events ?? []) {
    const node = nodeAtState(state, event.path);
    if (node instanceof Element) state.cleanups.push(event.bind(node, currentScope));
  }
};

const signatureFor = (options: ConditionalCoreOptions): string => options.signature ?? JSON.stringify(options);

type ConditionalBinder = (state: ConditionalCoreState, bindEvents: boolean) => void;

const mountPreparedConditional = (
  root: Node,
  path: readonly number[],
  visible: unknown,
  scope: Record<string, unknown>,
  signature: string,
  templateHtml: string,
  bind: ConditionalBinder,
): void => {
  const resolution = resolveAnchor(root, path, visible, templateHtml);
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
    if (adoptedNodes) cleanupState({ nodes: adoptedNodes, cleanups: [] });
    setPreparedConditionalNodeCount(anchor, 0);
    return;
  }
  if (current && current.signature !== signature) cleanupOwnedSubtree(anchor);
  const state =
    current && current.signature === signature
      ? current
      : {
          signature,
          anchor,
          nodes: adoptedNodes ?? createNodes(templateHtml),
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
  bind(state, state !== current);
};

/** Mounts a compiler-proven conditional that only contains text, class, attr, style, and event bindings. */
export const mountConditionalCore = (
  root: Node,
  path: readonly number[],
  visible: unknown,
  scope: Record<string, unknown>,
  options: ConditionalCoreOptions,
): void =>
  mountPreparedConditional(
    root,
    path,
    visible,
    scope,
    signatureFor(options),
    options.templateHtml,
    (state, bindEvents) => bindNodes(state, options, bindEvents),
  );

/**
 * Mounts a generated conditional. Every value carries its reader and, unless it targets the template's text
 * node, the setter that applies it, so this entry never classifies a binding or imports a setter of its own.
 */
export const mountGeneratedConditionalCore = (
  root: Node,
  path: readonly number[],
  visible: unknown,
  scope: Record<string, unknown>,
  options: GeneratedConditionalOptions,
): void =>
  mountPreparedConditional(root, path, visible, scope, options.signature, options.templateHtml, (state, bindEvents) =>
    bindGeneratedNodes(state, options, bindEvents),
  );
