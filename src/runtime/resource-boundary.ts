import {
  createResource,
  createRoot,
  effect,
  untrack,
  type Accessor,
  type Resource,
  type ResourceFetcherContext,
  type ResourceOutcome,
} from "./signal.js";

export type ResourceBoundaryViews<T> = {
  pending: () => Element;
  success: (value: T) => Element;
  error: (reason: unknown, retry: () => Promise<ResourceOutcome<T>>) => Element;
  refreshing?: (value: T) => Element;
};

export type ResourceBoundary<T> = {
  resource: Resource<T>;
  dispose: () => void;
};

type View = { element: Element; dispose: () => void };

/** Mounts one client-owned async region whose request and rendered views share a disposal owner. */
export const createResourceBoundary = <Source, T>(
  root: Element,
  source: Source | Accessor<Source>,
  fetcher: (source: Source, context: ResourceFetcherContext) => Promise<T> | T,
  views: ResourceBoundaryViews<T>,
): ResourceBoundary<T> =>
  createRoot((dispose) => {
    const resource = createResource(source, fetcher);
    const retry = (): Promise<ResourceOutcome<T>> => resource.refetchOutcome();
    let main: (View & { kind: "pending" | "success" | "error"; value?: unknown }) | undefined;
    let status: (View & { kind: "refreshing" | "error"; value?: unknown }) | undefined;
    const render = (renderView: () => Element): View =>
      untrack(() =>
        createRoot((disposeView) => ({ element: renderView(), dispose: disposeView })),
      );
    const replaceMain = (kind: "pending" | "success" | "error", value: unknown, renderView: () => Element): void => {
      if (main?.kind === kind && Object.is(main.value, value)) return;
      const next = render(renderView);
      try {
        root.replaceChildren(next.element);
      } catch (error) {
        next.dispose();
        throw error;
      }
      const previous = main;
      main = { ...next, kind, value };
      previous?.dispose();
    };
    const clearStatus = (): void => {
      const previous = status;
      status = undefined;
      previous?.element.remove();
      previous?.dispose();
    };
    const showStatus = (kind: "refreshing" | "error", value: unknown, renderView: () => Element): void => {
      if (status?.kind === kind && Object.is(status.value, value)) return;
      clearStatus();
      const next = render(renderView);
      try {
        root.append(next.element);
      } catch (error) {
        next.dispose();
        throw error;
      }
      status = { ...next, kind, value };
    };
    effect(() => {
      const loading = resource.loading();
      const hasValue = resource.hasValue();
      const hasError = resource.hasError();
      const value = resource.data() as T;
      const reason = resource.error();
      if (hasValue) {
        replaceMain("success", value, () => views.success(value));
        if (loading && views.refreshing) showStatus("refreshing", undefined, () => views.refreshing!(value));
        else if (hasError) showStatus("error", reason, () => views.error(reason, retry));
        else clearStatus();
      } else if (hasError) {
        clearStatus();
        replaceMain("error", reason, () => views.error(reason, retry));
      } else {
        clearStatus();
        replaceMain("pending", undefined, views.pending);
      }
    });
    return { resource, dispose };
  });
