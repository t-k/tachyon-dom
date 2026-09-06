type SubscriberSet = Set<EffectRunner>;

declare const __TACHYON_PRODUCTION__: boolean;

// Production browser builds define this flag so lifecycle diagnostics disappear from the hot path.
const lifecycleDiagnosticsEnabled = typeof __TACHYON_PRODUCTION__ === "undefined" || __TACHYON_PRODUCTION__ === false;

type EffectRunner = {
  id: number | undefined;
  disposed: boolean;
  computed: boolean;
  dependencies: Set<SubscriberSet>;
  children: Set<EffectRunner>;
  parent: EffectRunner | undefined;
  errorOwner: ReactiveErrorOwner | undefined;
  owner: Owner | undefined;
  runOwner: Owner;
  registration: CleanupRegistration | undefined;
  run: () => void;
};

type ReactiveErrorOwner = {
  disposed: boolean;
  parent: ReactiveErrorOwner | undefined;
  handle: (error: unknown) => void;
  runners: Set<EffectRunner>;
};

type Owner = {
  id: number | undefined;
  disposed: boolean;
  head: CleanupRegistration | undefined;
  tail: CleanupRegistration | undefined;
  parentRegistration: CleanupRegistration | undefined;
};

type OwnerRunner = <T>(fn: () => T) => T;

export type TemplateBindingSpan = readonly [
  index: number,
  kind: string,
  path: readonly number[],
  sourceStart: number,
  sourceEnd: number,
];

export type RuntimeLifecycleHooks = {
  templateBindingsRegistered?: (templateId: string, revision: string, bindings: readonly TemplateBindingSpan[]) => void;
  ownerCreated?: (id: number, bindingLocation?: string) => void;
  ownerDisposed?: (id: number) => void;
  effectCreated?: (id: number, ownerId: number | undefined, bindingLocation?: string) => void;
  effectDisposed?: (id: number) => void;
  subscriptionChanged?: (delta: 1 | -1) => void;
  cleanupChanged?: (delta: 1 | -1) => void;
};

type CleanupRegistration = {
  owner: Owner;
  cleanup: () => void;
  active: boolean;
  previous: CleanupRegistration | undefined;
  next: CleanupRegistration | undefined;
};

const signalBrand = Symbol("tachyon.signal");

let activeEffect: EffectRunner | undefined;
let currentOwner: Owner | undefined;
let currentEffectOwner: Owner | undefined;
let currentErrorOwner: ReactiveErrorOwner | undefined;
let batchDepth = 0;
let flushing = false;
let runtimeLifecycleHooks: RuntimeLifecycleHooks | undefined;
let nextOwnerId = 0;
let nextEffectId = 0;
/** Development-only: the template binding currently being installed. */
let currentBindingLocation: string | undefined;

/** Marks the start of a generated binding; returns the previous location for `exitBindingLocation`. */
export const enterBindingLocation = (location: string): string | undefined => {
  if (!lifecycleDiagnosticsEnabled) return undefined;
  const previous = currentBindingLocation;
  currentBindingLocation = location;
  return previous;
};

export const exitBindingLocation = (previous: string | undefined): void => {
  if (lifecycleDiagnosticsEnabled) currentBindingLocation = previous;
};

/** Publishes a generated module's binding spans to the installed diagnostics hooks. */
export const registerTemplateBindings = (
  templateId: string,
  revision: string,
  bindings: readonly TemplateBindingSpan[],
): void => {
  if (lifecycleDiagnosticsEnabled) runtimeLifecycleHooks?.templateBindingsRegistered?.(templateId, revision, bindings);
};
const pendingComputedEffects = new Set<EffectRunner>();
const pendingEffects = new Set<EffectRunner>();

export const setRuntimeLifecycleHooks = (hooks: RuntimeLifecycleHooks | undefined): (() => void) => {
  if (!lifecycleDiagnosticsEnabled) return () => undefined;
  const previous = runtimeLifecycleHooks;
  runtimeLifecycleHooks = hooks;
  return () => {
    if (runtimeLifecycleHooks === hooks) runtimeLifecycleHooks = previous;
  };
};

const createOwner = (): Owner => {
  const owner: Owner = {
    id: lifecycleDiagnosticsEnabled && runtimeLifecycleHooks ? ++nextOwnerId : undefined,
    disposed: false,
    head: undefined,
    tail: undefined,
    parentRegistration: undefined,
  };
  if (lifecycleDiagnosticsEnabled && owner.id !== undefined) {
    runtimeLifecycleHooks?.ownerCreated?.(owner.id, currentBindingLocation);
  }
  return owner;
};

const detachCleanup = (registration: CleanupRegistration): void => {
  if (!registration.active) return;
  const { owner } = registration;
  if (registration.previous) {
    registration.previous.next = registration.next;
  } else {
    owner.head = registration.next;
  }
  if (registration.next) {
    registration.next.previous = registration.previous;
  } else {
    owner.tail = registration.previous;
  }
  registration.active = false;
  registration.previous = undefined;
  registration.next = undefined;
  if (lifecycleDiagnosticsEnabled) runtimeLifecycleHooks?.cleanupChanged?.(-1);
};

const registerCleanup = (owner: Owner | undefined, cleanup: () => void): CleanupRegistration | undefined => {
  if (!owner || owner.disposed) return undefined;
  const registration: CleanupRegistration = {
    owner,
    cleanup,
    active: true,
    previous: owner.tail,
    next: undefined,
  };
  if (owner.tail) {
    owner.tail.next = registration;
  } else {
    owner.head = registration;
  }
  owner.tail = registration;
  if (lifecycleDiagnosticsEnabled) runtimeLifecycleHooks?.cleanupChanged?.(1);
  return registration;
};

const disposeOwner = (owner: Owner): void => {
  if (owner.disposed) return;
  owner.disposed = true;
  if (lifecycleDiagnosticsEnabled && owner.id !== undefined) runtimeLifecycleHooks?.ownerDisposed?.(owner.id);
  if (owner.parentRegistration) {
    detachCleanup(owner.parentRegistration);
    owner.parentRegistration = undefined;
  }
  let firstError: unknown;
  let failed = false;
  const registrations: CleanupRegistration[] = [];
  for (let registration = owner.tail; registration; registration = registration.previous) {
    registrations.push(registration);
  }
  for (const registration of registrations) {
    if (!registration.active) continue;
    detachCleanup(registration);
    try {
      registration.cleanup();
    } catch (error) {
      if (!failed) firstError = error;
      failed = true;
    }
  }
  owner.head = undefined;
  owner.tail = undefined;
  if (failed) throw firstError;
};

export const onCleanup = (cleanup: () => void): boolean => {
  return registerCleanup(currentEffectOwner ?? currentOwner, cleanup) !== undefined;
};

/** Registers cleanup for the current enclosing mount owner. */
export const onOwnerCleanup = (cleanup: () => void): (() => void) | undefined => {
  const registration = registerCleanup(currentOwner, cleanup);
  if (!registration) return undefined;
  return () => detachCleanup(registration);
};

export type ReactiveErrorScope = {
  run: <T>(fn: () => T) => T;
  dispose: () => void;
};

export const createReactiveErrorScope = (handle: (error: unknown) => void): ReactiveErrorScope => {
  const owner: ReactiveErrorOwner = {
    disposed: false,
    parent: currentErrorOwner,
    handle,
    runners: new Set(),
  };
  const scope: ReactiveErrorScope = {
    run: (fn) => {
      const previous = currentErrorOwner;
      currentErrorOwner = owner;
      try {
        return fn();
      } finally {
        currentErrorOwner = previous;
      }
    },
    dispose: () => {
      if (owner.disposed) return;
      owner.disposed = true;
      let firstError: unknown;
      let failed = false;
      for (const runner of Array.from(owner.runners)) {
        try {
          disposeRunner(runner);
        } catch (error) {
          if (!failed) firstError = error;
          failed = true;
        }
      }
      owner.runners.clear();
      if (failed) throw firstError;
    },
  };
  onCleanup(scope.dispose);
  return scope;
};

export const createRoot = <T>(fn: (dispose: () => void, runInOwner: OwnerRunner, disposed: () => boolean) => T): T => {
  const parent = currentOwner;
  const owner = createOwner();
  const dispose = (): void => disposeOwner(owner);
  const runInOwner: OwnerRunner = <Value>(callback: () => Value): Value => {
    if (owner.disposed) {
      throw new Error("Cannot run work in a disposed owner.");
    }
    const previousOwner = currentOwner;
    const previousEffectOwner = currentEffectOwner;
    const previousActiveEffect = activeEffect;
    currentOwner = owner;
    currentEffectOwner = undefined;
    activeEffect = undefined;
    try {
      return callback();
    } finally {
      currentOwner = previousOwner;
      currentEffectOwner = previousEffectOwner;
      activeEffect = previousActiveEffect;
    }
  };
  owner.parentRegistration = registerCleanup(parent, dispose);
  currentOwner = owner;
  const previousEffectOwner = currentEffectOwner;
  currentEffectOwner = undefined;
  try {
    return fn(dispose, runInOwner, () => owner.disposed);
  } catch (error) {
    try {
      dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Root initialization and cleanup failed.");
    }
    throw error;
  } finally {
    currentOwner = parent;
    currentEffectOwner = previousEffectOwner;
  }
};

export type Accessor<T> = (() => T) & {
  readonly [signalBrand]: true;
};

export type Signal<T> = Accessor<T> & {
  set: (value: T) => void;
  update: (updater: (value: T) => T) => void;
};

const cleanup = (runner: EffectRunner, createNextRunOwner: boolean): void => {
  let firstError: unknown;
  let failed = false;
  for (const child of Array.from(runner.children)) {
    try {
      disposeRunner(child);
    } catch (error) {
      if (!failed) firstError = error;
      failed = true;
    }
  }
  runner.children.clear();
  for (const dependency of runner.dependencies) {
    if (dependency.delete(runner)) {
      if (lifecycleDiagnosticsEnabled) runtimeLifecycleHooks?.subscriptionChanged?.(-1);
    }
  }
  runner.dependencies.clear();
  try {
    disposeOwner(runner.runOwner);
  } catch (error) {
    if (!failed) firstError = error;
    failed = true;
  }
  if (createNextRunOwner && !runner.disposed) {
    runner.runOwner = createOwner();
  }
  if (failed) throw firstError;
};

const disposeRunner = (runner: EffectRunner): void => {
  if (runner.disposed) {
    return;
  }
  runner.disposed = true;
  if (lifecycleDiagnosticsEnabled && runner.id !== undefined) runtimeLifecycleHooks?.effectDisposed?.(runner.id);
  pendingComputedEffects.delete(runner);
  pendingEffects.delete(runner);
  if (runner.registration) {
    detachCleanup(runner.registration);
    runner.registration = undefined;
  }
  let firstError: unknown;
  let failed = false;
  try {
    cleanup(runner, false);
  } catch (error) {
    firstError = error;
    failed = true;
  }
  runner.parent?.children.delete(runner);
  runner.errorOwner?.runners.delete(runner);
  if (failed) throw firstError;
};

const track = (subscribers: SubscriberSet): void => {
  if (activeEffect && !activeEffect.disposed) {
    if (!subscribers.has(activeEffect)) {
      subscribers.add(activeEffect);
      activeEffect.dependencies.add(subscribers);
      if (lifecycleDiagnosticsEnabled) runtimeLifecycleHooks?.subscriptionChanged?.(1);
    }
  }
};

const deliverError = (
  initialOwner: ReactiveErrorOwner | undefined,
  initialError: unknown,
): { handled: true } | { handled: false; error: unknown } => {
  let error = initialError;
  for (let owner = initialOwner; owner; owner = owner.parent) {
    if (owner.disposed) continue;
    const previous = currentErrorOwner;
    currentErrorOwner = owner;
    try {
      owner.handle(error);
      return { handled: true };
    } catch (nextError) {
      error = nextError;
    } finally {
      currentErrorOwner = previous;
    }
  }
  return { handled: false, error };
};

const flushPendingEffects = (): void => {
  if (flushing) {
    return;
  }
  flushing = true;
  const unhandled: unknown[] = [];
  try {
    while (pendingComputedEffects.size > 0 || pendingEffects.size > 0) {
      const runner = pendingComputedEffects.values().next().value ?? pendingEffects.values().next().value;
      if (!runner) {
        break;
      }
      if (runner.computed) {
        pendingComputedEffects.delete(runner);
      } else {
        pendingEffects.delete(runner);
      }
      try {
        runner.run();
      } catch (error) {
        const delivered = deliverError(runner.errorOwner, error);
        if (!delivered.handled) unhandled.push(delivered.error);
      }
    }
  } finally {
    flushing = false;
  }
  if (unhandled.length === 1) throw unhandled[0];
  if (unhandled.length > 1) throw new AggregateError(unhandled, "Reactive effects failed.");
};

const scheduleFlush = (): void => {
  if (batchDepth === 0 && !activeEffect) {
    flushPendingEffects();
  }
};

const notify = (subscribers: SubscriberSet): void => {
  const snapshot = Array.from(subscribers);
  for (const subscriber of snapshot) {
    if (!subscriber.disposed) {
      if (subscriber.computed) {
        pendingComputedEffects.add(subscriber);
      } else {
        pendingEffects.add(subscriber);
      }
    }
  }
  scheduleFlush();
};

export const isSignal = (value: unknown): value is Accessor<unknown> =>
  typeof value === "function" && (value as Partial<Accessor<unknown>>)[signalBrand] === true;

export function read<T>(value: Accessor<T>): T;
export function read<T>(value: T): T;
export function read<T>(value: T | Accessor<T>): T {
  return isSignal(value) ? (value as Accessor<T>)() : (value as T);
}

export const untrack = <T>(fn: () => T): T => {
  const previous = activeEffect;
  const previousOwner = currentEffectOwner;
  activeEffect = undefined;
  currentEffectOwner = undefined;
  try {
    return fn();
  } finally {
    activeEffect = previous;
    currentEffectOwner = previousOwner;
  }
};

export const batch = <T>(fn: () => T): T => {
  batchDepth++;
  try {
    return fn();
  } finally {
    batchDepth--;
    scheduleFlush();
  }
};

export const createSignal = <T>(initial: T): Signal<T> => {
  let current = initial;
  const subscribers: SubscriberSet = new Set();
  const signal = (() => {
    track(subscribers);
    return current;
  }) as Signal<T>;
  Object.defineProperty(signal, signalBrand, { value: true });
  signal.set = (value) => {
    if (Object.is(current, value)) {
      return;
    }
    current = value;
    notify(subscribers);
  };
  signal.update = (updater) => signal.set(updater(current));
  return signal;
};

export const createMemo = <T>(fn: () => T): Accessor<T> => {
  const value = createSignal<T>(undefined as T);
  createEffect(() => {
    value.set(fn());
  }, true);
  const memo = (() => value()) as Accessor<T>;
  Object.defineProperty(memo, signalBrand, { value: true });
  return memo;
};

export const createStore = <T extends Record<PropertyKey, unknown>>(initial: T): T => {
  const values = { ...initial } as Record<PropertyKey, unknown>;
  const subscribers = new Map<PropertyKey, SubscriberSet>();
  const subscribersFor = (property: PropertyKey): SubscriberSet => {
    let set = subscribers.get(property);
    if (!set) {
      set = new Set();
      subscribers.set(property, set);
    }
    return set;
  };

  return new Proxy(values, {
    get(target, property, receiver) {
      if (property === Symbol.toStringTag) {
        return "TachyonStore";
      }
      if (activeEffect) {
        track(subscribersFor(property));
      }
      return Reflect.get(target, property, receiver);
    },
    set(target, property, value, receiver) {
      const previous = Reflect.get(target, property, receiver);
      if (Object.is(previous, value)) {
        return true;
      }
      const didSet = Reflect.set(target, property, value, receiver);
      if (didSet) {
        const propertySubscribers = subscribers.get(property);
        if (propertySubscribers) notify(propertySubscribers);
      }
      return didSet;
    },
  }) as T;
};

type EffectCallback = () => unknown;

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === "object" && value !== null) || typeof value === "function"
    ? typeof (value as { then?: unknown }).then === "function"
    : false;

const scheduleUnhandledError = (error: unknown): void => {
  const throwError = (): void => {
    throw error;
  };
  if (typeof globalThis.queueMicrotask === "function") {
    globalThis.queueMicrotask(throwError);
  } else {
    setTimeout(throwError, 0);
  }
};

const reportAsyncEffectError = (runner: EffectRunner, runOwner: Owner, error: unknown): void => {
  if (runner.disposed || runOwner.disposed) return;
  const delivered = deliverError(runner.errorOwner, error);
  if (delivered.handled) return;
  scheduleUnhandledError(delivered.error);
};

const createEffect = (fn: EffectCallback, computed: boolean): (() => void) => {
  const registrationOwner = currentEffectOwner ?? currentOwner;
  if (registrationOwner?.disposed || currentOwner?.disposed) {
    return () => undefined;
  }
  const parent = activeEffect && !activeEffect.disposed ? activeEffect : undefined;
  const errorOwner = currentErrorOwner;
  const bindingLocation = lifecycleDiagnosticsEnabled ? currentBindingLocation : undefined;
  const runner: EffectRunner = {
    id: lifecycleDiagnosticsEnabled && runtimeLifecycleHooks ? ++nextEffectId : undefined,
    disposed: false,
    computed,
    dependencies: new Set(),
    children: new Set(),
    parent,
    errorOwner,
    owner: currentOwner,
    runOwner: createOwner(),
    registration: undefined,
    run: () => {
      if (runner.disposed) {
        return;
      }
      let cleanupError: unknown;
      let cleanupFailed = false;
      try {
        cleanup(runner, true);
      } catch (error) {
        cleanupError = error;
        cleanupFailed = true;
      }
      if (runner.disposed) {
        if (cleanupFailed) throw cleanupError;
        return;
      }
      const previous = activeEffect;
      const previousOwner = currentOwner;
      const previousEffectOwner = currentEffectOwner;
      const previousErrorOwner = currentErrorOwner;
      // Reruns restore the binding the effect was created under, so owners
      // and effects created lazily (rows, branches) stay attributed to it.
      const previousBindingLocation = currentBindingLocation;
      if (lifecycleDiagnosticsEnabled) currentBindingLocation = bindingLocation;
      activeEffect = runner;
      const runOwner = runner.runOwner;
      currentOwner = runner.owner;
      currentEffectOwner = runOwner;
      currentErrorOwner = runner.errorOwner;
      let callbackError: unknown;
      let callbackFailed = false;
      try {
        const returned = fn();
        if (typeof returned === "function") {
          const registration = registerCleanup(runOwner, returned as () => void);
          if (!registration && runOwner.disposed) {
            try {
              (returned as () => void)();
            } catch (error) {
              callbackError = error;
              callbackFailed = true;
            }
          }
        } else if (isPromiseLike(returned)) {
          void Promise.resolve(returned).catch((error) => reportAsyncEffectError(runner, runOwner, error));
        }
      } catch (error) {
        callbackError = error;
        callbackFailed = true;
      } finally {
        activeEffect = previous;
        currentOwner = previousOwner;
        currentEffectOwner = previousEffectOwner;
        currentErrorOwner = previousErrorOwner;
        if (lifecycleDiagnosticsEnabled) currentBindingLocation = previousBindingLocation;
        if (!previous) {
          scheduleFlush();
        }
      }
      if (cleanupFailed && callbackFailed) {
        throw new AggregateError([cleanupError, callbackError], "Reactive effect cleanup and callback failed.");
      }
      if (cleanupFailed) throw cleanupError;
      if (callbackFailed) throw callbackError;
    },
  };
  const dispose = (): void => disposeRunner(runner);
  if (lifecycleDiagnosticsEnabled && runner.id !== undefined)
    runtimeLifecycleHooks?.effectCreated?.(runner.id, runner.runOwner.id, bindingLocation);
  parent?.children.add(runner);
  errorOwner?.runners.add(runner);
  runner.registration = registerCleanup(registrationOwner, dispose);
  try {
    runner.run();
  } catch (error) {
    const delivered = deliverError(runner.errorOwner, error);
    if (!delivered.handled) {
      disposeRunner(runner);
      throw delivered.error;
    }
  }
  return dispose;
};

export const effect = (fn: EffectCallback): (() => void) => createEffect(fn, false);

export const catchError = (fn: () => void, onError: (error: unknown) => void): (() => void) =>
  effect(() => {
    try {
      fn();
    } catch (error) {
      onError(error);
    }
  });

export type ResourceOutcome<T> =
  | { status: "success"; data: T }
  | { status: "error"; error: unknown }
  | { status: "cancelled"; reason?: unknown };

export type Resource<T> = {
  data: Accessor<T | undefined>;
  error: Accessor<unknown | undefined>;
  loading: Accessor<boolean>;
  refetch: () => Promise<T | undefined>;
  refetchOutcome: () => Promise<ResourceOutcome<T>>;
  dispose: () => void;
};

export type ResourceFetcherContext = {
  signal: AbortSignal;
};

export const createResource = <Source, T>(
  source: Source | Accessor<Source>,
  fetcher: (source: Source, context: ResourceFetcherContext) => Promise<T> | T,
): Resource<T> => {
  const resourceOwner = currentEffectOwner ?? currentOwner;
  let disposed = resourceOwner?.disposed ?? false;
  const data = createSignal<T | undefined>(undefined);
  const error = createSignal<unknown | undefined>(undefined);
  const loading = createSignal(!disposed);
  let currentOutcome: Promise<ResourceOutcome<T>> | undefined;
  let version = 0;
  let controller: AbortController | undefined;
  let cancelCurrent: ((reason: unknown) => void) | undefined;
  let disposeTracking: (() => void) | undefined;
  let resourceRegistration: CleanupRegistration | undefined;
  let hasSource = false;
  let lastSource: Source;
  const sourceValue = (): Source => (isSignal(source) ? source() : source);
  const runOutcome = (value = sourceValue()): Promise<ResourceOutcome<T>> => {
    if (disposed) {
      return Promise.resolve({ status: "cancelled" });
    }
    if (loading() && currentOutcome && hasSource && Object.is(lastSource, value)) {
      return currentOutcome;
    }
    hasSource = true;
    lastSource = value;
    const previousController = controller;
    const previousCancel = cancelCurrent;
    const runVersion = ++version;
    const nextController = new AbortController();
    let settled = false;
    let settle!: (result: ResourceOutcome<T>) => void;
    const cancel = (reason: unknown): void => settle({ status: "cancelled", reason });
    const outcome = new Promise<ResourceOutcome<T>>((resolve) => {
      settle = (result) => {
        if (settled) return;
        settled = true;
        if (cancelCurrent === cancel) cancelCurrent = undefined;
        resolve(result);
      };
    });
    controller = nextController;
    cancelCurrent = cancel;
    currentOutcome = outcome;
    const skipped = Symbol("skipped resource run");
    const runStateUpdate = (update: () => void): void => {
      try {
        batch(update);
      } catch (error) {
        scheduleUnhandledError(error);
      }
    };
    runStateUpdate(() => {
      loading.set(true);
      error.set(undefined);
    });
    previousCancel?.("superseded");
    previousController?.abort();
    if (disposed || runVersion !== version) {
      return Promise.resolve({ status: "cancelled", reason: "superseded" });
    }
    void Promise.resolve()
      .then(() => {
        if (settled) return skipped;
        if (disposed || runVersion !== version) {
          settle({ status: "cancelled", reason: "superseded" });
          return skipped;
        }
        return fetcher(value, { signal: nextController.signal });
      })
      .then(
        (result) => {
          if (result === skipped || settled) return;
          if (!disposed && runVersion === version) {
            let notificationFailed = false;
            let notificationError: unknown;
            try {
              batch(() => {
                data.set(result);
                error.set(undefined);
                loading.set(false);
              });
            } catch (error) {
              notificationError = error;
              notificationFailed = true;
            }
            settle({ status: "success", data: result });
            if (notificationFailed) scheduleUnhandledError(notificationError);
          } else {
            settle({ status: "cancelled", reason: "superseded" });
          }
        },
        (reason) => {
          if (settled) return;
          if (!disposed && runVersion === version) {
            let notificationFailed = false;
            let notificationError: unknown;
            try {
              batch(() => {
                error.set(reason);
                loading.set(false);
              });
            } catch (error) {
              notificationError = error;
              notificationFailed = true;
            }
            settle({ status: "error", error: reason });
            if (notificationFailed) scheduleUnhandledError(notificationError);
          } else {
            settle({ status: "cancelled", reason });
          }
        },
      );
    return outcome;
  };
  const run = (value = sourceValue()): Promise<T | undefined> => {
    const outcome = runOutcome(value);
    return outcome.then((result) => (result.status === "success" ? result.data : undefined));
  };
  if (!disposed) {
    if (isSignal(source)) {
      disposeTracking = effect(() => {
        const value = source();
        if (!hasSource || !Object.is(lastSource, value)) {
          void untrack(() => run(value));
        }
      });
    } else {
      void run();
    }
  }
  const resource: Resource<T> = {
    data,
    error,
    loading,
    refetch: run,
    refetchOutcome: runOutcome,
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      version += 1;
      let firstError: unknown;
      let failed = false;
      const attempt = (operation: () => void): void => {
        try {
          operation();
        } catch (error) {
          if (!failed) firstError = error;
          failed = true;
        }
      };
      const registration = resourceRegistration;
      resourceRegistration = undefined;
      if (registration) attempt(() => detachCleanup(registration));
      attempt(() => cancelCurrent?.("disposed"));
      cancelCurrent = undefined;
      attempt(() => controller?.abort());
      controller = undefined;
      attempt(() => disposeTracking?.());
      disposeTracking = undefined;
      currentOutcome = undefined;
      attempt(() => loading.set(false));
      if (failed) throw firstError;
    },
  };
  resourceRegistration = registerCleanup(resourceOwner, resource.dispose);
  return resource;
};
