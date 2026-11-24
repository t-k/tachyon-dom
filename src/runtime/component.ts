import { clearComponentRegion, componentRegionEnd, templateNodeAt } from "../conditional-marker.js";
import { err, ok, type Result } from "../result.js";
import { hydrate, mount, type ClientTemplateModule, type HydrateError, type MountHandle } from "./mount.js";
import { batch, createRoot, createStore, onCleanup, untrack } from "./signal.js";
import { registerOwnedSubtree } from "./subtree.js";

export type TemplateComponentOptions<
  Props extends object,
  Scope extends Record<string, unknown> = Record<string, unknown>,
> = {
  client: ClientTemplateModule<Scope>;
  scope?: (props: Props) => Scope;
  render?: (props: Props) => string;
  stream?: (props: Props, streamOptions?: unknown) => AsyncIterable<string>;
};

export type TemplateComponentInstance<Props extends object> = MountHandle & {
  update: (props: Props) => void;
};

export type TemplateComponent<Props extends object, Scope extends Record<string, unknown> = Record<string, unknown>> = {
  client: ClientTemplateModule<Scope>;
  mount: (root: Element, props: Props) => TemplateComponentInstance<Props>;
  hydrate: (root: Element, props: Props) => Result<TemplateComponentInstance<Props>, HydrateError>;
  render: (props: Props) => string;
  stream: (props: Props, streamOptions?: unknown) => AsyncIterable<string>;
};

const scopeFor = <Props extends object, Scope extends Record<string, unknown>>(
  options: TemplateComponentOptions<Props, Scope>,
  props: Props,
): Scope => (options.scope ? options.scope(props) : ({ ...props } as unknown as Scope));

type OwnedScope<Scope extends Record<string, unknown>> = {
  scope: Scope;
  dispose: () => void;
};

type OwnerState = {
  dispose: () => void;
  disposed: () => boolean;
  run: <Value>(fn: () => Value) => Value;
};

const createOwnedScope = <Props extends object, Scope extends Record<string, unknown>>(
  options: TemplateComponentOptions<Props, Scope>,
  props: Props,
): OwnedScope<Scope> => {
  let dispose = (): void => undefined;
  const scope = createRoot((disposeRoot) => {
    dispose = disposeRoot;
    return createStore(scopeFor(options, props)) as Scope;
  });
  return { scope, dispose };
};

const instanceFor = <Props extends object, Scope extends Record<string, unknown>>(
  scope: Scope,
  handle: MountHandle,
  options: TemplateComponentOptions<Props, Scope>,
  owner: OwnerState,
  scopeDispose: () => void,
): TemplateComponentInstance<Props> => {
  let scopeKeys = new Set<PropertyKey>(Reflect.ownKeys(scope));
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    let firstError: unknown;
    let failed = false;
    try {
      handle.dispose();
    } catch (error) {
      firstError = error;
      failed = true;
    }
    try {
      owner.dispose();
    } catch (error) {
      if (!failed) firstError = error;
      failed = true;
    }
    if (failed) throw firstError;
  };
  return {
    root: handle.root,
    disposed: () => disposed || owner.disposed() || handle.disposed(),
    dispose,
    update: (nextProps) => {
      if (disposed || owner.disposed() || handle.disposed()) return;
      const next = owner.run(() => createOwnedScope(options, nextProps));
      try {
        scopeDispose();
        batch(() => {
          for (const key of scopeKeys) {
            if (!Reflect.has(next.scope, key)) Reflect.set(scope, key, undefined);
          }
          Object.assign(scope, next.scope);
          scopeKeys = new Set<PropertyKey>(Reflect.ownKeys(next.scope));
        });
      } catch (error) {
        next.dispose();
        throw error;
      }
      scopeDispose = next.dispose;
    },
  };
};

export const createTemplateComponent = <
  Props extends object,
  Scope extends Record<string, unknown> = Record<string, unknown>,
>(
  options: TemplateComponentOptions<Props, Scope>,
): TemplateComponent<Props, Scope> => {
  const mountInstance = (root: Element, props: Props): TemplateComponentInstance<Props> => {
    let ownerDispose: () => void = () => undefined;
    let ownerRun: OwnerState["run"] = (fn) => fn();
    let ownerDisposed = (): boolean => false;
    const prepared = createRoot((dispose, runInOwner, isDisposed) => {
      ownerDispose = dispose;
      ownerRun = runInOwner;
      ownerDisposed = isDisposed;
      const ownedScope = createOwnedScope(options, props);
      const handle = mount(root, options.client, ownedScope.scope);
      // Parent owner disposal must run the mount cleanup too, not only the
      // nested reactive root.
      onCleanup(() => handle.dispose());
      return { scope: ownedScope.scope, handle, scopeDispose: ownedScope.dispose };
    });
    const owner: OwnerState = {
      dispose: ownerDispose,
      disposed: ownerDisposed,
      run: ownerRun,
    };
    return instanceFor(prepared.scope, prepared.handle, options, owner, prepared.scopeDispose);
  };
  const hydrateInstance = (root: Element, props: Props): Result<TemplateComponentInstance<Props>, HydrateError> => {
    let ownerDispose: () => void = () => undefined;
    let ownerRun: OwnerState["run"] = (fn) => fn();
    let ownerDisposed = (): boolean => false;
    const prepared = createRoot((dispose, runInOwner, isDisposed) => {
      ownerDispose = dispose;
      ownerRun = runInOwner;
      ownerDisposed = isDisposed;
      const ownedScope = createOwnedScope(options, props);
      const result = hydrate(root, options.client, ownedScope.scope);
      if (!result.ok) {
        dispose();
        return err(result.error);
      }
      onCleanup(() => result.value.dispose());
      return ok({ scope: ownedScope.scope, handle: result.value, scopeDispose: ownedScope.dispose });
    });
    if (!prepared.ok) return prepared;
    const owner: OwnerState = {
      dispose: ownerDispose,
      disposed: ownerDisposed,
      run: ownerRun,
    };
    return ok(instanceFor(prepared.value.scope, prepared.value.handle, options, owner, prepared.value.scopeDispose));
  };
  return {
    client: options.client,
    mount: mountInstance,
    hydrate: hydrateInstance,
    render: (props) => {
      if (!options.render) throw new Error("This template component does not provide a server renderer.");
      return options.render(props);
    },
    stream: (props, streamOptions) => {
      if (!options.stream) throw new Error("This template component does not provide a stream renderer.");
      return options.stream(props, streamOptions);
    },
  };
};

type ComponentCallState = {
  target: TemplateComponent<Record<string, unknown>>;
  instance: TemplateComponentInstance<Record<string, unknown>>;
};

const componentCallStates = new WeakMap<Comment, ComponentCallState>();

const isTemplateComponent = (value: unknown): value is TemplateComponent<Record<string, unknown>> =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { mount?: unknown }).mount === "function" &&
  typeof (value as { hydrate?: unknown }).hydrate === "function";

/** Resolves the component marker comment addressed by a template path. */
export const componentAnchorAt = (root: Node, path: readonly number[]): Node | undefined => templateNodeAt(root, path);

/** Disposes the child component instance bound to `anchor`, leaving DOM cleanup to its owning region. */
export const cleanupComponentCall = (anchor: Node | undefined): void => {
  if (!(anchor instanceof Comment)) return;
  const state = componentCallStates.get(anchor);
  if (!state) return;
  componentCallStates.delete(anchor);
  state.instance.dispose();
};

/**
 * Mounts, hydrates, or updates a declarative component call (`<Panel ... />`) between its comment markers.
 * Running inside an effect keeps parent prop expressions reactive while isolating child setup via `untrack`.
 */
export const mountComponentCall = (
  anchor: Node | undefined,
  target: unknown,
  props: Record<string, unknown>,
  name = "Component",
): void => {
  if (!(anchor instanceof Comment)) {
    throw new TypeError(`Component call <${name}> requires a component marker anchor.`);
  }
  const end = componentRegionEnd(anchor);
  if (!end) {
    throw new Error(`Component call <${name}> is missing its closing marker.`);
  }
  if (!isTemplateComponent(target)) {
    throw new TypeError(`Component call <${name}> requires a template component created with createTemplateComponent().`);
  }
  const existing = componentCallStates.get(anchor);
  if (existing) {
    if (existing.target === target) {
      untrack(() => existing.instance.update(props));
      return;
    }
    componentCallStates.delete(anchor);
    existing.instance.dispose();
    clearComponentRegion(anchor);
  }
  const between: Node[] = [];
  for (let node = anchor.nextSibling; node && node !== end; node = node.nextSibling) {
    between.push(node);
  }
  let instance: TemplateComponentInstance<Record<string, unknown>>;
  if (between.length > 0) {
    const elements: Element[] = [];
    for (const node of between) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        elements.push(node as Element);
      } else if (node.nodeType === Node.TEXT_NODE && (node.nodeValue ?? "").trim().length > 0) {
        throw new Error(`Component call <${name}> hydration mismatch: found unexpected text outside the child root.`);
      }
    }
    if (elements.length !== 1) {
      throw new Error(
        `Component call <${name}> hydration mismatch: expected a single root element, found ${elements.length}.`,
      );
    }
    const hydrated = untrack(() => target.hydrate(elements[0] as Element, props));
    if (!hydrated.ok) {
      throw new Error(`Component call <${name}> hydration failed: ${hydrated.error.message}`);
    }
    instance = hydrated.value;
  } else {
    const parent = anchor.parentNode;
    if (!parent) {
      throw new Error(`Component call <${name}> anchor is detached from the DOM.`);
    }
    const host = (anchor.ownerDocument ?? document).createElement("div");
    instance = untrack(() => target.mount(host, props));
    if (host.children.length !== 1) {
      instance.dispose();
      throw new Error(`Component call <${name}> must render a single root element.`);
    }
    for (const child of Array.from(host.childNodes)) {
      parent.insertBefore(child, end);
    }
  }
  componentCallStates.set(anchor, { target, instance });
  registerOwnedSubtree(anchor, () => cleanupComponentCall(anchor));
};
