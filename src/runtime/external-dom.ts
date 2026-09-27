import { createRoot, effect, onOwnerCleanup } from "./signal.js";

export type ExternalDomInstance<Options> = {
  update: (options: Options) => void;
  dispose: () => void;
};

export type ExternalDomAdapter<Options> = {
  mount: (element: Element, options: Options) => ExternalDomInstance<Options>;
  /** Validate and adopt the server-owned children without replacing them. */
  hydrate?: (element: Element, options: Options) => ExternalDomInstance<Options>;
};

export type ExternalDomHandle = {
  dispose: () => void;
  disposed: () => boolean;
};

/** Gives an adapter exclusive ownership of an element's children for one reactive owner lifetime. */
export const attachExternalDom = <Options>(
  element: Element,
  options: () => Options,
  adapter: ExternalDomAdapter<Options>,
  mode: "mount" | "hydrate" = "mount",
): ExternalDomHandle => {
  if (mode === "hydrate" && !adapter.hydrate) {
    throw new Error("An external DOM adapter must provide hydrate() to adopt server DOM.");
  }
  return createRoot((dispose, runInOwner, disposed) => {
    let instance: ExternalDomInstance<Options> | undefined;
    effect(() => {
      const next = options();
      runInOwner(() => {
        if (instance) {
          instance.update(next);
        } else {
          instance = mode === "hydrate" ? adapter.hydrate!(element, next) : adapter.mount(element, next);
          onOwnerCleanup(() => instance?.dispose());
        }
      });
    });
    return { dispose, disposed };
  });
};
