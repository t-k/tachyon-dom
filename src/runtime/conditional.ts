import { setClassPresence } from "./class.js";
import { bindRef, setAttributeValue, setRef, setStyleValue } from "./attr.js";
import { delegate } from "./event.js";
import { bindControl, setControlValue, writeModelValue } from "./form.js";
import { mountKeyedList } from "./list.js";
import { cleanupOwnedSubtree, registerOwnedSubtree, runCleanups } from "./subtree.js";
import { setText } from "./text.js";
import { createStore, onOwnerCleanup, read } from "./signal.js";
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
  options: NestedListBinding & { scope: Record<string, unknown> },
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
};

const states = new WeakMap<Comment, ConditionalState>();
const ownerCleanupDisposers = new WeakMap<Comment, () => void>();

const detachOwnerCleanup = (anchor: Comment): void => {
  ownerCleanupDisposers.get(anchor)?.();
  ownerCleanupDisposers.delete(anchor);
};

export const nodeAt = (root: Node, path: readonly number[]): Node => {
  let current = root;
  for (const index of path) {
    // Skip SSR hydration marker comments so template paths stay valid.
    let cursor = 0;
    let next: Node | undefined;
    for (const child of Array.from(current.childNodes)) {
      if (child.nodeType === 8 && (child.nodeValue ?? "").startsWith("tachyon-hydrate:")) continue;
      if (cursor++ === index) {
        next = child;
        break;
      }
    }
    current = next as Node;
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
      node.parentNode?.removeChild(node);
    }
  }
  if (failed) throw firstError;
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

const bindingWithin = (boundaryPath: readonly number[], bindingPath: readonly number[]): boolean =>
  boundaryPath.length <= bindingPath.length && boundaryPath.every((part, index) => bindingPath[index] === part);

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
      setText(nodeAtState(state, binding.path) as Text, options.readValue(state.scope, binding));
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
          if (state.refCleanups.get(bindingIndex) !== refCleanup) return;
          state.refCleanups.delete(bindingIndex);
          refCleanup();
        });
      }
    } else if (binding.kind === "list") {
      const container = nodeAtState(state, binding.path);
      if (!(container instanceof Element)) continue;
      options.mountList(
        binding,
        container,
        options.readDeclaration(state.scope, binding.each, binding.read) as readonly unknown[] | undefined,
        state.scope,
      );
    } else if (binding.kind === "if") {
      options.mountBranch(
        binding,
        nodeAtState(state, binding.path),
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
    const resolvedId = boundary.idKind === "expression" ? readPath(state.scope, boundary.id) : boundary.id;
    if (resolvedId === undefined || resolvedId === null) continue;
    const boundaryEntries = options.bindings.flatMap((binding, index) =>
      bindingWithin(boundary.path ?? [], binding.path) ? [{ binding, index }] : [],
    );
    const handle = hydration.create(root, String(resolvedId), () => {
      const cleanups: Array<() => void> = [];
      bindNodes(anchor, state, options, boundaryEntries, cleanups, true);
      return () => runCleanups(cleanups);
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
): void => {
  const anchor = nodeAt(root, path);
  if (!(anchor instanceof Comment)) {
    return;
  }
  const signature = options.signature;
  const current = states.get(anchor);
  const adoptedNodes = current ? undefined : takePreparedConditionalNodes(anchor);
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
  const state =
    current && current.signature === signature
      ? current
      : {
          signature,
          descriptor: options.descriptor,
          nodes: adoptedNodes ?? createNodes(options.templateHtml),
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
  if (state !== current) {
    if (!adoptedNodes) anchor.after(...state.nodes);
    state.hydrationDeferredBindings = setupHydration(anchor, state, options);
  } else {
    updateScope(state, scope, options);
  }
  setPreparedConditionalNodeCount(anchor, state.nodes.length);
  const entries = options.bindings.flatMap((binding, index) =>
    state.hydrationDeferredBindings.has(binding) ? [] : [{ binding, index }],
  );
  if (
    !state.interactiveBindingsBound ||
    entries.some(({ binding }) => binding.kind !== "event" && binding.kind !== "model")
  ) {
    bindNodes(anchor, state, options, entries, state.cleanups, !state.interactiveBindingsBound);
  } else {
    bindNodes(anchor, state, options, entries, state.cleanups, false);
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

export type GeneratedConditionalOptions = Omit<ConditionalOptions, keyof GeneratedChildren> & GeneratedChildren;

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
    bindRef(
      scope,
      binding.owner as (scope: Record<string, unknown>) => unknown,
      binding.property as string,
      element,
    ),
  bindControlTarget: (scope: Record<string, unknown>, binding: ModelBinding, element: Element) =>
    (binding as { bind: TargetBinder }).bind(scope, element),
  mountList: (
    binding: NestedListBinding,
    container: Element,
    items: readonly unknown[] | undefined,
    scope: Record<string, unknown>,
  ) => (binding.mount as ListMounter)(container, [], items, { ...binding, scope }),
  mountBranch: (
    binding: NestedConditionalBinding,
    node: Node,
    visible: unknown,
    scope: Record<string, unknown>,
  ) => (binding.mount as BranchMounter)(node, [], visible, scope, binding),
} as const;

const resolveGeneratedOptions = (options: ConditionalOptions): ConditionalRuntimeOptions => ({
  ...options,
  ...generatedAccessors,
  descriptor: options,
  signature: options.signature as string,
  hydration: options.hydration as HydrationRuntime,
});

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
  mountBranch: (
    binding: NestedConditionalBinding,
    node: Node,
    visible: unknown,
    scope: Record<string, unknown>,
  ) => mountConditional(node, [], visible, scope, binding),
  hydration: { create: createHydrationBoundary, schedule: scheduleHydration },
} as const;

const resolveLegacyOptions = (options: ConditionalOptions): ConditionalRuntimeOptions => ({
  ...options,
  ...legacyAccessors,
  descriptor: options,
  signature: legacySignature(options),
});

/** Mounts a hand-written descriptor, whose expression strings this module still interprets. */
export const mountConditional = (
  root: Node,
  path: readonly number[],
  visible: unknown,
  scope: Record<string, unknown>,
  options: ConditionalOptions,
): void => mountResolvedConditional(root, path, visible, scope, resolveLegacyOptions(options));

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
): void => mountResolvedConditional(root, path, visible, scope, resolveGeneratedOptions(options as ConditionalOptions));
