import {
  getRuntimeDiagnosticsSnapshot,
  setRuntimeDiagnosticsObserver,
  type RuntimeDiagnosticsEvent,
  type RuntimeDiagnosticsSnapshot,
} from "./signal.js";

export type TemplateBindingLocation = {
  templateId: string;
  path: readonly number[];
  sourceOffset?: number;
};

export type RuntimeDiagnosticsOptions = {
  bindings?: readonly TemplateBindingLocation[];
  onEvent?: (event: RuntimeDiagnosticsEvent) => void;
};

export type RuntimeDiagnostics = {
  snapshot: () => RuntimeDiagnosticsSnapshot;
  events: () => readonly RuntimeDiagnosticsEvent[];
  bindingFor: (templateId: string, path: readonly number[]) => TemplateBindingLocation | undefined;
  dispose: () => void;
};

const samePath = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

export const createRuntimeDiagnostics = (options: RuntimeDiagnosticsOptions = {}): RuntimeDiagnostics => {
  const events: RuntimeDiagnosticsEvent[] = [];
  const bindingLocations = [...(options.bindings ?? [])];
  const detach = setRuntimeDiagnosticsObserver((event) => {
    events.push(event);
    options.onEvent?.(event);
  });
  let disposed = false;
  return {
    snapshot: getRuntimeDiagnosticsSnapshot,
    events: () => events,
    bindingFor: (templateId, path) =>
      bindingLocations.find((binding) => binding.templateId === templateId && samePath(binding.path, path)),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      detach();
    },
  };
};
