import { createStore, untrack } from "./signal.js";
export { createStore };

const scopeDescriptor = (scope: Record<PropertyKey, unknown>, key: PropertyKey): PropertyDescriptor | undefined => {
  const descriptor = Reflect.getOwnPropertyDescriptor(scope, key);
  return descriptor?.enumerable ? descriptor : undefined;
};

const readScopeProperty = (scope: Record<PropertyKey, unknown>, key: PropertyKey, receiver: unknown): unknown => {
  // Read absent Store keys to subscribe, but never evaluate hidden or inherited getters.
  return scopeDescriptor(scope, key) || !(key in scope) ? Reflect.get(scope, key, receiver) : undefined;
};

const scopeKeys = (scope: Record<PropertyKey, unknown>): Array<string | symbol> =>
  Reflect.ownKeys(scope).filter((key) => scopeDescriptor(scope, key));

/** Compose instance scopes without snapshotting reactive values. The overlay wins. */
export const mergeScopes = (
  base: Record<PropertyKey, unknown>,
  overlay: Record<PropertyKey, unknown>,
): Record<PropertyKey, unknown> =>
  createScopeStore(
    new Proxy(
      {},
      {
        get(_target, key, receiver) {
          const value = readScopeProperty(overlay, key, receiver);
          return scopeDescriptor(overlay, key) ? value : readScopeProperty(base, key, receiver);
        },
        has: (_target, key) => Boolean(scopeDescriptor(overlay, key) || scopeDescriptor(base, key)),
        ownKeys: () => [...new Set([...scopeKeys(base), ...scopeKeys(overlay)])],
        getOwnPropertyDescriptor(_target, key) {
          const source = scopeDescriptor(overlay, key) ? overlay : base;
          const descriptor = scopeDescriptor(source, key);
          return descriptor ? { ...descriptor, configurable: true } : undefined;
        },
      },
    ),
    {},
  );

/**
 * Keep template assignments local while accepting later changes from input props.
 *
 * Reads never write to the local Store: they subscribe to both the input scope and the
 * local key, then return the local override only while the input still holds the value
 * it had when the template assigned. Writing on read would notify sibling effects and,
 * with getters that return fresh objects, re-run them without end.
 */
export const createScopeStore = (
  scope: Record<PropertyKey, unknown>,
  initial: Record<PropertyKey, unknown>,
): Record<PropertyKey, unknown> => {
  const state = createStore(initial);
  const localKeys = new Set<PropertyKey>(Reflect.ownKeys(initial));
  // Input value observed when the template last assigned a non-local key.
  const overridden = new Map<PropertyKey, unknown>();
  const useLocal = (key: PropertyKey, inputValue: unknown): boolean => {
    if (!overridden.has(key)) return false;
    if (Object.is(overridden.get(key), inputValue)) return true;
    overridden.delete(key);
    return false;
  };
  const proxy: Record<PropertyKey, unknown> = new Proxy(
    {},
    {
      get(_target, key, receiver) {
        const localValue = Reflect.get(state, key, receiver);
        if (localKeys.has(key)) return localValue;
        const inputValue = readScopeProperty(scope, key, receiver);
        return useLocal(key, inputValue) ? localValue : inputValue;
      },
      set(_target, key, value, receiver) {
        if (!localKeys.has(key)) {
          const inputValue = untrack(() => readScopeProperty(scope, key, receiver));
          const previous = useLocal(key, inputValue) ? untrack(() => Reflect.get(state, key)) : inputValue;
          // Compare writes against the visible value, not a stale local override.
          // Defining the baseline is silent; only the subsequent assignment notifies.
          Reflect.defineProperty(state, key, {
            value: previous,
            writable: true,
            enumerable: true,
            configurable: true,
          });
          overridden.set(key, inputValue);
        } else if (!Object.hasOwn(state, key)) {
          // createStore omits non-enumerable initial keys; never reach inherited setters.
          Reflect.defineProperty(state, key, {
            value: undefined,
            writable: true,
            enumerable: true,
            configurable: true,
          });
        }
        return Reflect.set(state, key, value);
      },
      has: (_target, key) => Object.hasOwn(state, key) || Object.hasOwn(scope, key),
      ownKeys: () => [...new Set([...scopeKeys(scope), ...Reflect.ownKeys(state)])],
      getOwnPropertyDescriptor(_target, key) {
        const input = scopeDescriptor(scope, key);
        if (!localKeys.has(key) && input && !("value" in input)) {
          // Inspection must not evaluate accessors, including through nested scopes.
          return {
            configurable: true,
            enumerable: Boolean(input.enumerable),
            get(this: unknown) {
              return Reflect.get(proxy, key, this);
            },
          };
        }
        const local = localKeys.has(key) || useLocal(key, input?.value);
        const descriptor = local
          ? Reflect.getOwnPropertyDescriptor(state, key)
          : (input ?? Reflect.getOwnPropertyDescriptor(state, key));
        return descriptor ? { ...descriptor, configurable: true } : undefined;
      },
    },
  );
  return proxy;
};
