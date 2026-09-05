import { err, ok, type Result } from "../result.js";
import { hydrate, mount, type ClientTemplateModule, type HydrateError, type MountHandle } from "./mount.js";
import { batch, createRoot, createStore } from "./signal.js";

export type TemplateComponentOptions<
  Props extends object,
  Scope extends Record<string, unknown> = Record<string, unknown>,
> = {
  client: ClientTemplateModule<Scope>;
  scope?: (props: Props) => Scope;
  render?: (props: Props) => string;
  stream?: (props: Props) => AsyncIterable<string>;
};

export type TemplateComponentInstance<Props extends object> = MountHandle & {
  update: (props: Props) => void;
};

export type TemplateComponent<Props extends object, Scope extends Record<string, unknown> = Record<string, unknown>> = {
  client: ClientTemplateModule<Scope>;
  mount: (root: Element, props: Props) => TemplateComponentInstance<Props>;
  hydrate: (root: Element, props: Props) => Result<TemplateComponentInstance<Props>, HydrateError>;
  render: (props: Props) => string;
  stream: (props: Props) => AsyncIterable<string>;
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
    if (disposed || owner.disposed()) return;
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
    stream: (props) => {
      if (!options.stream) throw new Error("This template component does not provide a stream renderer.");
      return options.stream(props);
    },
  };
};
