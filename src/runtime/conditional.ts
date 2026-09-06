import { setClassPresence } from "./class.js";
import { setAttributeValue, setRef, setStyleValue } from "./attr.js";
import { delegate } from "./event.js";
import { bindControl, setControlValue, writeModelValue } from "./form.js";
import { mountKeyedList } from "./list.js";
import { cleanupOwnedSubtree, registerOwnedSubtree, runCleanups } from "./subtree.js";
import { setText } from "./text.js";
import { createStore, onOwnerCleanup, read } from "./signal.js";
import {
  createHydrationBoundary,
  scheduleHydration,
  type CompiledHydrationBoundary,
  type HydrationBoundaryHandle,
} from "./hydrate.js";

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
  initial: string;
  read?: (scope: Record<string, unknown>) => unknown;
};

type ComponentProp = {
  name: string;
  expression: string;
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
};

type ConditionalState = {
  signature: string;
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

const signatureFor = (options: ConditionalOptions): string => options.signature ?? JSON.stringify(options);

const sourceScopeSnapshotFor = (scope: Record<string, unknown>): Map<string, unknown> =>
  new Map(Object.keys(scope).map((key) => [key, scope[key]] as const));

const sourceScopeChanged = (previous: ReadonlyMap<string, unknown>, next: ReadonlyMap<string, unknown>): boolean => {
  if (previous.size !== next.size) return true;
  for (const [key, value] of previous) {
    if (!next.has(key) || !Object.is(next.get(key), value)) return true;
  }
  return false;
};

const localScopeKeysFor = (options: ConditionalOptions): ReadonlySet<string> =>
  new Set([
    ...(options.stores ?? []).map((store) => store.name),
    ...(options.components ?? []).flatMap((component) => [
      ...component.props.map((prop) => prop.name),
      ...component.stores.map((store) => store.name),
    ]),
  ]);

const readExpression = (
  scope: Record<string, unknown>,
  expression: string,
  reader: ((scope: Record<string, unknown>) => unknown) | undefined,
): unknown => read(reader ? reader(scope) : readLiteralExpression(scope, expression));

const scopeFor = (scope: Record<string, unknown>, options: ConditionalOptions): Record<string, unknown> => {
  const definitions = [
    ...(options.stores ?? []),
    ...(options.components ?? []).flatMap((component) => component.stores),
  ];
  const localScope = definitions.length > 0 ? createStore({ ...scope }) : scope;
  for (const store of options.stores ?? []) {
    localScope[store.name] = readExpression(localScope, store.initial, store.read);
  }
  for (const component of options.components ?? []) {
    for (const prop of component.props) {
      localScope[prop.name] = readExpression(localScope, prop.expression, prop.read);
    }
    for (const store of component.stores) {
      localScope[store.name] = readExpression(localScope, store.initial, store.read);
    }
  }
  return localScope;
};

const updateScope = (
  state: ConditionalState,
  sourceScope: Record<string, unknown>,
  options: ConditionalOptions,
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
      state.scope[prop.name] = readExpression(state.scope, prop.expression, prop.read);
    }
  }
  state.sourceScope = sourceScope;
  state.sourceScopeSnapshot = nextSnapshot;
  return changed;
};

const readBinding = (
  scope: Record<string, unknown>,
  binding: Exclude<ConditionalBinding, EventBinding | RefBinding | NestedListBinding | NestedConditionalBinding>,
): unknown => read(binding.read ? binding.read(scope) : readLiteralExpression(scope, binding.expression));

const readEvent = (scope: Record<string, unknown>, binding: EventBinding): unknown =>
  binding.read ? binding.read(scope) : readPath(scope, binding.handler);

const writeBinding = (scope: Record<string, unknown>, binding: ModelBinding, value: unknown): void => {
  if (binding.write) {
    binding.write(scope, value);
    return;
  }
  const target = binding.read ? binding.read(scope) : readPath(scope, binding.expression);
  writeModelValue(target, value, () => writePath(scope, binding.expression, value));
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
  bindings: readonly { binding: ConditionalBinding; index: number }[],
  cleanups: Array<() => void>,
): void => {
  for (const { binding } of bindings) {
    if (binding.kind === "event") {
      const target = nodeAtState(state, binding.path);
      if (!(target instanceof Element)) continue;
      const listener: EventListener = (event) => {
        const handler = readEvent(state.scope, binding);
        if (typeof handler === "function") {
          (handler as EventListener)(event);
        }
      };
      cleanups.push(delegate(target, binding.eventName, [], listener));
    } else if (binding.kind === "model") {
      const element = nodeAtState(state, binding.path) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      cleanups.push(
        bindControl(
          element,
          binding.property,
          () => readBinding(state.scope, binding),
          (value) => writeBinding(state.scope, binding, value),
        ),
      );
    }
  }
};

const bindNodes = (
  anchor: Comment,
  state: ConditionalState,
  options: ConditionalOptions,
  bindings: readonly { binding: ConditionalBinding; index: number }[],
  cleanups: Array<() => void>,
  bindInteractiveBindings: boolean,
): void => {
  for (const { binding, index: bindingIndex } of bindings) {
    if (binding.kind === "text") {
      setText(nodeAtState(state, binding.path) as Text, readBinding(state.scope, binding));
    } else if (binding.kind === "class") {
      setClassPresence(
        nodeAtState(state, binding.path) as Element,
        binding.className,
        readBinding(state.scope, binding),
      );
    } else if (binding.kind === "attr") {
      setAttributeValue(nodeAtState(state, binding.path) as Element, binding.name, readBinding(state.scope, binding));
    } else if (binding.kind === "style") {
      setStyleValue(nodeAtState(state, binding.path) as Element, binding.name, readBinding(state.scope, binding));
    } else if (binding.kind === "ref") {
      state.refCleanups.get(bindingIndex)?.();
      const refCleanup = setRef(state.scope, binding.expression, nodeAtState(state, binding.path) as Element);
      state.refCleanups.set(bindingIndex, refCleanup);
      if (cleanups !== state.cleanups) {
        cleanups.push(() => {
          if (state.refCleanups.get(bindingIndex) !== refCleanup) return;
          state.refCleanups.delete(bindingIndex);
          refCleanup();
        });
      }
    } else if (binding.kind === "model") {
      setControlValue(
        nodeAtState(state, binding.path) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
        binding.property,
        readBinding(state.scope, binding),
      );
    } else if (binding.kind === "list") {
      const container = nodeAtState(state, binding.path);
      if (!(container instanceof Element)) continue;
      mountKeyedList(
        container,
        [],
        readExpression(state.scope, binding.each, binding.read) as readonly unknown[] | undefined,
        { ...binding, scope: state.scope },
      );
    } else if (binding.kind === "if") {
      mountConditional(
        nodeAtState(state, binding.path),
        [],
        readExpression(state.scope, binding.test, binding.read),
        state.scope,
        binding,
      );
    }
  }
  if (bindInteractiveBindings) {
    bindInteractive(state, bindings, cleanups);
    if (cleanups === state.cleanups) state.interactiveBindingsBound = true;
  }
};

const setupHydration = (
  anchor: Comment,
  state: ConditionalState,
  options: ConditionalOptions,
): Set<ConditionalBinding> => {
  const deferredBindings = new Set<ConditionalBinding>();
  const root: ParentNode =
    anchor.parentElement ?? state.nodes.find((node): node is Element => node instanceof Element) ?? document;
  for (const boundary of options.hydrationBoundaries ?? []) {
    const resolvedId = boundary.idKind === "expression" ? readPath(state.scope, boundary.id) : boundary.id;
    if (resolvedId === undefined || resolvedId === null) continue;
    const boundaryEntries = options.bindings.flatMap((binding, index) =>
      bindingWithin(boundary.path ?? [], binding.path) ? [{ binding, index }] : [],
    );
    const handle = createHydrationBoundary(root, String(resolvedId), () => {
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
    state.hydrationBoundaries.push(handle.value);
    state.hydrationCleanups.push(
      scheduleHydration(handle.value, {
        strategy: boundary.strategy ?? "load",
        ...(boundary.media ? { media: boundary.media } : {}),
        ...(boundary.interaction ? { interaction: boundary.interaction } : {}),
        ...(boundary.rootMargin ? { rootMargin: boundary.rootMargin } : {}),
        replayInteraction: true,
      }),
    );
    state.hydrationCleanups.push(() => handle.value.dispose());
    for (const { binding } of boundaryEntries) deferredBindings.add(binding);
  }
  return deferredBindings;
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
      try {
        cleanupOwnedSubtree(anchor);
      } finally {
        states.delete(anchor);
      }
    }
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
          nodes: createNodes(options.templateHtml),
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
    anchor.after(...state.nodes);
    state.hydrationDeferredBindings = setupHydration(anchor, state, options);
  } else {
    updateScope(state, scope, options);
  }
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
