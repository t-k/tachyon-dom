import {
  createResource,
  createRoot,
  createSignal,
  effect,
  onCleanup,
  type Accessor,
  type Resource,
  type ResourceFetcherContext,
  type ResourceOutcome,
  type Signal,
} from "./signal.js";

export type QueryOptions = {
  staleTime?: number;
};

export type QueryHandle<T> = {
  data: Accessor<T | undefined>;
  hasValue: Accessor<boolean>;
  error: Accessor<unknown | undefined>;
  hasError: Accessor<boolean>;
  loading: Accessor<boolean>;
  refetch: () => Promise<ResourceOutcome<T>>;
  dispose: () => void;
};

type QueryEntry<T> = {
  resource: Resource<T>;
  data: Signal<T | undefined>;
  hasValue: Signal<boolean>;
  error: Signal<unknown | undefined>;
  hasError: Signal<boolean>;
  observers: number;
  fetchedAt: number | undefined;
  mutationVersion: number;
  activeMutation: number;
  mutationBase: T | undefined;
  mutationBaseHasValue: boolean;
  discardPendingResult: boolean;
};

export type QueryClient = {
  observe: <T>(
    key: string,
    fetcher: (key: string, context: ResourceFetcherContext) => Promise<T> | T,
    options?: QueryOptions,
  ) => QueryHandle<T>;
  invalidate: (key: string) => Promise<ResourceOutcome<unknown> | undefined>;
  invalidateWhere: (predicate: (key: string) => boolean) => Promise<void>;
  mutate: <T>(
    key: string,
    optimistic: (current: T | undefined) => T,
    commit: () => Promise<T> | T,
    invalidateKeys?: readonly string[],
  ) => Promise<T>;
  dispose: () => void;
};

/** Creates a cache owned by the caller's reactive root, suitable for one app or SSR request. */
export const createQueryClient = (): QueryClient =>
  createRoot((disposeRoot, runInOwner, clientDisposed) => {
    const entries = new Map<string, QueryEntry<unknown>>();
    const invalidate = (key: string): Promise<ResourceOutcome<unknown> | undefined> => {
      if (clientDisposed()) return Promise.resolve(undefined);
      const entry = entries.get(key);
      if (!entry) return Promise.resolve(undefined);
      entry.fetchedAt = undefined;
      return entry.observers > 0 ? entry.resource.refetchOutcome() : Promise.resolve(undefined);
    };
    return {
      observe: <T>(
        key: string,
        fetcher: (key: string, context: ResourceFetcherContext) => Promise<T> | T,
        options: QueryOptions = {},
      ): QueryHandle<T> => {
        if (clientDisposed()) throw new Error("Cannot observe a disposed query client.");
        if (!Number.isFinite(options.staleTime ?? 0) || (options.staleTime ?? 0) < 0) {
          throw new RangeError("staleTime must be a nonnegative finite number.");
        }
        let entry = entries.get(key) as QueryEntry<T> | undefined;
        if (!entry) {
          entry = runInOwner(() => {
            const resource = createResource(key, fetcher);
            const data = createSignal<T | undefined>(undefined);
            const hasValue = createSignal(false);
            const error = createSignal<unknown | undefined>(undefined);
            const hasError = createSignal(false);
            const created: QueryEntry<T> = {
              resource,
              data,
              hasValue,
              error,
              hasError,
              observers: 0,
              fetchedAt: undefined,
              mutationVersion: 0,
              activeMutation: 0,
              mutationBase: undefined,
              mutationBaseHasValue: false,
              discardPendingResult: false,
            };
            effect(() => {
              const loading = resource.loading();
              const resourceHasValue = resource.hasValue();
              const resourceHasError = resource.hasError();
              if (loading) {
                error.set(undefined);
                hasError.set(false);
                return;
              }
              if (created.discardPendingResult) {
                created.discardPendingResult = false;
                return;
              }
              if (created.activeMutation !== 0) return;
              if (resourceHasError) {
                error.set(resource.error());
                hasError.set(true);
                return;
              }
              error.set(undefined);
              hasError.set(false);
              if (!resourceHasValue) return;
              const value = resource.data();
              created.fetchedAt = Date.now();
              data.set(value);
              hasValue.set(true);
            });
            return created;
          });
          entries.set(key, entry as QueryEntry<unknown>);
        } else if (
          !entry.resource.loading() &&
          (entry.fetchedAt === undefined || Date.now() - entry.fetchedAt >= (options.staleTime ?? 0))
        ) {
          void entry.resource.refetchOutcome();
        }
        entry.observers++;
        const selected = entry;
        let released = false;
        const release = (): void => {
          if (released) return;
          released = true;
          selected.observers--;
        };
        onCleanup(release);
        return {
          data: selected.data,
          hasValue: selected.hasValue,
          error: selected.error,
          hasError: selected.hasError,
          loading: selected.resource.loading,
          refetch: () =>
            released
              ? Promise.resolve({ status: "cancelled", reason: "disposed" })
              : selected.resource.refetchOutcome(),
          dispose: release,
        };
      },
      invalidate,
      invalidateWhere: async (predicate) => {
        const keys = [...entries.keys()].filter(predicate);
        await Promise.all(keys.map(invalidate));
      },
      mutate: async <T>(
        key: string,
        optimistic: (current: T | undefined) => T,
        commit: () => Promise<T> | T,
        invalidateKeys: readonly string[] = [],
      ): Promise<T> => {
        if (clientDisposed()) throw new Error("Cannot mutate a disposed query client.");
        const entry = entries.get(key) as QueryEntry<T> | undefined;
        if (!entry) throw new Error(`No query is registered for ${key}.`);
        const next = optimistic(entry.data());
        if (entry.activeMutation === 0) {
          entry.mutationBase = entry.data();
          entry.mutationBaseHasValue = entry.hasValue();
        }
        const version = ++entry.mutationVersion;
        entry.activeMutation = version;
        entry.data.set(next);
        entry.hasValue.set(true);
        try {
          const result = await commit();
          if (entry.activeMutation === version && !clientDisposed()) {
            entry.data.set(result);
            entry.hasValue.set(true);
            entry.fetchedAt = Date.now();
            entry.mutationBase = result;
            entry.mutationBaseHasValue = true;
            entry.activeMutation = 0;
            entry.error.set(undefined);
            entry.hasError.set(false);
            entry.discardPendingResult = entry.resource.loading();
            void Promise.all(invalidateKeys.map(invalidate));
          }
          return result;
        } catch (error) {
          if (entry.activeMutation === version && !clientDisposed()) {
            entry.data.set(entry.mutationBase);
            entry.hasValue.set(entry.mutationBaseHasValue);
            entry.activeMutation = 0;
          }
          throw error;
        }
      },
      dispose: () => {
        disposeRoot();
        entries.clear();
      },
    };
  });
