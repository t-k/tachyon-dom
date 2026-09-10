import { setClassPresence } from "./class.js";
import { bindRef, setAttributeValue, setRef, setStyleValue } from "./attr.js";
import { setText, textAt } from "./text.js";
import { bindControl, setControlValue, writeModelValue } from "./form.js";
import { mountConditional } from "./conditional.js";
import { createSignal, createStore, detachFromEffectOwner, effect, onOwnerCleanup, read, type Signal } from "./signal.js";
import { cleanupOwnedSubtree, registerOwnedSubtree, runCleanups } from "./subtree.js";
import { normalizeListKey } from "./key.js";
import {
  canAppendWithoutMoving,
  emptyParentScope,
  ensureListRegion,
  positionRecords,
  readItemPath,
  readPath,
  regionElements,
  replaceRegionContent,
  scopedItemFromSnapshot,
  syncParentScope,
  type ListCoreRegion,
  type ListRegionMarkers,
  type ParentScopeSnapshot,
} from "./list-core.js";
import { templateNodeAt } from "../conditional-marker.js";
import {
  createHydrationBoundary,
  scheduleHydration,
  type CompiledHydrationBoundary,
  type HydrationBoundaryHandle,
} from "./hydrate.js";

type ExpressionReader = (scope: Record<string, unknown>) => unknown;
type ExpressionWriter = (scope: Record<string, unknown>, value: unknown) => void;

/** Applies a value to the row node the compiler resolved. A generated descriptor carries its own. */
type ValueApplier = (node: Node, value: unknown) => void;
/** Binds a row target and returns its disposer. A generated descriptor carries its own. */
type TargetBinder = (scope: Record<string, unknown>, element: Element) => () => void;
/** Mounts a nested keyed list. A generated descriptor carries the entry that drives it. */
type ListMounter = (
  root: Element,
  path: readonly number[],
  items: readonly unknown[] | undefined,
  options: NestedListBinding,
  scope: Record<string, unknown>,
) => void;
/** Mounts a nested branch. A generated descriptor carries the entry that drives it, so this module has none. */
type BranchMounter = (
  root: Node,
  path: readonly number[],
  visible: unknown,
  scope: Record<string, unknown>,
  options: NestedConditionalBinding,
) => void;
/** Adopts and schedules a row hydration boundary. A generated descriptor carries its own. */
type HydrationRuntime = { create: typeof createHydrationBoundary; schedule: typeof scheduleHydration };

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
  apply?: ValueApplier;
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
  apply?: ValueApplier;
};

type StyleBinding = {
  kind: "style";
  path: number[];
  name: string;
  expression?: string;
  read?: ExpressionReader;
  apply?: ValueApplier;
};

type RefBinding = {
  kind: "ref";
  path: number[];
  expression?: string;
  /** Reads the object that holds the ref. A generated ref carries this and `property` instead of a path. */
  owner?: ExpressionReader;
  property?: string;
};

type ModelBinding = {
  kind: "model";
  path: number[];
  property: "value" | "checked";
  expression?: string;
  read?: ExpressionReader;
  write?: ExpressionWriter;
  apply?: ValueApplier;
  bind?: TargetBinder;
};

type NestedListBinding = {
  kind: "list";
  signature?: string;
  mount?: ListMounter;
  path: number[];
  each: string;
  read?: ExpressionReader;
  key: string;
  keyRead?: ExpressionReader;
  keyReadItem?: (item: unknown) => unknown;
  itemName: string;
  indexName?: string;
  updatePolicy?: "always" | "reference";
  templateHtml: string;
  bindings: Binding[];
  stores?: StoreDefinition[];
  hydrationBoundaries?: CompiledHydrationBoundary[];
  components?: ComponentBoundary[];
};

type StoreDefinition = {
  name: string;
  key?: string;
  initial?: string;
  read?: ExpressionReader;
};

type ComponentProp = {
  name: string;
  key?: string;
  expression?: string;
  read?: ExpressionReader;
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
  path: number[];
  test: string;
  read?: ExpressionReader;
  mount?: BranchMounter;
  templateHtml: string;
  bindings: Binding[];
  stores?: StoreDefinition[];
  hydrationBoundaries?: CompiledHydrationBoundary[];
  components?: ComponentBoundary[];
};

type Binding =
  | TextBinding
  | ClassBinding
  | EventBinding
  | AttributeBinding
  | StyleBinding
  | RefBinding
  | ModelBinding
  | NestedListBinding
  | NestedConditionalBinding;

type BindingPlanEntry = {
  binding: Binding;
  index: number;
};

type BindingPlan = {
  all: readonly BindingPlanEntry[];
  nonEvent: readonly BindingPlanEntry[];
  events: readonly BindingPlanEntry[];
  controls: readonly BindingPlanEntry[];
};

type HydrationPlan = {
  boundary: CompiledHydrationBoundary;
  bindings: BindingPlan;
};

type KeyedListOptions = {
  signature?: string;
  key: string;
  /** Parent scope names the compiler proved these rows can read. Absent means every parent key is tracked. */
  parentScopeKeys?: readonly string[];
  keyRead?: ExpressionReader;
  keyReadItem?: (item: unknown) => unknown;
  itemName: string;
  indexName?: string;
  updatePolicy?: "always" | "reference";
  region?: KeyedListRegion;
  scope?: Record<string, unknown>;
  templateHtml: string;
  bindings: Binding[];
  stores?: StoreDefinition[];
  hydrationBoundaries?: CompiledHydrationBoundary[];
  components?: ComponentBoundary[];
  hydration?: HydrationRuntime;
};

type KeyedListRegion = ListCoreRegion;

type RowRecord = {
  key: PropertyKey;
  element: Element;
  nodes: Node[];
  adoptedNodes: ReadonlySet<Node>;
  ownedNodes: Node[];
  scope: Record<string, unknown>;
  cleanups: Array<() => void>;
  refCleanups?: Map<number, () => void>;
  lastValues: unknown[];
  item: unknown;
  index: number;
  appliedParentScope: ParentScopeSnapshot;
  localScopeKeys: ReadonlySet<string>;
  revision: Signal<number>;
  hydrationBoundaries: HydrationBoundaryHandle[];
  hydrationCleanups: Array<() => void>;
};

type ListState = {
  signature: string;
  descriptor: KeyedListOptions;
  options: ListRuntimeOptions;
  /** The markers the rows live between. */
  markers: ListRegionMarkers;
  templateHtml: string;
  parentScope: ParentScopeSnapshot;
  records: Map<PropertyKey, RowRecord>;
  template: HTMLTemplateElement;
  elementIndices: number[];
  bindingPlan: BindingPlan;
  hydrationPlans: readonly HydrationPlan[];
  initialized: boolean;
  cleanups: Array<() => void>;
  ownerCleanupDispose: (() => void) | undefined;
};

type CleanupOutcome = { failed: false } | { failed: true; error: unknown };

/**
 * What the row lifecycle drives a descriptor through.
 *
 * A generated descriptor carries its own readers, setters, and binders, so the generated entry resolves to
 * accessors that only call back into it. A hand-written descriptor carries expression strings, so the
 * compatibility entry resolves to accessors that interpret them and apply them through this module's own
 * imports. Keeping each set behind its own entry is what makes the split real rather than nominal: a page that
 * mounts only generated lists never reaches the compatibility half, so the branch runtime, the form runtime,
 * the class setter, the attribute policy, and the URL sanitizer stay out of its bundle.
 */
type ListRuntimeOptions = KeyedListOptions & {
  /** The descriptor this was resolved from. Identity on it is what tells a re-mount from a new list. */
  descriptor: KeyedListOptions;
  signature: string;
  readValue: (
    scope: Record<string, unknown>,
    source: { expression?: string | undefined; read?: ExpressionReader | undefined },
  ) => unknown;
  readHandler: (scope: Record<string, unknown>, binding: EventBinding) => unknown;
  readDeclaration: (
    scope: Record<string, unknown>,
    expression: string | undefined,
    reader: ExpressionReader | undefined,
  ) => unknown;
  readKey: (item: unknown, index: number, scope: Record<string, unknown> | undefined) => unknown;
  applyValue: (binding: Binding, node: Node, value: unknown) => void;
  mountList: (
    binding: NestedListBinding,
    container: Element,
    items: readonly unknown[] | undefined,
    scope: Record<string, unknown>,
  ) => void;
  bindRefTarget: (scope: Record<string, unknown>, binding: RefBinding, element: Element) => () => void;
  bindControlTarget: (scope: Record<string, unknown>, binding: ModelBinding, element: Element) => () => void;
  mountBranch: (
    binding: NestedConditionalBinding,
    node: Node,
    visible: unknown,
    scope: Record<string, unknown>,
  ) => void;
  /**
   * Adopts and schedules the row boundaries. Only the boundary loops reach it, and they run only for a
   * descriptor that declares boundaries - which is exactly when the compiler emits one.
   */
  hydration: HydrationRuntime;
};

// Keyed by the region start marker rather than the container, so sibling lists in one parent keep their own state.
const listStates = new WeakMap<Comment, ListState>();

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

// The compatibility interpreters. A hand-written descriptor may carry a reader for some values and a path
// string for the rest, so each one still prefers the reader when it is there.
const readBinding = (
  scope: Record<string, unknown>,
  binding: { expression?: string | undefined; read?: ExpressionReader | undefined },
): unknown => read(binding.read ? binding.read(scope) : readPath(scope, binding.expression ?? ""));

const readHandler = (scope: Record<string, unknown>, binding: EventBinding): unknown =>
  binding.read ? binding.read(scope) : readPath(scope, binding.handler ?? "");

const readExpression = (
  scope: Record<string, unknown>,
  expression: string | undefined,
  reader?: ExpressionReader,
): unknown => read(reader ? reader(scope) : readLiteralExpression(scope, expression ?? ""));

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

const localScopeKeysFor = (options: KeyedListOptions): ReadonlySet<string> =>
  new Set([
    ...(options.stores ?? []).flatMap((store) => [store.name, store.key ?? store.name]),
    ...(options.components ?? []).flatMap((component) => [
      ...component.props.flatMap((prop) => [prop.name, prop.key ?? prop.name]),
      ...component.stores.flatMap((store) => [store.name, store.key ?? store.name]),
    ]),
  ]);

const scopedItem = (
  itemName: string,
  item: unknown,
  indexName: string | undefined,
  index: number,
  scope: Record<string, unknown> | undefined,
): Record<string, unknown> => ({ ...scope, [itemName]: item, ...(indexName ? { [indexName]: index } : {}) });

// Row scopes are built from the same restricted parent snapshot that updates apply, so a row never starts with
// a parent key that later updates would stop maintaining.
const localScopeFor = (
  itemName: string,
  item: unknown,
  indexName: string | undefined,
  index: number,
  parent: ReadonlyMap<string, unknown>,
  options: ListRuntimeOptions,
): Record<string, unknown> => {
  const definitions = [
    ...(options.stores ?? []),
    ...(options.components ?? []).flatMap((component) => component.stores),
  ];
  const base = scopedItemFromSnapshot(itemName, item, indexName, index, parent);
  const scope = definitions.length > 0 ? createStore(base) : base;
  for (const store of options.stores ?? []) {
    scope[store.key ?? store.name] = options.readDeclaration(scope, store.initial, store.read);
  }
  for (const component of options.components ?? []) {
    for (const prop of component.props) {
      scope[prop.key ?? prop.name] = options.readDeclaration(scope, prop.expression, prop.read);
    }
    for (const store of component.stores) {
      scope[store.key ?? store.name] = options.readDeclaration(scope, store.initial, store.read);
    }
  }
  return scope;
};

const updateComponentProps = (scope: Record<string, unknown>, options: ListRuntimeOptions): void => {
  for (const component of options.components ?? []) {
    for (const prop of component.props) {
      scope[prop.key ?? prop.name] = options.readDeclaration(scope, prop.expression, prop.read);
    }
  }
};

const nodeAt = (root: Node, path: readonly number[]): Node => {
  let current = root;
  for (const index of path) {
    current = current.childNodes[index] as Node;
  }
  return current;
};

const nodeAtIgnoringHydrationMarkers = (root: Node, path: readonly number[]): Node =>
  templateNodeAt(root, path) as Node;

const nodeAtRecord = (record: RowRecord, path: readonly number[]): Node => {
  if (record.nodes.length <= 1) {
    return nodeAtIgnoringHydrationMarkers(record.element, path);
  }
  const [firstIndex, ...rest] = path;
  const root = record.nodes[firstIndex ?? 0] ?? record.element;
  return nodeAtIgnoringHydrationMarkers(root, rest);
};

/** A generated boundary carries a compiled reader; a hand-written one still names a dotted path. */
const resolveBoundaryId = (boundary: CompiledHydrationBoundary, scope: Record<string, unknown>): unknown =>
  boundary.idRead
    ? read(boundary.idRead(scope))
    : boundary.idKind === "expression"
      ? readPath(scope, boundary.id)
      : boundary.id;

const unresolvedBoundaryIdMessage = (key: PropertyKey, boundary: CompiledHydrationBoundary): string =>
  `Hydration boundary for list row ${String(key)} could not be adopted: hydrate:id={${boundary.id}} resolved to no value.`;

const bindingWithin = (boundaryPath: readonly number[], bindingPath: readonly number[]): boolean =>
  boundaryPath.length <= bindingPath.length && boundaryPath.every((part, index) => bindingPath[index] === part);

const bindingPlanFromEntries = (all: readonly BindingPlanEntry[]): BindingPlan => ({
  all,
  nonEvent: all.filter(({ binding }) => binding.kind !== "event"),
  events: all.filter(({ binding }) => binding.kind === "event"),
  controls: all.filter(({ binding }) => binding.kind === "model"),
});

const bindingPlanFor = (bindings: readonly Binding[]): BindingPlan =>
  bindingPlanFromEntries(bindings.map((binding, index) => ({ binding, index })));

const listPlansFor = (
  options: KeyedListOptions,
): { bindingPlan: BindingPlan; hydrationPlans: readonly HydrationPlan[] } => {
  const bindingPlan = bindingPlanFor(options.bindings);
  const hydrationPlans = (options.hydrationBoundaries ?? []).map((boundary) => ({
    boundary,
    bindings: bindingPlanFromEntries(
      bindingPlan.all.filter(({ binding }) => bindingWithin(boundary.path ?? [], binding.path)),
    ),
  }));
  return { bindingPlan, hydrationPlans };
};

const textAtRecord = (record: RowRecord, path: readonly number[]): Text => {
  const node = nodeAtRecord(record, path);
  if (node.nodeType === Node.COMMENT_NODE && node.nodeValue === "td:text") {
    return textAt(node, []);
  }
  if (node.nodeType !== Node.TEXT_NODE) {
    throw new TypeError(`Text binding path ${path.join(".")} resolved to ${node.nodeName} instead of a Text node.`);
  }
  return node as Text;
};

const createTemplate = (templateHtml: string): HTMLTemplateElement => {
  const template = document.createElement("template");
  template.innerHTML = templateHtml;
  return template;
};

const legacySignature = (options: KeyedListOptions): string =>
  options.signature ??
  JSON.stringify({
    key: options.key,
    itemName: options.itemName,
    indexName: options.indexName,
    updatePolicy: options.updatePolicy,
    region: options.region,
    templateHtml: options.templateHtml,
    bindings: options.bindings,
    stores: options.stores ?? [],
    hydrationBoundaries: options.hydrationBoundaries ?? [],
    components: options.components ?? [],
  });

const updateListPlans = (state: ListState, options: ListRuntimeOptions): void => {
  const plans = listPlansFor(options);
  state.descriptor = options.descriptor;
  state.options = options;
  state.bindingPlan = plans.bindingPlan;
  state.hydrationPlans = plans.hydrationPlans;
};

const cleanupListState = (state: ListState): void => {
  state.ownerCleanupDispose?.();
  state.ownerCleanupDispose = undefined;
  let firstError: unknown;
  let failed = false;
  try {
    runCleanups(state.cleanups);
  } catch (error) {
    firstError = error;
    failed = true;
  }
  for (const record of state.records.values()) {
    try {
      cleanupRecord(record);
    } catch (error) {
      if (!failed) firstError = error;
      failed = true;
    }
  }
  state.records.clear();
  if (failed) throw firstError;
};

const getListState = (container: Element, options: ListRuntimeOptions): ListState => {
  const markers = ensureListRegion(container, options.region);
  const current = listStates.get(markers.start);
  if (current && current.descriptor === options.descriptor) {
    return current;
  }
  const signature = options.signature;
  if (current && current.signature === signature) {
    updateListPlans(current, options);
    return current;
  }
  if (current) {
    cleanupOwnedSubtree(markers.start);
  }
  const template = createTemplate(options.templateHtml);
  const elementIndices = Array.from(template.content.childNodes).flatMap((node, index) =>
    node instanceof Element ? [index] : [],
  );
  const next: ListState = {
    signature,
    descriptor: options.descriptor,
    options,
    markers,
    templateHtml: options.templateHtml,
    parentScope: emptyParentScope,
    records: new Map<PropertyKey, RowRecord>(),
    template,
    elementIndices,
    ...(() => {
      const plans = listPlansFor(options);
      return {
        bindingPlan: plans.bindingPlan,
        hydrationPlans: plans.hydrationPlans,
      };
    })(),
    initialized: false,
    cleanups: [] as Array<() => void>,
    ownerCleanupDispose: undefined,
  };
  listStates.set(markers.start, next);
  registerOwnedSubtree(markers.start, () => {
    if (listStates.get(markers.start) !== next) return;
    try {
      cleanupListState(next);
    } finally {
      listStates.delete(markers.start);
    }
  });
  next.ownerCleanupDispose = onOwnerCleanup(() => {
    cleanupOwnedSubtree(markers.start);
  });
  return next;
};

const cleanupRecord = (record: RowRecord, preserveAdoptedNodes = false): void => {
  let firstError: unknown;
  let failed = false;
  try {
    runCleanups(record.cleanups);
  } catch (error) {
    firstError = error;
    failed = true;
  }
  const refCleanups = record.refCleanups ? Array.from(record.refCleanups.values()) : [];
  record.refCleanups?.clear();
  try {
    runCleanups(refCleanups);
  } catch (error) {
    if (!failed) firstError = error;
    failed = true;
  }
  try {
    runCleanups(record.hydrationCleanups.splice(0));
  } catch (error) {
    if (!failed) firstError = error;
    failed = true;
  }
  record.hydrationBoundaries.splice(0);
  const removableNodes = preserveAdoptedNodes ? new Set(record.ownedNodes) : new Set(record.nodes);
  for (const node of record.nodes) {
    try {
      cleanupOwnedSubtree(node);
    } catch (error) {
      if (!failed) firstError = error;
      failed = true;
    } finally {
      if (removableNodes.has(node)) {
        node.parentNode?.removeChild(node);
      }
    }
  }
  if (failed) throw firstError;
};

const shouldApplyValue = (record: RowRecord, index: number, value: unknown): boolean => {
  if (Object.is(record.lastValues[index], value)) {
    return false;
  }
  record.lastValues[index] = value;
  return true;
};

const applyRowBinding = (
  record: RowRecord,
  scope: Record<string, unknown>,
  options: ListRuntimeOptions,
  binding: Binding,
  index: number,
): void => {
  record.revision();
  if (binding.kind === "text") {
    const value = options.readValue(scope, binding);
    if (shouldApplyValue(record, index, value)) {
      setText(textAtRecord(record, binding.path), value);
    }
  } else if (
    binding.kind === "class" ||
    binding.kind === "attr" ||
    binding.kind === "style" ||
    binding.kind === "model"
  ) {
    const value = options.readValue(scope, binding);
    if (shouldApplyValue(record, index, value)) {
      options.applyValue(binding, nodeAtRecord(record, binding.path), value);
    }
  } else if (binding.kind === "ref") {
    record.refCleanups?.get(index)?.();
    const refCleanups = record.refCleanups ?? (record.refCleanups = new Map());
    const element = nodeAtRecord(record, binding.path) as Element;
    refCleanups.set(index, options.bindRefTarget(scope, binding, element));
  } else if (binding.kind === "list") {
    const value = options.readValue(scope, { expression: binding.each, read: binding.read }) as
      | readonly unknown[]
      | undefined;
    const container = nodeAtRecord(record, binding.path);
    if (container instanceof Element) {
      options.mountList(binding, container, value, scope);
    }
  } else if (binding.kind === "if") {
    const value = options.readValue(scope, { expression: binding.test, read: binding.read });
    options.mountBranch(binding, nodeAtRecord(record, binding.path), value, scope);
  }
};

const bindRowBindings = (
  record: RowRecord,
  options: ListRuntimeOptions,
  plan: BindingPlan,
  cleanups: Array<() => void>,
): void => {
  if (plan.nonEvent.length === 0) {
    return;
  }
  // Row effects outlive the list effect run that created them; rows are released through `cleanups`.
  cleanups.push(
    detachFromEffectOwner(() =>
      effect(() => {
        for (const { binding, index } of plan.nonEvent) {
          applyRowBinding(record, record.scope, options, binding, index);
        }
      }),
    ),
  );
};

const bindRowEvents = (
  record: RowRecord,
  options: ListRuntimeOptions,
  plan: BindingPlan,
  cleanups: Array<() => void>,
): void => {
  const delegateKeys = new Set<string>();
  for (const { binding } of plan.events) {
    if (binding.kind !== "event") {
      continue;
    }
    const delegateKey = `${binding.eventName}:${binding.path.join(".")}:${binding.handler}`;
    if (delegateKeys.has(delegateKey)) {
      continue;
    }
    delegateKeys.add(delegateKey);
    const target = nodeAtRecord(record, binding.path);
    if (!(target instanceof Element)) {
      continue;
    }
    const listener: EventListener = (event) => {
      const handler = options.readHandler(record.scope, binding);
      if (typeof handler === "function") {
        (handler as EventListener)(event);
      }
    };
    target.addEventListener(binding.eventName, listener);
    cleanups.push(() => target.removeEventListener(binding.eventName, listener));
  }
};

const bindRowControls = (
  record: RowRecord,
  options: ListRuntimeOptions,
  plan: BindingPlan,
  cleanups: Array<() => void>,
): void => {
  for (const { binding } of plan.controls) {
    if (binding.kind !== "model") {
      continue;
    }
    const element = nodeAtRecord(record, binding.path) as Element;
    cleanups.push(options.bindControlTarget(record.scope, binding, element));
  }
};

const bindRow = (
  record: RowRecord,
  options: ListRuntimeOptions,
  plan: BindingPlan,
  cleanups: Array<() => void>,
): void => {
  bindRowEvents(record, options, plan, cleanups);
  bindRowBindings(record, options, plan, cleanups);
  detachFromEffectOwner(() => bindRowControls(record, options, plan, cleanups));
};

const keyFor = (
  item: unknown,
  index: number,
  options: ListRuntimeOptions,
  scope: Record<string, unknown> | undefined,
): PropertyKey => normalizeListKey(read(options.readKey(item, index, scope)));

const isProductionEnvironment = (): boolean => typeof process !== "undefined" && process.env.NODE_ENV === "production";

const warnDuplicateKey = (key: PropertyKey, options: ListRuntimeOptions): void => {
  if (isProductionEnvironment() || typeof console.warn !== "function") {
    return;
  }
  const location = options.signature ? ` ${options.signature}` : "";
  console.warn(
    `Duplicate key ${JSON.stringify(String(key))} in keyed <for> list${location}. Later items with the same key were skipped.`,
  );
};

const createRecord = (
  state: ListState,
  key: PropertyKey,
  item: unknown,
  options: ListRuntimeOptions,
  parentScope: ParentScopeSnapshot,
  existingElements?: readonly Element[],
  index = 0,
): RowRecord | undefined => {
  const nodes = Array.from(state.template.content.childNodes).map((node) => node.cloneNode(true));
  if (existingElements) {
    state.elementIndices.forEach((nodeIndex, elementIndex) => {
      const existing = existingElements[elementIndex];
      if (existing) nodes[nodeIndex] = existing;
    });
  }
  const element = nodes.find((node): node is Element => node instanceof Element);
  if (!element) {
    return undefined;
  }
  const scope = localScopeFor(options.itemName, item, options.indexName, index, parentScope.values, options);
  const adoptedNodes = new Set<Node>(existingElements ?? []);
  const record: RowRecord = {
    key,
    element,
    nodes,
    adoptedNodes,
    ownedNodes: nodes.filter((node) => !adoptedNodes.has(node)),
    scope,
    cleanups: [],
    lastValues: [],
    item,
    index,
    appliedParentScope: parentScope,
    localScopeKeys: localScopeKeysFor(options),
    revision: createSignal(0),
    hydrationBoundaries: [],
    hydrationCleanups: [],
  };
  const adopted = existingElements !== undefined;
  try {
    const deferredBindings = new Set<Binding>();
    // Phase 1: locate every boundary of this row before starting any
    // listener or effect. Adopted SSR rows must have well-formed markers;
    // rows created on the client have none and bind eagerly.
    const located: Array<{
      boundary: HydrationPlan["boundary"];
      handle: HydrationBoundaryHandle;
      owned: { plan: BindingPlan };
    }> = [];
    const hydration = options.hydration;
    for (const hydrationPlan of state.hydrationPlans) {
      const { boundary } = hydrationPlan;
      // Narrowed once every boundary is located: the innermost adopted boundary owns a binding, so a nested
      // boundary never registers the same listener or control as the boundary around it.
      const owned = { plan: hydrationPlan.bindings };
      const resolvedId = resolveBoundaryId(boundary, scope);
      if (resolvedId === undefined || resolvedId === null) {
        // A server row is being adopted through its markers, so an id that cannot be resolved must not fall
        // back to binding everything eagerly; a client-created row has no markers and binds eagerly by design.
        if (adopted) throw new Error(unresolvedBoundaryIdMessage(key, boundary));
        continue;
      }
      const handle = hydration.create(record.element.parentElement ?? record.element, String(resolvedId), () => {
        const cleanups: Array<() => void> = [];
        bindRow(record, options, owned.plan, cleanups);
        return () => runCleanups(cleanups);
      });
      if (handle.ok) {
        located.push({ boundary, handle: handle.value, owned });
        continue;
      }
      if (adopted || handle.error.kind !== "missing") {
        throw new Error(`Hydration boundary for list row ${String(key)} could not be adopted: ${handle.error.message}`);
      }
    }
    if (located.length > 1) {
      for (const entry of located) {
        const depth = (entry.boundary.path ?? []).length;
        entry.owned.plan = bindingPlanFromEntries(
          entry.owned.plan.all.filter(
            ({ binding }) =>
              !located.some((other) => {
                const path = other.boundary.path ?? [];
                return path.length > depth && bindingWithin(path, binding.path);
              }),
          ),
        );
      }
    }
    // Phase 2: schedule the located boundaries.
    for (const { boundary, handle, owned } of located) {
      record.hydrationBoundaries.push(handle);
      record.hydrationCleanups.push(
        hydration.schedule(handle, {
          strategy: boundary.strategy ?? "load",
          ...(boundary.media ? { media: boundary.media } : {}),
          ...(boundary.interaction ? { interaction: boundary.interaction } : {}),
          ...(boundary.rootMargin ? { rootMargin: boundary.rootMargin } : {}),
          replayInteraction: true,
        }),
      );
      record.hydrationCleanups.push(() => handle.dispose());
      for (const { binding } of owned.plan.all) deferredBindings.add(binding);
    }
    // Rows created on the client have no SSR hydration markers, so every
    // binding whose boundary could not be adopted is bound eagerly. Only
    // bindings owned by an adopted boundary stay deferred.
    const eagerPlan =
      deferredBindings.size === 0
        ? state.bindingPlan
        : bindingPlanFromEntries(state.bindingPlan.all.filter(({ binding }) => !deferredBindings.has(binding)));
    bindRow(record, options, eagerPlan, record.cleanups);
    return record;
  } catch (error) {
    try {
      cleanupRecord(record, true);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "List row creation and cleanup failed.");
    } finally {
    }
    throw error;
  }
};

const updateRecord = (
  record: RowRecord,
  item: unknown,
  index: number,
  options: ListRuntimeOptions,
  parentScope: ParentScopeSnapshot,
): void => {
  const scopeChanged = record.appliedParentScope !== parentScope;
  if (scopeChanged) {
    for (const key of record.appliedParentScope.values.keys()) {
      if (
        !parentScope.values.has(key) &&
        !record.localScopeKeys.has(key) &&
        key !== options.itemName &&
        key !== options.indexName
      ) {
        record.scope[key] = undefined;
      }
    }
    for (const [key, value] of parentScope.values) {
      if (record.localScopeKeys.has(key) || key === options.itemName || key === options.indexName) continue;
      record.scope[key] = value;
    }
    record.appliedParentScope = parentScope;
  }
  record.scope[options.itemName] = item;
  if (options.indexName) record.scope[options.indexName] = index;
  const itemChanged = !Object.is(record.item, item);
  const indexChanged = record.index !== index;
  // Recomputed on every update. An item kept by reference can still have different internals, and a prop
  // expression can read them, so skipping this on an unchanged reference would leave the prop stale.
  updateComponentProps(record.scope, options);
  record.item = item;
  record.index = index;
  if (options.updatePolicy === "reference" && !itemChanged && !indexChanged && !scopeChanged) {
    return;
  }
  record.revision.update((value) => value + 1);
};

// The parent scope travels beside the descriptor rather than inside it, so a nested list's descriptor stays
// the same object across rows and updates and its resolved form can be reused.
const mountResolvedKeyedList = (
  root: Element,
  path: readonly number[],
  items: readonly unknown[] | undefined,
  options: ListRuntimeOptions,
  scope: Record<string, unknown> | undefined,
): void => {
  const container = nodeAt(root, path);
  if (!(container instanceof Element)) {
    return;
  }
  const state = getListState(container, options);
  const cleanupRecordsNotIn = (
    records: Map<PropertyKey, RowRecord>,
    keep: Pick<ReadonlySet<PropertyKey>, "has">,
  ): CleanupOutcome => {
    let firstError: unknown;
    let failed = false;
    for (const [key, record] of records) {
      if (keep.has(key)) continue;
      try {
        cleanupRecord(record);
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
      } finally {
        records.delete(key);
      }
    }
    return failed ? { failed: true, error: firstError } : { failed: false };
  };
  if (!items) {
    const cleanupResult = cleanupRecordsNotIn(state.records, new Set());
    state.records.clear();
    if (cleanupResult.failed) throw cleanupResult.error;
    return;
  }
  const entries: Array<{ item: unknown; index: number; key: PropertyKey }> = [];
  const seenKeys = new Set<PropertyKey>();
  for (const [index, item] of items.entries()) {
    const key = keyFor(item, index, options, scope);
    if (seenKeys.has(key)) {
      warnDuplicateKey(key, options);
      continue;
    }
    seenKeys.add(key);
    entries.push({ item, index, key });
  }
  const parentScope = syncParentScope(state, scope, options.parentScopeKeys);
  const nextRecords = new Map<PropertyKey, RowRecord>();
  const orderedRecords: RowRecord[] = [];
  const createdRecords: RowRecord[] = [];
  const previousRecords = state.records;
  const inspectServerRows = !state.initialized && state.records.size === 0 && state.elementIndices.length > 0;
  const serverDynamicElements = inspectServerRows ? regionElements(state.markers) : [];
  const canAdoptServerRows = inspectServerRows && serverDynamicElements.length > 0;
  if (canAdoptServerRows) {
    for (const [entryIndex, entry] of entries.entries()) {
      const adoptable = serverDynamicElements.slice(
        entryIndex * state.elementIndices.length,
        (entryIndex + 1) * state.elementIndices.length,
      );
      if (state.hydrationPlans.length === 0) continue;
      // An id can read a row store or a component prop, so the preflight scope carries the row's declarations
      // the way the record's scope will.
      const scope = localScopeFor(
        options.itemName,
        entry.item,
        options.indexName,
        entry.index,
        parentScope.values,
        options,
      );
      for (const hydrationPlan of state.hydrationPlans) {
        const { boundary } = hydrationPlan;
        const resolvedId = resolveBoundaryId(boundary, scope);
        if (resolvedId === undefined || resolvedId === null) {
          throw new Error(unresolvedBoundaryIdMessage(entry.key, boundary));
        }
        const rowRoot = adoptable[0]?.parentElement ?? adoptable[0];
        if (!rowRoot) {
          throw new Error(
            `Hydration boundary for list row ${String(entry.key)} could not be adopted: missing row root.`,
          );
        }
        const handle = options.hydration.create(rowRoot, String(resolvedId), () => undefined);
        if (!handle.ok) {
          throw new Error(
            `Hydration boundary for list row ${String(entry.key)} could not be adopted: ${handle.error.message}`,
          );
        }
      }
    }
  }
  try {
    for (const [entryIndex, entry] of entries.entries()) {
      const existing = state.records.get(entry.key);
      const adoptable = canAdoptServerRows
        ? serverDynamicElements.slice(
            entryIndex * state.elementIndices.length,
            (entryIndex + 1) * state.elementIndices.length,
          )
        : undefined;
      const record =
        existing ?? createRecord(state, entry.key, entry.item, options, parentScope, adoptable, entry.index);
      if (!record) {
        continue;
      }
      if (existing) {
        updateRecord(record, entry.item, entry.index, options, parentScope);
      } else {
        createdRecords.push(record);
      }
      nextRecords.set(entry.key, record);
      orderedRecords.push(record);
    }
    const { end } = state.markers;
    if (canAdoptServerRows) {
      replaceRegionContent(
        state.markers,
        orderedRecords.flatMap((record) => record.nodes),
      );
    } else if (canAppendWithoutMoving(nextRecords, orderedRecords, previousRecords)) {
      const previousKeys = new Set(previousRecords.keys());
      for (const record of orderedRecords) {
        if (!previousKeys.has(record.key)) {
          for (const node of record.nodes) container.insertBefore(node, end);
        }
      }
    } else {
      positionRecords(container, orderedRecords, previousRecords, end);
    }
    state.records = nextRecords;
    state.initialized = true;
    createdRecords.length = 0;
    const cleanupResult = cleanupRecordsNotIn(previousRecords, nextRecords);
    if (cleanupResult.failed) throw cleanupResult.error;
  } catch (error) {
    let firstCleanupError: unknown;
    let cleanupFailed = false;
    for (const record of createdRecords) {
      try {
        cleanupRecord(record, true);
      } catch (cleanupError) {
        if (!cleanupFailed) firstCleanupError = cleanupError;
        cleanupFailed = true;
      } finally {
      }
    }
    if (cleanupFailed) {
      throw new AggregateError([error, firstCleanupError], "List update and rollback failed.");
    }
    throw error;
  }
};

/**
 * The descriptor shapes the compiler emits. Every value carries its reader, and a writable target carries its
 * writer, so a generated descriptor that lost one cannot be written against these types at all. They also drop
 * the expression strings outright, which turns a regression back to string interpretation into a type error
 * rather than a silently different value.
 */
type WithReader<T> = Omit<T, "read" | "expression" | "handler" | "initial"> & { read: ExpressionReader };

/** A generated ref names the object it writes into and the property on it, never a path to re-walk. */
type GeneratedRef = Omit<RefBinding, "expression" | "owner" | "property"> & {
  owner: ExpressionReader;
  property: string;
};

/** A generated value binding carries the setter that applies it, so this module imports none of them. */
type GeneratedValue<T> = WithReader<T> & { apply: ValueApplier };

/** A generated control carries both, so the form runtime reaches the bundle only through the row that uses it. */
type GeneratedControl = Omit<WithReader<ModelBinding>, "write"> & { apply: ValueApplier; bind: TargetBinder };

/** A generated nested region carries the entry that mounts it, so this module imports neither. */
type GeneratedNestedList = Omit<WithReader<NestedListBinding>, keyof GeneratedChildren> &
  GeneratedChildren & { mount: ListMounter };

/** A generated branch carries the entry that mounts it, so this module never imports a branch runtime. */
type GeneratedBranch = Omit<WithReader<NestedConditionalBinding>, keyof GeneratedChildren> &
  GeneratedChildren & { mount: BranchMounter };

type GeneratedStore = WithReader<StoreDefinition>;

type GeneratedComponent = Omit<ComponentBoundary, "props" | "stores"> & {
  props: Array<WithReader<ComponentProp>>;
  stores: GeneratedStore[];
};

type GeneratedChildren = {
  bindings: GeneratedBinding[];
  stores?: GeneratedStore[];
  components?: GeneratedComponent[];
};

type GeneratedBinding =
  | WithReader<TextBinding>
  | GeneratedValue<ClassBinding>
  | WithReader<EventBinding>
  | GeneratedValue<AttributeBinding>
  | GeneratedValue<StyleBinding>
  | GeneratedRef
  | GeneratedControl
  | GeneratedNestedList
  | GeneratedBranch;

/**
 * The compiler always emits the signature, and the generated entry never computes one, so the type demands it:
 * two descriptors that both left it out would otherwise compare equal and share a container's state.
 */
export type GeneratedKeyedListOptions = Omit<KeyedListOptions, keyof GeneratedChildren | "signature"> &
  GeneratedChildren & { signature: string };

/**
 * How a generated descriptor is driven: every value, key, and declaration is read through the reader the
 * compiler emitted, and every setter, binder, and branch entry comes off the descriptor itself. Nothing here
 * reaches a binding runtime, so a page whose lists are all generated leaves the branch runtime, the form
 * runtime, the class setter, the attribute policy, and the URL sanitizer out of its bundle.
 */
// Only the key reader closes over the descriptor, so the rest are built once for the module rather than once
// per mount. A keyed list is mounted again on every update, and a nested one once per row on top of that.
const generatedAccessors = {
  readValue: (scope: Record<string, unknown>, source: { read?: ExpressionReader | undefined }) =>
    read((source.read as ExpressionReader)(scope)),
  readHandler: (scope: Record<string, unknown>, binding: EventBinding) => (binding.read as ExpressionReader)(scope),
  readDeclaration: (
    scope: Record<string, unknown>,
    _expression: string | undefined,
    reader: ExpressionReader | undefined,
  ) => read((reader as ExpressionReader)(scope)),
  applyValue: (binding: Binding, node: Node, value: unknown) => (binding as { apply: ValueApplier }).apply(node, value),
  mountList: (
    binding: NestedListBinding,
    container: Element,
    items: readonly unknown[] | undefined,
    scope: Record<string, unknown>,
  ) => (binding.mount as ListMounter)(container, [], items, binding, scope),
  bindRefTarget: (scope: Record<string, unknown>, binding: RefBinding, element: Element) =>
    bindRef(scope, binding.owner as ExpressionReader, binding.property as string, element),
  bindControlTarget: (scope: Record<string, unknown>, binding: ModelBinding, element: Element) =>
    (binding as { bind: TargetBinder }).bind(scope, element),
  mountBranch: (binding: NestedConditionalBinding, node: Node, visible: unknown, scope: Record<string, unknown>) =>
    (binding.mount as BranchMounter)(node, [], visible, scope, binding),
} as const;

// A generated descriptor is built once per bind and handed back on every update, and a nested list's descriptor
// is the row binding itself, so the resolved form is kept with it rather than rebuilt on every mount.
const resolvedGeneratedOptions = new WeakMap<GeneratedKeyedListOptions, ListRuntimeOptions>();

const resolveGeneratedOptions = (options: GeneratedKeyedListOptions): ListRuntimeOptions => {
  const cached = resolvedGeneratedOptions.get(options);
  if (cached) return cached;
  const descriptor = options as KeyedListOptions;
  const resolved: ListRuntimeOptions = {
    ...descriptor,
    ...generatedAccessors,
    descriptor,
    signature: options.signature,
    readKey: (item, index, scope) =>
      descriptor.keyReadItem
        ? descriptor.keyReadItem(item)
        : (descriptor.keyRead as ExpressionReader)(
            scopedItem(descriptor.itemName, item, descriptor.indexName, index, scope),
          ),
    hydration: descriptor.hydration as HydrationRuntime,
  };
  resolvedGeneratedOptions.set(options, resolved);
  return resolved;
};

/**
 * How a hand-written descriptor is driven: expression strings are interpreted here, and the setters, the form
 * runtime, and the branch runtime this module imports apply them. Only `mountKeyedList` reaches this, so a
 * bundle that never calls it drops all of them.
 */
const legacyAccessors = {
  readValue: readBinding,
  readHandler,
  readDeclaration: readExpression,
  applyValue: (binding: Binding, node: Node, value: unknown) => {
    if (binding.kind === "class") setClassPresence(node as Element, binding.className, value);
    else if (binding.kind === "attr") setAttributeValue(node as Element, binding.name, value);
    else if (binding.kind === "style") setStyleValue(node as Element, binding.name, value);
    else if (binding.kind === "model") {
      setControlValue(node as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, binding.property, value);
    }
  },
  mountList: (
    binding: NestedListBinding,
    container: Element,
    items: readonly unknown[] | undefined,
    scope: Record<string, unknown>,
  ) => mountKeyedList(container, [], items, { ...binding, scope }),
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
      (value) => {
        if (binding.write) {
          binding.write(scope, value);
          return;
        }
        const target = binding.read ? binding.read(scope) : readPath(scope, binding.expression ?? "");
        writeModelValue(target, value, () => writePath(scope, binding.expression ?? "", value));
      },
    ),
  mountBranch: (binding: NestedConditionalBinding, node: Node, visible: unknown, scope: Record<string, unknown>) =>
    mountConditional(node, [], visible, scope, binding),
  hydration: { create: createHydrationBoundary, schedule: scheduleHydration },
} as const;

const resolveLegacyOptions = (options: KeyedListOptions, signature: string): ListRuntimeOptions => ({
  ...options,
  ...legacyAccessors,
  descriptor: options,
  signature,
  readKey: (item, index, scope) =>
    options.keyReadItem
      ? options.keyReadItem(item)
      : options.keyRead
        ? options.keyRead(scopedItem(options.itemName, item, options.indexName, index, scope))
        : readItemPath(item, options.key, options.itemName),
});

/** Mounts a hand-written descriptor, whose expression strings this module still interprets. */
export const mountKeyedList = (
  root: Element,
  path: readonly number[],
  items: readonly unknown[] | undefined,
  options: KeyedListOptions,
): void => {
  // The signature only decides whether the container keeps its state, and the same descriptor object keeps it
  // outright, so serializing the descriptor again on every update of an unchanged list would be wasted work.
  const container = nodeAt(root, path);
  const current =
    container instanceof Element ? listStates.get(ensureListRegion(container, options.region).start) : undefined;
  const signature = current && current.descriptor === options ? current.signature : legacySignature(options);
  mountResolvedKeyedList(root, path, items, resolveLegacyOptions(options, signature), options.scope);
};

/**
 * The entry a generated module uses. It shares the reconciliation and the row lifecycle with `mountKeyedList`
 * and nothing else: the descriptor it takes has to carry every reader, setter, binder, and branch entry the
 * rows need, so this entry never reaches the interpreters or the runtimes only they use.
 */
export const mountGeneratedKeyedList = (
  root: Element,
  path: readonly number[],
  items: readonly unknown[] | undefined,
  options: GeneratedKeyedListOptions,
  scope: Record<string, unknown> | undefined = options.scope,
): void => mountResolvedKeyedList(root, path, items, resolveGeneratedOptions(options), scope);
