type SubscriberSet = Set<EffectRunner>;

type EffectRunner = {
  disposed: boolean;
  dependencies: Set<SubscriberSet>;
  run: () => void;
};

const signalBrand = Symbol("tachyon.signal");

let activeEffect: EffectRunner | undefined;

export type Signal<T> = (() => T) & {
  readonly [signalBrand]: true;
  set: (value: T) => void;
  update: (updater: (value: T) => T) => void;
};

const cleanup = (runner: EffectRunner): void => {
  for (const dependency of runner.dependencies) {
    dependency.delete(runner);
  }
  runner.dependencies.clear();
};

export const isSignal = (value: unknown): value is Signal<unknown> =>
  typeof value === "function" && (value as Partial<Signal<unknown>>)[signalBrand] === true;

export function read<T>(value: Signal<T>): T;
export function read<T>(value: T): T;
export function read<T>(value: T | Signal<T>): T {
  return isSignal(value) ? (value as Signal<T>)() : (value as T);
}

export const createSignal = <T>(initial: T): Signal<T> => {
  let current = initial;
  const subscribers: SubscriberSet = new Set();
  const signal = (() => {
    if (activeEffect && !activeEffect.disposed) {
      subscribers.add(activeEffect);
      activeEffect.dependencies.add(subscribers);
    }
    return current;
  }) as Signal<T>;
  Object.defineProperty(signal, signalBrand, { value: true });
  signal.set = (value) => {
    if (Object.is(current, value)) {
      return;
    }
    current = value;
    const snapshot = Array.from(subscribers);
    for (const subscriber of snapshot) {
      subscriber.run();
    }
  };
  signal.update = (updater) => signal.set(updater(current));
  return signal;
};

export const effect = (fn: () => void): (() => void) => {
  const runner: EffectRunner = {
    disposed: false,
    dependencies: new Set(),
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
      }
    },
  };
  runner.run();
  return () => {
    runner.disposed = true;
    cleanup(runner);
  };
};
