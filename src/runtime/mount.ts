import { err, ok, type Result } from "../result.js";
import { diagnoseHydrationBoundaries, type CompiledHydrationBoundary } from "./hydrate.js";

export type ClientTemplateModule<Scope extends Record<string, unknown> = Record<string, unknown>> = {
  templateHtml: string;
  hydrationBoundaries?: readonly CompiledHydrationBoundary[];
  bind: (root: Element, scope: Scope) => void | (() => void);
};

export type MountHandle = {
  root: Element;
  disposed: () => boolean;
  dispose: () => void;
};

export type HydrateError = {
  message: string;
  diagnostics?: ReturnType<typeof diagnoseHydrationBoundaries>;
};

const handleFor = (root: Element, cleanup: void | (() => void)): MountHandle => {
  let isDisposed = false;
  return {
    root,
    disposed: () => isDisposed,
    dispose: () => {
      if (isDisposed) return;
      isDisposed = true;
      cleanup?.();
    },
  };
};

export const mount = <Scope extends Record<string, unknown>>(
  root: Element,
  module: ClientTemplateModule<Scope>,
  scope?: Scope,
): MountHandle => {
  const previousChildren = Array.from(root.childNodes);
  try {
    root.innerHTML = module.templateHtml;
    return handleFor(root, module.bind(root, scope as Scope));
  } catch (error) {
    root.replaceChildren(...previousChildren);
    throw error;
  }
};

export const hydrate = <Scope extends Record<string, unknown>>(
  root: Element,
  module: ClientTemplateModule<Scope>,
  scope?: Scope,
): Result<MountHandle, HydrateError> => {
  const ids = (module.hydrationBoundaries ?? [])
    .filter((boundary) => boundary.idKind !== "expression")
    .map((boundary) => boundary.id);
  const diagnostics = diagnoseHydrationBoundaries(root, ids);
  if (diagnostics.length > 0) {
    return err({
      message: diagnostics.map((diagnostic) => diagnostic.message).join(" "),
      diagnostics,
    });
  }
  try {
    return ok(handleFor(root, module.bind(root, scope as Scope)));
  } catch (error) {
    return err({ message: error instanceof Error ? error.message : String(error) });
  }
};

export const mountClientTemplate = mount;
export const hydrateClientTemplate = hydrate;
