type SubscriberSet = Set<EffectRunner>;

type EffectRunner = {
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
  disposed: boolean;
  head: CleanupRegistration | undefined;
  tail: CleanupRegistration | undefined;
  parentRegistration: CleanupRegistration | undefined;
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
const pendingComputedEffects = new Set<EffectRunner>();
const pendingEffects = new Set<EffectRunner>();

const createOwner = (): Owner => ({
  disposed: false,
  head: undefined,
  tail: undefined,
  parentRegistration: undefined,
});

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
  return registration;
};

const disposeOwner = (owner: Owner): void => {
  if (owner.disposed) return;
  owner.disposed = true;
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

export const createRoot = <T>(fn: (dispose: () => void) => T): T => {
  const parent = currentOwner;
  const owner = createOwner();
  const dispose = (): void => disposeOwner(owner);
  owner.parentRegistration = registerCleanup(parent, dispose);
  currentOwner = owner;
  const previousEffectOwner = currentEffectOwner;
  currentEffectOwner = undefined;
  try {
    return fn(dispose);
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
    dependency.delete(runner);
  }
  runner.dependencies.clear();
  try {
    disposeOwner(runner.runOwner);
  } catch (error) {
    if (!failed) firstError = error;
    failed = true;
  }
  if (createNextRunOwner) {
    runner.runOwner = createOwner();
  }
  if (failed) throw firstError;
};

const disposeRunner = (runner: EffectRunner): void => {
  if (runner.disposed) {
    return;
  }
  runner.disposed = true;
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
    subscribers.add(activeEffect);
    activeEffect.dependencies.add(subscribers);
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

const reportAsyncEffectError = (runner: EffectRunner, runOwner: Owner, error: unknown): void => {
  if (runner.disposed || runOwner.disposed) return;
  const delivered = deliverError(runner.errorOwner, error);
  if (delivered.handled) return;
  const throwError = (): void => {
    throw delivered.error;
  };
  if (typeof globalThis.queueMicrotask === "function") {
    globalThis.queueMicrotask(throwError);
  } else {
    setTimeout(throwError, 0);
  }
};

const createEffect = (fn: EffectCallback, computed: boolean): (() => void) => {
  const parent = activeEffect && !activeEffect.disposed ? activeEffect : undefined;
  const errorOwner = currentErrorOwner;
  const runner: EffectRunner = {
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
      const previous = activeEffect;
      const previousOwner = currentOwner;
      const previousEffectOwner = currentEffectOwner;
      const previousErrorOwner = currentErrorOwner;
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
          registerCleanup(runOwner, returned as () => void);
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
  parent?.children.add(runner);
  errorOwner?.runners.add(runner);
  try {
    runner.run();
  } catch (error) {
    const delivered = deliverError(runner.errorOwner, error);
    if (!delivered.handled) {
      disposeRunner(runner);
      throw delivered.error;
    }
  }
  const dispose = (): void => disposeRunner(runner);
  runner.registration = registerCleanup(currentEffectOwner ?? currentOwner, dispose);
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
  const data = createSignal<T | undefined>(undefined);
  const error = createSignal<unknown | undefined>(undefined);
  const loading = createSignal(true);
  let currentOutcome: Promise<ResourceOutcome<T>> | undefined;
  let version = 0;
  let disposed = false;
  let controller: AbortController | undefined;
  let cancelCurrent: ((reason: unknown) => void) | undefined;
  let disposeTracking: (() => void) | undefined;
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
    cancelCurrent?.("superseded");
    controller?.abort();
    const nextController = new AbortController();
    controller = nextController;
    const runVersion = ++version;
    batch(() => {
      loading.set(true);
      error.set(undefined);
    });
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
      void Promise.resolve()
        .then(() => fetcher(value, { signal: nextController.signal }))
        .then(
          (result) => {
            if (settled) return;
            if (!disposed && runVersion === version) {
              batch(() => {
                data.set(result);
                error.set(undefined);
                loading.set(false);
              });
              settle({ status: "success", data: result });
            } else {
              settle({ status: "cancelled", reason: "superseded" });
            }
          },
          (reason) => {
            if (settled) return;
            if (!disposed && runVersion === version) {
              batch(() => {
                error.set(reason);
                loading.set(false);
              });
              settle({ status: "error", error: reason });
            } else {
              settle({ status: "cancelled", reason });
            }
          },
        );
    });
    cancelCurrent = cancel;
    currentOutcome = outcome;
    return outcome;
  };
  const run = (value = sourceValue()): Promise<T | undefined> => {
    const outcome = runOutcome(value);
    return outcome.then((result) => (result.status === "success" ? result.data : undefined));
  };
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
      cancelCurrent?.("disposed");
      cancelCurrent = undefined;
      controller?.abort();
      disposeTracking?.();
      currentOutcome = undefined;
      loading.set(false);
    },
  };
  onCleanup(resource.dispose);
  return resource;
};
