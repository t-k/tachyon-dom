import { createStore } from "./signal.js";
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

/** Keep template assignments local while accepting later changes from input props. */
export const createScopeStore = (
  scope: Record<PropertyKey, unknown>,
  initial: Record<PropertyKey, unknown>,
): Record<PropertyKey, unknown> => {
  const state = createStore(initial);
  const localKeys = new Set(Reflect.ownKeys(initial));
  const sourceValues = new Map<PropertyKey, unknown>();
  const write = (key: PropertyKey, value: unknown): boolean => {
    // Establish an own data property before Store assignment: inherited setters
    // such as __proto__ must not interpret input data as a prototype change.
    if (!Object.hasOwn(state, key)) {
      Reflect.defineProperty(state, key, { value: undefined, writable: true, enumerable: true, configurable: true });
    }
    return Reflect.set(state, key, value);
  };
  return new Proxy(
    {},
    {
      get(_target, key, receiver) {
        if (!localKeys.has(key)) {
          const value = readScopeProperty(scope, key, receiver);
          if (!sourceValues.has(key) || !Object.is(sourceValues.get(key), value)) {
            sourceValues.set(key, value);
            write(key, value);
          }
        }
        return Reflect.get(state, key, receiver);
      },
      set(_target, key, value) {
        if (!localKeys.has(key)) sourceValues.set(key, readScopeProperty(scope, key, state));
        return write(key, value);
      },
      has: (_target, key) => Object.hasOwn(state, key) || Object.hasOwn(scope, key),
      ownKeys: () => [...new Set([...scopeKeys(scope), ...Reflect.ownKeys(state)])],
      getOwnPropertyDescriptor(_target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(state, key) ?? Reflect.getOwnPropertyDescriptor(scope, key);
        return descriptor ? { ...descriptor, configurable: true } : undefined;
      },
    },
  );
};
