type SubscriberSet = Set<EffectRunner>;

type EffectRunner = {
  disposed: boolean;
  computed: boolean;
  dependencies: Set<SubscriberSet>;
  children: Set<EffectRunner>;
  parent: EffectRunner | undefined;
  run: () => void;
};

const signalBrand = Symbol("tachyon.signal");

let activeEffect: EffectRunner | undefined;
let batchDepth = 0;
let flushing = false;
const pendingComputedEffects = new Set<EffectRunner>();
const pendingEffects = new Set<EffectRunner>();

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
  cleanup(runner);
  runner.parent?.children.delete(runner);
};

const track = (subscribers: SubscriberSet): void => {
  if (activeEffect && !activeEffect.disposed) {
    subscribers.add(activeEffect);
    activeEffect.dependencies.add(subscribers);
  }
};

const flushPendingEffects = (): void => {
  if (flushing) {
    return;
  }
  flushing = true;
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
      runner.run();
    }
  } finally {
    flushing = false;
  }
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
  const runner: EffectRunner = {
    disposed: false,
    computed,
    dependencies: new Set(),
    children: new Set(),
    parent,
    run: () => {
      if (runner.disposed) {
        return;
      }
      cleanup(runner);
      const previous = activeEffect;
      activeEffect = runner;
      try {
        fn();
      } finally {
        activeEffect = previous;
        if (!previous) {
          scheduleFlush();
        }
      }
    },
  };
  parent?.children.add(runner);
  runner.run();
  return () => disposeRunner(runner);
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
};

export const createResource = <Source, T>(
  source: Source | Accessor<Source>,
  fetcher: (source: Source) => Promise<T> | T,
): Resource<T> => {
  const data = createSignal<T | undefined>(undefined);
  const error = createSignal<unknown | undefined>(undefined);
  const loading = createSignal(true);
  let current: Promise<T | undefined> | undefined;
  let version = 0;
  const sourceValue = (): Source => (isSignal(source) ? source() : source);
  const run = (): Promise<T | undefined> => {
    if (loading() && current) {
      return current;
    }
    const runVersion = ++version;
    loading.set(true);
    current = Promise.resolve()
      .then(() => fetcher(sourceValue()))
      .then(
        (value) => {
          if (runVersion === version) {
            batch(() => {
              data.set(value);
              error.set(undefined);
              loading.set(false);
            });
          }
          return value;
        },
        (reason) => {
          if (runVersion === version) {
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
  void run();
  return { data, error, loading, refetch: run };
};
