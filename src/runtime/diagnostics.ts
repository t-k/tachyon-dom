import { setRuntimeLifecycleHooks, type RuntimeLifecycleHooks } from "./signal.js";

export type RuntimeDiagnosticsSnapshot = {
  owners: number;
  effects: number;
  subscriptions: number;
  cleanups: number;
};

export type RuntimeDiagnosticsEvent = {
  type:
    | "owner-created"
    | "owner-disposed"
    | "effect-created"
    | "effect-disposed"
    | "subscription-changed"
    | "cleanup-changed";
  snapshot: RuntimeDiagnosticsSnapshot;
  ownerId?: number;
  effectId?: number;
  delta?: 1 | -1;
};

export type TemplateBindingLocation = {
  templateId: string;
  path: readonly number[];
  sourceOffset?: number;
  bindingId?: string;
  ownerId?: number;
  effectId?: number;
};

export type RuntimeDiagnosticsOptions = {
  bindings?: readonly TemplateBindingLocation[];
  onEvent?: (event: RuntimeDiagnosticsEvent) => void;
};

export type RuntimeDiagnostics = {
  snapshot: () => RuntimeDiagnosticsSnapshot;
  events: () => readonly RuntimeDiagnosticsEvent[];
  bindingFor: (templateId: string, path: readonly number[]) => TemplateBindingLocation | undefined;
  bindingForOwner: (ownerId: number) => TemplateBindingLocation | undefined;
  bindingForEffect: (effectId: number) => TemplateBindingLocation | undefined;
  dispose: () => void;
};

const samePath = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

let snapshot: RuntimeDiagnosticsSnapshot = { owners: 0, effects: 0, subscriptions: 0, cleanups: 0 };
const collectors = new Set<{
  events: RuntimeDiagnosticsEvent[];
  onEvent: ((event: RuntimeDiagnosticsEvent) => void) | undefined;
}>();

const snapshotCopy = (): RuntimeDiagnosticsSnapshot => ({ ...snapshot });

const emit = (
  type: RuntimeDiagnosticsEvent["type"],
  details: { ownerId?: number; effectId?: number; delta?: 1 | -1 } = {},
): void => {
  const event: RuntimeDiagnosticsEvent = { type, snapshot: snapshotCopy(), ...details };
  for (const collector of Array.from(collectors)) {
    collector.events.push(event);
    try {
      collector.onEvent?.(event);
    } catch {
      // Diagnostics callbacks must never change runtime behavior.
    }
  }
};

const lifecycleHooks: RuntimeLifecycleHooks = {
  ownerCreated: (ownerId) => {
    snapshot = { ...snapshot, owners: snapshot.owners + 1 };
    emit("owner-created", { ownerId });
  },
  ownerDisposed: (ownerId) => {
    snapshot = { ...snapshot, owners: Math.max(0, snapshot.owners - 1) };
    emit("owner-disposed", { ownerId });
  },
  effectCreated: (effectId, ownerId) => {
    snapshot = { ...snapshot, effects: snapshot.effects + 1 };
    emit("effect-created", { effectId, ...(ownerId === undefined ? {} : { ownerId }) });
  },
  effectDisposed: (effectId) => {
    snapshot = { ...snapshot, effects: Math.max(0, snapshot.effects - 1) };
    emit("effect-disposed", { effectId });
  },
  subscriptionChanged: (delta) => {
    snapshot = { ...snapshot, subscriptions: Math.max(0, snapshot.subscriptions + delta) };
    emit("subscription-changed", { delta });
  },
  cleanupChanged: (delta) => {
    snapshot = { ...snapshot, cleanups: Math.max(0, snapshot.cleanups + delta) };
    emit("cleanup-changed", { delta });
  },
};

setRuntimeLifecycleHooks(lifecycleHooks);

export const getRuntimeDiagnosticsSnapshot = (): RuntimeDiagnosticsSnapshot => snapshotCopy();

export const createRuntimeDiagnostics = (options: RuntimeDiagnosticsOptions = {}): RuntimeDiagnostics => {
  const collector = { events: [] as RuntimeDiagnosticsEvent[], onEvent: options.onEvent };
  collectors.add(collector);
  const bindingLocations = [...(options.bindings ?? [])];
  let disposed = false;
  return {
    snapshot: getRuntimeDiagnosticsSnapshot,
    events: () => collector.events,
    bindingFor: (templateId, path) =>
      bindingLocations.find((binding) => binding.templateId === templateId && samePath(binding.path, path)),
    bindingForOwner: (ownerId) => bindingLocations.find((binding) => binding.ownerId === ownerId),
    bindingForEffect: (effectId) => bindingLocations.find((binding) => binding.effectId === effectId),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      collectors.delete(collector);
    },
  };
};
