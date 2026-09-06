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
  sourceEnd?: number;
  revision?: string;
  kind?: string;
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
  /** First binding attributed to the owner; use `bindingsForOwner` when an owner spans several. */
  bindingForOwner: (ownerId: number) => TemplateBindingLocation | undefined;
  bindingsForOwner: (ownerId: number) => TemplateBindingLocation[];
  bindingForEffect: (effectId: number) => TemplateBindingLocation | undefined;
  /** Every live owner and effect that is attributed to a generated binding. */
  liveBindings: () => TemplateBindingLocation[];
  dispose: () => void;
};

const samePath = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

let snapshot: RuntimeDiagnosticsSnapshot = { owners: 0, effects: 0, subscriptions: 0, cleanups: 0 };

// Generated binding metadata and the live owner/effect ids attributed to it.
// Only ids and strings are retained; owners, DOM nodes, and closures are not.
const registeredTemplates = new Map<string, Map<number, TemplateBindingLocation>>();
const liveOwnerLocations = new Map<number, string>();
const liveEffectLocations = new Map<number, string>();
const liveEffectOwners = new Map<number, number>();

const templateKey = (templateId: string, revision: string): string => `${templateId}#${revision}`;

const locationFor = (
  locationId: string,
  ids: { ownerId?: number; effectId?: number },
): TemplateBindingLocation | undefined => {
  const separator = locationId.lastIndexOf("#");
  if (separator < 0) return undefined;
  const index = Number(locationId.slice(separator + 1));
  const registered = registeredTemplates.get(locationId.slice(0, separator))?.get(index);
  return registered ? { ...registered, ...ids } : undefined;
};
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
  templateBindingsRegistered: (templateId, revision, bindings) => {
    const key = templateKey(templateId, revision);
    if (registeredTemplates.has(key)) return;
    registeredTemplates.set(
      key,
      new Map(
        bindings.map(([index, kind, path, sourceStart, sourceEnd]) => [
          index,
          {
            templateId,
            revision,
            kind,
            path,
            bindingId: `${key}#${index}`,
            ...(sourceStart >= 0 ? { sourceOffset: sourceStart, sourceEnd } : {}),
          },
        ]),
      ),
    );
  },
  ownerCreated: (ownerId, bindingLocation) => {
    snapshot = { ...snapshot, owners: snapshot.owners + 1 };
    if (bindingLocation !== undefined) liveOwnerLocations.set(ownerId, bindingLocation);
    emit("owner-created", { ownerId });
  },
  ownerDisposed: (ownerId) => {
    snapshot = { ...snapshot, owners: Math.max(0, snapshot.owners - 1) };
    liveOwnerLocations.delete(ownerId);
    emit("owner-disposed", { ownerId });
  },
  effectCreated: (effectId, ownerId, bindingLocation) => {
    snapshot = { ...snapshot, effects: snapshot.effects + 1 };
    if (bindingLocation !== undefined) liveEffectLocations.set(effectId, bindingLocation);
    if (ownerId !== undefined) liveEffectOwners.set(effectId, ownerId);
    emit("effect-created", { effectId, ...(ownerId === undefined ? {} : { ownerId }) });
  },
  effectDisposed: (effectId) => {
    snapshot = { ...snapshot, effects: Math.max(0, snapshot.effects - 1) };
    liveEffectLocations.delete(effectId);
    liveEffectOwners.delete(effectId);
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
  const bindingsForOwner = (ownerId: number): TemplateBindingLocation[] => {
    const results: TemplateBindingLocation[] = [];
    const ownerLocation = liveOwnerLocations.get(ownerId);
    if (ownerLocation !== undefined) {
      const location = locationFor(ownerLocation, { ownerId });
      if (location) results.push(location);
    }
    for (const [effectId, effectOwner] of liveEffectOwners) {
      if (effectOwner !== ownerId) continue;
      const effectLocation = liveEffectLocations.get(effectId);
      const location = effectLocation === undefined ? undefined : locationFor(effectLocation, { effectId });
      if (location) results.push(location);
    }
    return results;
  };
  let disposed = false;
  return {
    snapshot: getRuntimeDiagnosticsSnapshot,
    events: () => collector.events,
    bindingFor: (templateId, path) =>
      bindingLocations.find((binding) => binding.templateId === templateId && samePath(binding.path, path)),
    bindingForOwner: (ownerId) =>
      bindingLocations.find((binding) => binding.ownerId === ownerId) ?? bindingsForOwner(ownerId)[0],
    bindingsForOwner,
    bindingForEffect: (effectId) => {
      const manual = bindingLocations.find((binding) => binding.effectId === effectId);
      if (manual) return manual;
      const location = liveEffectLocations.get(effectId);
      return location === undefined ? undefined : locationFor(location, { effectId });
    },
    liveBindings: () => [
      ...[...liveOwnerLocations].flatMap(([ownerId, location]) => locationFor(location, { ownerId }) ?? []),
      ...[...liveEffectLocations].flatMap(([effectId, location]) => locationFor(location, { effectId }) ?? []),
    ],
    dispose: () => {
      if (disposed) return;
      disposed = true;
      collectors.delete(collector);
    },
  };
};
