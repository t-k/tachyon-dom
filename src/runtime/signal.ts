type SubscriberSet = Set<EffectRunner>;

type EffectRunner = {
  disposed: boolean;
  computed: boolean;
  dependencies: Set<SubscriberSet>;
  children: Set<EffectRunner>;
  parent: EffectRunner | undefined;
  errorOwner: ReactiveErrorOwner | undefined;
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
  cleanups: Array<() => void>;
};

const signalBrand = Symbol("tachyon.signal");

let activeEffect: EffectRunner | undefined;
let currentOwner: Owner | undefined;
let currentErrorOwner: ReactiveErrorOwner | undefined;
let batchDepth = 0;
let flushing = false;
const pendingComputedEffects = new Set<EffectRunner>();
const pendingEffects = new Set<EffectRunner>();

export const onCleanup = (cleanup: () => void): void => {
  if (currentOwner && !currentOwner.disposed) {
    currentOwner.cleanups.push(cleanup);
  }
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
      for (const runner of Array.from(owner.runners)) disposeRunner(runner);
      owner.runners.clear();
    },
  };
  onCleanup(scope.dispose);
  return scope;
};

export const createRoot = <T>(fn: (dispose: () => void) => T): T => {
  const parent = currentOwner;
  const owner: Owner = { disposed: false, cleanups: [] };
  const dispose = (): void => {
    if (owner.disposed) return;
    owner.disposed = true;
    let firstError: unknown;
    let failed = false;
    for (let index = owner.cleanups.length - 1; index >= 0; index--) {
      try {
        owner.cleanups[index]?.();
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
      }
    }
    owner.cleanups.length = 0;
    if (failed) throw firstError;
  };
  if (parent && !parent.disposed) parent.cleanups.push(dispose);
  currentOwner = owner;
  try {
    return fn(dispose);
  } catch (error) {
    dispose();
    throw error;
  } finally {
    currentOwner = parent;
  }
};

export type Accessor<T> = (() => T) & {
  readonly [signalBrand]: true;
};

export type Signal<T> = Accessor<T> & {
  set: (value: T) => void;
  update: (updater: (value: T) => T) => void;
};

const cleanup = (runner: EffectRunner): void => {
  for (const child of Array.from(runner.children)) {
    disposeRunner(child);
  }
  runner.children.clear();
  for (const dependency of runner.dependencies) {
    dependency.delete(runner);
  }
  runner.dependencies.clear();
};

const disposeRunner = (runner: EffectRunner): void => {
  if (runner.disposed) {
    return;
  }
  runner.disposed = true;
  pendingComputedEffects.delete(runner);
  pendingEffects.delete(runner);
  cleanup(runner);
  runner.parent?.children.delete(runner);
  runner.errorOwner?.runners.delete(runner);
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
  activeEffect = undefined;
  try {
    return fn();
  } finally {
    activeEffect = previous;
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
      track(subscribersFor(property));
      return Reflect.get(target, property, receiver);
    },
    set(target, property, value, receiver) {
      const previous = Reflect.get(target, property, receiver);
      if (Object.is(previous, value)) {
        return true;
      }
      const didSet = Reflect.set(target, property, value, receiver);
      if (didSet) {
        notify(subscribersFor(property));
      }
      return didSet;
    },
  }) as T;
};

const createEffect = (fn: () => void, computed: boolean): (() => void) => {
  const parent = activeEffect && !activeEffect.disposed ? activeEffect : undefined;
  const errorOwner = currentErrorOwner;
  const runner: EffectRunner = {
    disposed: false,
    computed,
    dependencies: new Set(),
    children: new Set(),
    parent,
    errorOwner,
    run: () => {
      if (runner.disposed) {
        return;
      }
      cleanup(runner);
      const previous = activeEffect;
      const previousErrorOwner = currentErrorOwner;
      activeEffect = runner;
      currentErrorOwner = runner.errorOwner;
      try {
        fn();
      } finally {
        activeEffect = previous;
        currentErrorOwner = previousErrorOwner;
        if (!previous) {
          scheduleFlush();
        }
      }
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
  onCleanup(dispose);
  return dispose;
};

export const effect = (fn: () => void): (() => void) => createEffect(fn, false);

export const catchError = (fn: () => void, onError: (error: unknown) => void): (() => void) =>
  effect(() => {
    try {
      fn();
    } catch (error) {
      onError(error);
    }
  });

export type Resource<T> = {
  data: Accessor<T | undefined>;
  error: Accessor<unknown | undefined>;
  loading: Accessor<boolean>;
  refetch: () => Promise<T | undefined>;
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
  let current: Promise<T | undefined> | undefined;
  let version = 0;
  let disposed = false;
  let controller: AbortController | undefined;
  let disposeTracking: (() => void) | undefined;
  let hasSource = false;
  let lastSource: Source;
  const sourceValue = (): Source => (isSignal(source) ? source() : source);
  const run = (value = sourceValue()): Promise<T | undefined> => {
    if (disposed) {
      return Promise.resolve(undefined);
    }
    if (loading() && current && hasSource && Object.is(lastSource, value)) {
      return current;
    }
    hasSource = true;
    lastSource = value;
    controller?.abort();
    const nextController = new AbortController();
    controller = nextController;
    const runVersion = ++version;
    batch(() => {
      loading.set(true);
      error.set(undefined);
    });
    current = Promise.resolve()
      .then(() => fetcher(value, { signal: nextController.signal }))
      .then(
        (value) => {
          if (!disposed && runVersion === version) {
            batch(() => {
              data.set(value);
              error.set(undefined);
              loading.set(false);
            });
          }
          return value;
        },
        (reason) => {
          if (!disposed && runVersion === version) {
            batch(() => {
              error.set(reason);
              loading.set(false);
            });
          }
          return undefined;
        },
      );
    return current;
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
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      version += 1;
      controller?.abort();
      disposeTracking?.();
      current = undefined;
      loading.set(false);
    },
  };
  onCleanup(resource.dispose);
  return resource;
};
