import { setClassPresence } from "./class.js";
import { bindRef, setAttributeValue, setRef, setStyleValue } from "./attr.js";
import { delegate } from "./event.js";
import { bindControl, setControlValue, writeModelValue } from "./form.js";
import { mountKeyedList } from "./list.js";
import { cleanupOwnedSubtree, registerOwnedSubtree, runCleanups } from "./subtree.js";
import { setText, textAt } from "./text.js";
import { createStore, onOwnerCleanup, read } from "./signal.js";
import {
  clearConditionalRegion,
  clientShapedNodes,
  templateNodeAt,
  conditionalRegionEnd,
  isConditionalEndMarker,
  isConditionalStartMarker,
  removeConditionalRegion,
} from "../conditional-marker.js";
import { setPreparedConditionalNodeCount, takePreparedConditionalNodes } from "./conditional-prepared.js";
import {
  createHydrationBoundary,
  scheduleHydration,
  type CompiledHydrationBoundary,
  type HydrationBoundaryHandle,
} from "./hydrate.js";

type TextBinding = {
  kind: "text";
  path: number[];
  expression?: string;
  read?: (scope: Record<string, unknown>) => unknown;
};

type ClassBinding = {
  kind: "class";
  path: number[];
  className: string;
  expression?: string;
  read?: (scope: Record<string, unknown>) => unknown;
  apply?: ValueApplier;
};

type EventBinding = {
  kind: "event";
  path: number[];
  eventName: string;
  handler?: string;
  read?: (scope: Record<string, unknown>) => unknown;
};

type AttributeBinding = {
  kind: "attr";
  path: number[];
  name: string;
  expression?: string;
  read?: (scope: Record<string, unknown>) => unknown;
  apply?: ValueApplier;
};

type StyleBinding = {
  kind: "style";
  path: number[];
  name: string;
  expression?: string;
  read?: (scope: Record<string, unknown>) => unknown;
  apply?: ValueApplier;
};

type RefBinding = {
  kind: "ref";
  path: number[];
  expression?: string;
  /** Reads the object that holds the ref. A generated ref carries this and `property` instead of a path. */
  owner?: (scope: Record<string, unknown>) => unknown;
  property?: string;
};

type ModelBinding = {
  kind: "model";
  path: number[];
  property: "value" | "checked";
  expression?: string;
  read?: (scope: Record<string, unknown>) => unknown;
  write?: (scope: Record<string, unknown>, value: unknown) => void;
  apply?: ValueApplier;
  bind?: TargetBinder;
};

/** Applies a value to the node the compiler resolved. A generated descriptor carries its own. */
type ValueApplier = (node: Node, value: unknown) => void;
/** Binds a target and returns its disposer. A generated descriptor carries its own. */
type TargetBinder = (scope: Record<string, unknown>, element: Element) => () => void;
/** Mounts a nested keyed list. A generated descriptor carries the entry that drives it. */
type ListMounter = (
  root: Element,
  path: readonly number[],
  items: readonly unknown[] | undefined,
  options: NestedListBinding,
  scope: Record<string, unknown>,
) => void;
/** Mounts a nested branch. A generated descriptor carries the entry that drives it. */
type BranchMounter = (
  root: Node,
  path: readonly number[],
  visible: unknown,
  scope: Record<string, unknown>,
  options: NestedConditionalBinding,
) => void;
/** Adopts and schedules a branch hydration boundary. A generated descriptor carries its own. */
type HydrationRuntime = { create: typeof createHydrationBoundary; schedule: typeof scheduleHydration };

type NestedListBinding = {
  kind: "list";
  signature?: string;
  mount?: ListMounter;
  path: number[];
  each: string;
  key: string;
  keyRead?: (scope: Record<string, unknown>) => unknown;
  keyReadItem?: (item: unknown) => unknown;
  itemName: string;
  indexName?: string;
  templateHtml: string;
  bindings: ConditionalBinding[];
  stores?: StoreDefinition[];
  hydrationBoundaries?: CompiledHydrationBoundary[];
  components?: ComponentBoundary[];
  read?: (scope: Record<string, unknown>) => unknown;
};

type StoreDefinition = {
  name: string;
  key?: string;
  initial?: string;
  read?: (scope: Record<string, unknown>) => unknown;
};

type ComponentProp = {
  name: string;
  key?: string;
  expression?: string;
  read?: (scope: Record<string, unknown>) => unknown;
};

type ComponentBoundary = {
  path: number[];
  name: string;
  props: ComponentProp[];
  stores: StoreDefinition[];
};

type NestedConditionalBinding = {
  kind: "if";
  signature?: string;
  mount?: BranchMounter;
  path: number[];
  test: string;
  templateHtml: string;
  bindings: ConditionalBinding[];
  stores?: StoreDefinition[];
  hydrationBoundaries?: CompiledHydrationBoundary[];
  components?: ComponentBoundary[];
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
  stores?: StoreDefinition[];
  hydrationBoundaries?: CompiledHydrationBoundary[];
  components?: ComponentBoundary[];
  hydration?: HydrationRuntime;
};

/**
 * What binding a branch drives a descriptor through.
 *
 * A generated descriptor carries its own readers, setters, binders, and nested entries, so the generated entry
 * resolves to accessors that only call back into it. A hand-written descriptor carries expression strings, so
 * the compatibility entry resolves to accessors that interpret them and apply them through this module's own
 * imports. A bundle that never calls the compatibility entry therefore drops the interpreters, the setters, the
 * form runtime, the keyed list, and the hydration runtime along with it.
 */
type ConditionalRuntimeOptions = ConditionalOptions & {
  descriptor: ConditionalOptions;
  signature: string;
  readValue: (
    scope: Record<string, unknown>,
    source: { expression?: string | undefined; read?: ((scope: Record<string, unknown>) => unknown) | undefined },
  ) => unknown;
  readHandler: (scope: Record<string, unknown>, binding: EventBinding) => unknown;
  readDeclaration: (
    scope: Record<string, unknown>,
    expression: string | undefined,
    reader: ((scope: Record<string, unknown>) => unknown) | undefined,
  ) => unknown;
  applyValue: (binding: ConditionalBinding, node: Node, value: unknown) => void;
  bindRefTarget: (scope: Record<string, unknown>, binding: RefBinding, element: Element) => () => void;
  bindControlTarget: (scope: Record<string, unknown>, binding: ModelBinding, element: Element) => () => void;
  mountList: (
    binding: NestedListBinding,
    container: Element,
    items: readonly unknown[] | undefined,
    scope: Record<string, unknown>,
  ) => void;
  mountBranch: (
    binding: NestedConditionalBinding,
    node: Node,
    visible: unknown,
    scope: Record<string, unknown>,
  ) => void;
  /** Only the boundary loop reaches it, and that runs only for a descriptor that declares boundaries. */
  hydration: HydrationRuntime;
};

type ConditionalState = {
  signature: string;
  descriptor: ConditionalOptions;
  nodes: Node[];
  cleanups: Array<() => void>;
  refCleanups: Map<number, () => void>;
  scope: Record<string, unknown>;
  sourceScope: Record<string, unknown>;
  sourceScopeSnapshot: Map<string, unknown>;
  localScopeKeys: ReadonlySet<string>;
  interactiveBindingsBound: boolean;
  hydrationBoundaries: HydrationBoundaryHandle[];
  hydrationCleanups: Array<() => void>;
  hydrationDeferredBindings: Set<ConditionalBinding>;
  /** Allocated only when this branch adopts a hydration boundary. */
  hydrationState:
    | {
        bindings: Set<ConditionalBinding>;
        revision: { value: number };
        pending: Set<(error: unknown) => void>;
      }
    | undefined;
};

const states = new WeakMap<Comment, ConditionalState>();
const ownerCleanupDisposers = new WeakMap<Comment, () => void>();

const detachOwnerCleanup = (anchor: Comment): void => {
  ownerCleanupDisposers.get(anchor)?.();
  ownerCleanupDisposers.delete(anchor);
};

export const nodeAt = (root: Node, path: readonly number[]): Node => templateNodeAt(root, path) as Node;

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

/** A generated boundary carries a compiled reader; a hand-written one still names a dotted path. */
const resolveBoundaryId = (boundary: CompiledHydrationBoundary, scope: Record<string, unknown>): unknown =>
  boundary.idRead
    ? read(boundary.idRead(scope))
    : boundary.idKind === "expression"
      ? readPath(scope, boundary.id)
      : boundary.id;

const readLiteralExpression = (scope: Record<string, unknown>, expression: string): unknown => {
  const value = expression.trim();
  if (value === "undefined") return undefined;
  if (value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return readPath(scope, expression);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("\\'", "'").replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  }
  return readPath(scope, expression);
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

const legacySignature = (options: ConditionalOptions): string => options.signature ?? JSON.stringify(options);

const sourceScopeSnapshotFor = (scope: Record<string, unknown>): Map<string, unknown> =>
  new Map(Object.keys(scope).map((key) => [key, scope[key]] as const));

const sourceScopeChanged = (previous: ReadonlyMap<string, unknown>, next: ReadonlyMap<string, unknown>): boolean => {
  if (previous.size !== next.size) return true;
  for (const [key, value] of previous) {
    if (!next.has(key) || !Object.is(next.get(key), value)) return true;
  }
  return false;
};

const localScopeKeysFor = (options: ConditionalRuntimeOptions): ReadonlySet<string> =>
  new Set([
    ...(options.stores ?? []).flatMap((store) => [store.name, store.key ?? store.name]),
    ...(options.components ?? []).flatMap((component) => [
      ...component.props.flatMap((prop) => [prop.name, prop.key ?? prop.name]),
      ...component.stores.flatMap((store) => [store.name, store.key ?? store.name]),
    ]),
  ]);

const readExpression = (
  scope: Record<string, unknown>,
  expression: string | undefined,
  reader: ((scope: Record<string, unknown>) => unknown) | undefined,
): unknown => read(reader ? reader(scope) : readLiteralExpression(scope, expression ?? ""));

const scopeFor = (scope: Record<string, unknown>, options: ConditionalRuntimeOptions): Record<string, unknown> => {
  const definitions = [
    ...(options.stores ?? []),
    ...(options.components ?? []).flatMap((component) => component.stores),
  ];
  const localScope = definitions.length > 0 ? createStore({ ...scope }) : scope;
  for (const store of options.stores ?? []) {
    localScope[store.key ?? store.name] = options.readDeclaration(localScope, store.initial, store.read);
  }
  for (const component of options.components ?? []) {
    for (const prop of component.props) {
      localScope[prop.key ?? prop.name] = options.readDeclaration(localScope, prop.expression, prop.read);
    }
    for (const store of component.stores) {
      localScope[store.key ?? store.name] = options.readDeclaration(localScope, store.initial, store.read);
    }
  }
  return localScope;
};

const updateScope = (
  state: ConditionalState,
  sourceScope: Record<string, unknown>,
  options: ConditionalRuntimeOptions,
): boolean => {
  const nextSnapshot = sourceScopeSnapshotFor(sourceScope);
  const changed = state.sourceScope !== sourceScope || sourceScopeChanged(state.sourceScopeSnapshot, nextSnapshot);
  for (const key of state.sourceScopeSnapshot.keys()) {
    if (!nextSnapshot.has(key) && !state.localScopeKeys.has(key)) state.scope[key] = undefined;
  }
  for (const [key, value] of nextSnapshot) {
    if (state.localScopeKeys.has(key)) continue;
    state.scope[key] = value;
  }
  for (const component of options.components ?? []) {
    for (const prop of component.props) {
      state.scope[prop.key ?? prop.name] = options.readDeclaration(state.scope, prop.expression, prop.read);
    }
  }
  state.sourceScope = sourceScope;
  state.sourceScopeSnapshot = nextSnapshot;
  return changed;
};

const readBinding = (
  scope: Record<string, unknown>,
  binding: Exclude<ConditionalBinding, EventBinding | RefBinding | NestedListBinding | NestedConditionalBinding>,
): unknown => read(binding.read ? binding.read(scope) : readLiteralExpression(scope, binding.expression ?? ""));

const readEvent = (scope: Record<string, unknown>, binding: EventBinding): unknown =>
  binding.read ? binding.read(scope) : readPath(scope, binding.handler ?? "");

const writeBinding = (scope: Record<string, unknown>, binding: ModelBinding, value: unknown): void => {
  if (binding.write) {
    binding.write(scope, value);
    return;
  }
  const target = binding.read ? binding.read(scope) : readPath(scope, binding.expression ?? "");
  writeModelValue(target, value, () => writePath(scope, binding.expression ?? "", value));
};

const cleanup = (state: ConditionalState): void => {
  let firstError: unknown;
  let failed = false;
  try {
    runCleanups(state.hydrationCleanups);
  } catch (error) {
    firstError = error;
    failed = true;
  }
  state.hydrationBoundaries.splice(0);
  state.hydrationDeferredBindings.clear();
  state.hydrationState?.bindings.clear();
  try {
    runCleanups(state.cleanups);
  } catch (error) {
    if (!failed) firstError = error;
    failed = true;
  }
  const refCleanups = Array.from(state.refCleanups.values());
  state.refCleanups.clear();
  try {
    runCleanups(refCleanups);
  } catch (error) {
    if (!failed) firstError = error;
    failed = true;
  }
  for (const node of state.nodes) {
    try {
      cleanupOwnedSubtree(node);
    } catch (error) {
      if (!failed) firstError = error;
      failed = true;
    } finally {
      if (isConditionalStartMarker(node)) removeConditionalRegion(node);
      node.parentNode?.removeChild(node);
    }
  }
  state.nodes.length = 0;
  if (failed) throw firstError;
};

const removeAdoptedNodes = (nodes: readonly Node[]): void => {
  let firstError: unknown;
  let failed = false;
  for (const node of nodes) {
    try {
      cleanupOwnedSubtree(node);
    } catch (error) {
      if (!failed) firstError = error;
      failed = true;
    } finally {
      if (isConditionalStartMarker(node)) removeConditionalRegion(node);
      node.parentNode?.removeChild(node);
    }
  }
  if (failed) throw firstError;
};

/**
 * The server branch a region's anchor still holds: prepared by the top-level pass, or, for a region nested in
 * an adopted branch, read from between its markers here. It is only trusted when it follows the branch
 * template; an empty text marker stands in for the template's text node, as it does at the top level.
 */
const adoptableRegionNodes = (anchor: Comment, templateHtml: string): Node[] | undefined => {
  let nodes = takePreparedConditionalNodes(anchor);
  if (!nodes && isConditionalStartMarker(anchor)) {
    const end = conditionalRegionEnd(anchor);
    if (end && anchor.nextSibling !== end) nodes = clientShapedNodes(anchor.nextSibling, end);
  }
  if (!nodes || !isConditionalStartMarker(anchor)) return nodes;
  if (adoptedShapeMatches(logicalNodes(createNodes(templateHtml)), nodes)) return nodes;
  clearConditionalRegion(anchor);
  return undefined;
};

const adoptedShapeMatches = (expected: readonly Node[], actual: readonly Node[]): boolean =>
  expected.length === actual.length &&
  expected.every((node, index) => {
    const candidate = actual[index] as Node;
    if (node.nodeType === Node.TEXT_NODE && candidate.nodeType === Node.COMMENT_NODE) {
      return candidate.nodeValue === "td:text";
    }
    return (
      node.nodeType === candidate.nodeType &&
      (!(node instanceof Element) || node.localName === (candidate as Element).localName)
    );
  });

const createNodes = (templateHtml: string): Node[] => {
  const template = document.createElement("template");
  template.innerHTML = templateHtml;
  return Array.from(template.content.childNodes).map((node) => node.cloneNode(true));
};

/** The branch nodes a path can address: fresh template nodes minus the region end markers they carry. */
const logicalNodes = (nodes: readonly Node[]): Node[] => nodes.filter((node) => !isConditionalEndMarker(node));

const nodeAtState = (state: ConditionalState, path: readonly number[]): Node => {
  if (state.nodes.length <= 1) return nodeAt(state.nodes[0] as Node, path);
  const [firstIndex, ...rest] = path;
  return nodeAt(state.nodes[firstIndex ?? 0] as Node, rest);
};

const bindingWithin = (boundaryPath: readonly number[], bindingPath: readonly number[]): boolean =>
  boundaryPath.length <= bindingPath.length && boundaryPath.every((part, index) => bindingPath[index] === part);

/** The located boundary with the longest path containing the binding; a binding outside every boundary has none. */
const innermostOwner = <T extends { boundary: { path?: readonly number[] } }>(
  located: readonly T[],
  bindingPath: readonly number[],
): T | undefined => {
  let owner: T | undefined;
  for (const candidate of located) {
    const path = candidate.boundary.path ?? [];
    if (bindingWithin(path, bindingPath) && (!owner || path.length > (owner.boundary.path ?? []).length)) {
      owner = candidate;
    }
  }
  return owner;
};

const bindInteractive = (
  state: ConditionalState,
  options: ConditionalRuntimeOptions,
  bindings: readonly { binding: ConditionalBinding; index: number }[],
  cleanups: Array<() => void>,
): void => {
  for (const { binding } of bindings) {
    if (binding.kind === "event") {
      const target = nodeAtState(state, binding.path);
      if (!(target instanceof Element)) continue;
      const listener: EventListener = (event) => {
        const handler = options.readHandler(state.scope, binding);
        if (typeof handler === "function") {
          (handler as EventListener)(event);
        }
      };
      cleanups.push(delegate(target, binding.eventName, [], listener));
    } else if (binding.kind === "model") {
      const element = nodeAtState(state, binding.path) as Element;
      cleanups.push(options.bindControlTarget(state.scope, binding, element));
    }
  }
};

const bindNodes = (
  anchor: Comment,
  state: ConditionalState,
  options: ConditionalRuntimeOptions,
  bindings: readonly { binding: ConditionalBinding; index: number }[],
  cleanups: Array<() => void>,
  bindInteractiveBindings: boolean,
): void => {
  for (const { binding, index: bindingIndex } of bindings) {
    if (binding.kind === "text") {
      const node = nodeAtState(state, binding.path);
      const target = textAt(node, []);
      if (target !== node) {
        const rootIndex = state.nodes.indexOf(node);
        if (rootIndex !== -1) state.nodes[rootIndex] = target;
      }
      setText(target, options.readValue(state.scope, binding));
    } else if (
      binding.kind === "class" ||
      binding.kind === "attr" ||
      binding.kind === "style" ||
      binding.kind === "model"
    ) {
      options.applyValue(binding, nodeAtState(state, binding.path), options.readValue(state.scope, binding));
    } else if (binding.kind === "ref") {
      state.refCleanups.get(bindingIndex)?.();
      const refElement = nodeAtState(state, binding.path) as Element;
      const refCleanup = options.bindRefTarget(state.scope, binding, refElement);
      state.refCleanups.set(bindingIndex, refCleanup);
      if (cleanups !== state.cleanups) {
        cleanups.push(() => {
          const currentCleanup = state.refCleanups.get(bindingIndex);
          state.refCleanups.delete(bindingIndex);
          currentCleanup?.();
        });
      }
    } else if (binding.kind === "list") {
      const container = nodeAtState(state, binding.path);
      if (!(container instanceof Element)) continue;
      if (cleanups !== state.cleanups) cleanups.push(() => cleanupOwnedSubtree(container));
      options.mountList(
        binding,
        container,
        options.readDeclaration(state.scope, binding.each, binding.read) as readonly unknown[] | undefined,
        state.scope,
      );
    } else if (binding.kind === "if") {
      const target = nodeAtState(state, binding.path);
      if (cleanups !== state.cleanups) cleanups.push(() => cleanupOwnedSubtree(target));
      options.mountBranch(
        binding,
        target,
        options.readDeclaration(state.scope, binding.test, binding.read),
        state.scope,
      );
    }
  }
  if (bindInteractiveBindings) {
    bindInteractive(state, options, bindings, cleanups);
    if (cleanups === state.cleanups) state.interactiveBindingsBound = true;
  }
};

const setupHydration = (
  anchor: Comment,
  state: ConditionalState,
  options: ConditionalRuntimeOptions,
  adopted: boolean,
): Set<ConditionalBinding> => {
  const deferredBindings = new Set<ConditionalBinding>();
  const root: ParentNode =
    anchor.parentElement ?? state.nodes.find((node): node is Element => node instanceof Element) ?? document;
  // Phase 1: locate every boundary before any scheduler starts, so a failure
  // leaves no listener behind.
  const hydration = options.hydration;
  const located: Array<{
    boundary: NonNullable<ConditionalOptions["hydrationBoundaries"]>[number];
    handle: HydrationBoundaryHandle;
    entries: Array<{ binding: ConditionalBinding; index: number }>;
  }> = [];
  for (const boundary of options.hydrationBoundaries ?? []) {
    // Filled once every boundary is located: the innermost adopted boundary owns a binding, so a nested
    // boundary never registers the same listener, control, or ref as the boundary around it.
    const boundaryEntries: Array<{ binding: ConditionalBinding; index: number }> = [];
    const resolvedId = resolveBoundaryId(boundary, state.scope);
    if (resolvedId === undefined || resolvedId === null) {
      // Server nodes are being adopted through their markers, so an id that cannot be resolved must not fall
      // back to binding everything eagerly; a client-created branch has no markers and binds eagerly by design.
      if (adopted) {
        throw new Error(
          `Conditional hydration boundary could not be adopted: hydrate:id={${boundary.id}} resolved to no value.`,
        );
      }
      continue;
    }
    const handle = hydration.create(root, String(resolvedId), () => {
      const hydrationState = state.hydrationState!;
      const cleanups: Array<() => void> = [];
      const newlyHydrated: ConditionalBinding[] = [];
      let failure: { error: unknown } | undefined;
      const dispose = () => {
        hydrationState.pending.delete(rollback);
        for (const binding of newlyHydrated) hydrationState.bindings.delete(binding);
        runCleanups(cleanups);
      };
      const rollback = (error: unknown) => {
        if (failure) return;
        failure = { error };
        try {
          dispose();
        } finally {
          if (handle.ok) handle.value.dispose();
        }
      };
      try {
        bindNodes(anchor, state, options, boundaryEntries, cleanups, true);
        // The scheduler runs outside the branch effect. Hand these bindings back to it so their reads track.
        for (const { binding } of boundaryEntries) {
          hydrationState.bindings.add(binding);
          newlyHydrated.push(binding);
        }
        hydrationState.pending.add(rollback);
        hydrationState.revision.value++;
        // An error owner may consume a synchronous effect error after the re-tracking path rolls us back.
        if (failure) throw failure.error;
        return dispose;
      } catch (error) {
        try {
          rollback(error);
        } catch {
          // All disposers run; preserve the initialization failure if a disposer also throws.
        }
        throw error;
      }
    });
    if (!handle.ok) {
      // Missing markers mean the branch was created on the client and binds
      // eagerly. Duplicate or malformed SSR markers must not bind another
      // element silently.
      if (handle.error.kind === "missing") continue;
      throw new Error(`Conditional hydration boundary could not be adopted: ${handle.error.message}`);
    }
    located.push({ boundary, handle: handle.value, entries: boundaryEntries });
  }
  if (located.length > 0) {
    options.bindings.forEach((binding, index) => {
      innermostOwner(located, binding.path)?.entries.push({ binding, index });
    });
    state.hydrationState = { bindings: new Set(), revision: createStore({ value: 0 }), pending: new Set() };
  }
  // Phase 2: schedule.
  for (const { boundary, handle, entries } of located) {
    state.hydrationBoundaries.push(handle);
    state.hydrationCleanups.push(
      hydration.schedule(handle, {
        strategy: boundary.strategy ?? "load",
        ...(boundary.media ? { media: boundary.media } : {}),
        ...(boundary.interaction ? { interaction: boundary.interaction } : {}),
        ...(boundary.rootMargin ? { rootMargin: boundary.rootMargin } : {}),
        replayInteraction: true,
      }),
    );
    state.hydrationCleanups.push(() => handle.dispose());
    for (const { binding } of entries) deferredBindings.add(binding);
  }
  return deferredBindings;
};

const mountResolvedConditional = (
  root: Node,
  path: readonly number[],
  visible: unknown,
  scope: Record<string, unknown>,
  options: ConditionalRuntimeOptions,
  setup: typeof setupHydration | undefined,
): void => {
  const anchor = nodeAt(root, path);
  if (!(anchor instanceof Comment)) {
    return;
  }
  const signature = options.signature;
  const current = states.get(anchor);
  const adoptedNodes = current ? undefined : adoptableRegionNodes(anchor, options.templateHtml);
  if (!visible) {
    if (current) {
      try {
        cleanupOwnedSubtree(anchor);
      } finally {
        states.delete(anchor);
      }
    }
    if (adoptedNodes) removeAdoptedNodes(adoptedNodes);
    setPreparedConditionalNodeCount(anchor, 0);
    return;
  }
  if (current && current.signature !== signature) {
    cleanupOwnedSubtree(anchor);
  }
  const created = current?.signature === signature || adoptedNodes ? undefined : createNodes(options.templateHtml);
  const state =
    current && current.signature === signature
      ? current
      : {
          signature,
          descriptor: options.descriptor,
          nodes: adoptedNodes ?? logicalNodes(created ?? []),
          cleanups: [],
          refCleanups: new Map<number, () => void>(),
          scope: scopeFor(scope, options),
          sourceScope: scope,
          sourceScopeSnapshot: sourceScopeSnapshotFor(scope),
          localScopeKeys: localScopeKeysFor(options),
          interactiveBindingsBound: false,
          hydrationBoundaries: [],
          hydrationCleanups: [],
          hydrationDeferredBindings: new Set<ConditionalBinding>(),
          hydrationState: undefined,
        };
  states.set(anchor, state);
  if (state !== current) {
    registerOwnedSubtree(anchor, () => {
      if (states.get(anchor) !== state) return;
      states.delete(anchor);
      detachOwnerCleanup(anchor);
      setPreparedConditionalNodeCount(anchor, 0);
      cleanup(state);
    });
  }
  if (!ownerCleanupDisposers.has(anchor)) {
    const disposer = onOwnerCleanup(() => {
      cleanupOwnedSubtree(anchor);
    });
    if (disposer) ownerCleanupDisposers.set(anchor, disposer);
  }
  try {
    if (state !== current) {
      if (created) anchor.after(...created);
      state.hydrationDeferredBindings = setup?.(anchor, state, options, adoptedNodes !== undefined) ?? new Set();
    } else {
      updateScope(state, scope, options);
    }
    setPreparedConditionalNodeCount(anchor, state.nodes.length);
    // Read after the boundaries are set up: a "load" boundary hydrates synchronously above, and a later one must
    // run this effect again once it has bound its part.
    const hydrationState = state.hydrationState;
    if (hydrationState) void hydrationState.revision.value;
    const entries = options.bindings.flatMap((binding, index) =>
      state.hydrationDeferredBindings.has(binding) ? [] : [{ binding, index }],
    );
    bindNodes(anchor, state, options, entries, state.cleanups, !state.interactiveBindingsBound);
    if (!hydrationState || hydrationState.bindings.size === 0) {
      hydrationState?.pending.clear();
      return;
    }
    // A hydrated boundary already registered its listeners and controls; only its values are refreshed here.
    const hydratedEntries = options.bindings.flatMap((binding, index) =>
      hydrationState.bindings.has(binding) ? [{ binding, index }] : [],
    );
    bindNodes(anchor, state, options, hydratedEntries, state.cleanups, false);
    hydrationState.pending.clear();
  } catch (error) {
    for (const rollback of state.hydrationState?.pending ?? []) {
      try {
        rollback(error);
      } catch {
        // Roll back every pending boundary, retaining the update failure over cleanup failures.
      }
    }
    throw error;
  }
};

/**
 * The descriptor shapes the compiler emits for a branch the generic runtime drives. Every value carries its
 * reader, and a writable target carries its writer, so a generated descriptor that lost one cannot be written
 * against these types, and one that fell back to an expression string is rejected outright.
 */
type WithReader<T> = Omit<T, "read" | "expression" | "handler" | "initial"> & {
  read: (scope: Record<string, unknown>) => unknown;
};

/** A generated ref names the object it writes into and the property on it, never a path to re-walk. */
type GeneratedRef = Omit<RefBinding, "expression" | "owner" | "property"> & {
  owner: (scope: Record<string, unknown>) => unknown;
  property: string;
};

type GeneratedStore = WithReader<StoreDefinition>;

type GeneratedComponent = Omit<ComponentBoundary, "props" | "stores"> & {
  props: Array<WithReader<ComponentProp>>;
  stores: GeneratedStore[];
};

type GeneratedChildren = {
  bindings: GeneratedConditionalBinding[];
  stores?: GeneratedStore[];
  components?: GeneratedComponent[];
};

/** A generated value binding carries the setter that applies it, so this module imports none of them. */
type GeneratedValue<T> = WithReader<T> & { apply: ValueApplier };

/** A generated control carries both, so the form runtime reaches the bundle only through the branch using it. */
type GeneratedControl = Omit<WithReader<ModelBinding>, "write"> & { apply: ValueApplier; bind: TargetBinder };

/** A generated nested region carries the entry that mounts it, so this module never imports one. */
type GeneratedNestedList = Omit<WithReader<NestedListBinding>, keyof GeneratedChildren> &
  GeneratedChildren & { mount: ListMounter };

type GeneratedNestedBranch = Omit<WithReader<NestedConditionalBinding>, keyof GeneratedChildren> &
  GeneratedChildren & { mount: BranchMounter };

type GeneratedConditionalBinding =
  | WithReader<TextBinding>
  | GeneratedValue<ClassBinding>
  | WithReader<EventBinding>
  | GeneratedValue<AttributeBinding>
  | GeneratedValue<StyleBinding>
  | GeneratedRef
  | GeneratedControl
  | GeneratedNestedList
  | GeneratedNestedBranch;

/** The compiler always emits the signature and the generated entry never computes one, so the type demands it. */
export type GeneratedConditionalOptions = Omit<ConditionalOptions, keyof GeneratedChildren | "signature"> &
  GeneratedChildren & { signature: string };

/**
 * How a generated descriptor is driven: every value and declaration is read through the reader the compiler
 * emitted, and every setter, binder, and nested entry comes off the descriptor itself. Nothing here reaches a
 * binding runtime, so a branch that a generated module mounts leaves the class setter, the attribute policy,
 * the URL sanitizer, the form runtime, and the keyed list out of its bundle unless one of its own bindings
 * asks for it.
 */
// None of these close over the descriptor, so they are built once for the module rather than once per mount,
// and a branch is mounted again on every update.
const generatedAccessors = {
  readValue: (
    scope: Record<string, unknown>,
    source: { read?: ((scope: Record<string, unknown>) => unknown) | undefined },
  ) => read((source.read as (scope: Record<string, unknown>) => unknown)(scope)),
  readHandler: (scope: Record<string, unknown>, binding: EventBinding) =>
    (binding.read as (scope: Record<string, unknown>) => unknown)(scope),
  readDeclaration: (
    scope: Record<string, unknown>,
    _expression: string | undefined,
    reader: ((scope: Record<string, unknown>) => unknown) | undefined,
  ) => read((reader as (scope: Record<string, unknown>) => unknown)(scope)),
  applyValue: (binding: ConditionalBinding, node: Node, value: unknown) =>
    (binding as { apply: ValueApplier }).apply(node, value),
  bindRefTarget: (scope: Record<string, unknown>, binding: RefBinding, element: Element) =>
    bindRef(scope, binding.owner as (scope: Record<string, unknown>) => unknown, binding.property as string, element),
  bindControlTarget: (scope: Record<string, unknown>, binding: ModelBinding, element: Element) =>
    (binding as { bind: TargetBinder }).bind(scope, element),
  mountList: (
    binding: NestedListBinding,
    container: Element,
    items: readonly unknown[] | undefined,
    scope: Record<string, unknown>,
  ) => (binding.mount as ListMounter)(container, [], items, binding, scope),
  mountBranch: (binding: NestedConditionalBinding, node: Node, visible: unknown, scope: Record<string, unknown>) =>
    (binding.mount as BranchMounter)(node, [], visible, scope, binding),
} as const;

// A generated descriptor is built once per bind and handed back on every update, so its resolved form is kept
// with it rather than rebuilt each time. A nested branch's descriptor is the same object across mounts too.
const resolvedGeneratedOptions = new WeakMap<GeneratedConditionalOptions, ConditionalRuntimeOptions>();

const resolveGeneratedOptions = (options: GeneratedConditionalOptions): ConditionalRuntimeOptions => {
  const cached = resolvedGeneratedOptions.get(options);
  if (cached) return cached;
  const descriptor = options as ConditionalOptions;
  const resolved: ConditionalRuntimeOptions = {
    ...descriptor,
    ...generatedAccessors,
    descriptor,
    signature: options.signature,
    hydration: descriptor.hydration as HydrationRuntime,
  };
  resolvedGeneratedOptions.set(options, resolved);
  return resolved;
};

/**
 * How a hand-written descriptor is driven: expression strings are interpreted here, and the setters, the form
 * runtime, the keyed list, and the hydration runtime this module imports apply them. Only `mountConditional`
 * reaches this, so a bundle that never calls it drops all of them.
 */
const legacyAccessors = {
  readValue: (
    scope: Record<string, unknown>,
    source: { expression?: string | undefined; read?: ((scope: Record<string, unknown>) => unknown) | undefined },
  ) => read(source.read ? source.read(scope) : readLiteralExpression(scope, source.expression ?? "")),
  readHandler: readEvent,
  readDeclaration: readExpression,
  applyValue: (binding: ConditionalBinding, node: Node, value: unknown) => {
    if (binding.kind === "class") setClassPresence(node as Element, binding.className, value);
    else if (binding.kind === "attr") setAttributeValue(node as Element, binding.name, value);
    else if (binding.kind === "style") setStyleValue(node as Element, binding.name, value);
    else if (binding.kind === "model") {
      setControlValue(node as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, binding.property, value);
    }
  },
  // A hand-written ref may still carry the compiler's container reader, so the path string is the fallback.
  bindRefTarget: (scope: Record<string, unknown>, binding: RefBinding, element: Element) =>
    binding.owner && binding.property !== undefined
      ? bindRef(scope, binding.owner, binding.property, element)
      : setRef(scope, binding.expression ?? "", element),
  bindControlTarget: (scope: Record<string, unknown>, binding: ModelBinding, element: Element) =>
    bindControl(
      element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
      binding.property,
      () => readBinding(scope, binding),
      (value) => writeBinding(scope, binding, value),
    ),
  mountList: (
    binding: NestedListBinding,
    container: Element,
    items: readonly unknown[] | undefined,
    scope: Record<string, unknown>,
  ) => mountKeyedList(container, [], items, { ...binding, scope }),
  mountBranch: (binding: NestedConditionalBinding, node: Node, visible: unknown, scope: Record<string, unknown>) =>
    mountConditional(node, [], visible, scope, binding),
  hydration: { create: createHydrationBoundary, schedule: scheduleHydration },
} as const;

const resolveLegacyOptions = (options: ConditionalOptions, signature: string): ConditionalRuntimeOptions => ({
  ...options,
  ...legacyAccessors,
  descriptor: options,
  signature,
});

/** Mounts a hand-written descriptor, whose expression strings this module still interprets. */
export const mountConditional = (
  root: Node,
  path: readonly number[],
  visible: unknown,
  scope: Record<string, unknown>,
  options: ConditionalOptions,
): void => {
  // The same descriptor object keeps the branch state outright, so it is not serialized again on every update.
  const anchor = nodeAt(root, path);
  const current = anchor instanceof Comment ? states.get(anchor) : undefined;
  const signature = current && current.descriptor === options ? current.signature : legacySignature(options);
  mountResolvedConditional(root, path, visible, scope, resolveLegacyOptions(options, signature), setupHydration);
};

/**
 * The entry a generated module uses. It shares the branch lifecycle with `mountConditional` and nothing else:
 * the descriptor it takes has to carry every reader, setter, binder, and nested entry the branch needs, so this
 * entry never reaches the interpreters or the runtimes only they use.
 */
export const mountGeneratedConditional = (
  root: Node,
  path: readonly number[],
  visible: unknown,
  scope: Record<string, unknown>,
  options: GeneratedConditionalOptions,
): void => mountResolvedConditional(root, path, visible, scope, resolveGeneratedOptions(options), setupHydration);

/** Compiler-selected entry for a module whose generated regions declare no hydration boundaries. */
export const mountGeneratedConditionalWithoutHydration = (
  root: Node,
  path: readonly number[],
  visible: unknown,
  scope: Record<string, unknown>,
  options: GeneratedConditionalOptions,
): void => mountResolvedConditional(root, path, visible, scope, resolveGeneratedOptions(options), undefined);
