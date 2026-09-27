import { describe, expect, it } from "vitest";
import { createInspectorReport } from "../src/inspector";
import { createRuntimeDiagnostics } from "../src/runtime/diagnostics";
import { batch, createMemo, createRoot, createSignal, createStore, effect, onCleanup } from "../src/runtime/signal";
import { compileTemplate, generateClientModule } from "../src/compiler";
import { mount } from "../src/runtime/mount";
import { evaluateGeneratedClientModule } from "./generated-client-module";

describe("opt-in Inspector update tracing", () => {
  it("does not subscribe a traced effect to signals read by a diagnostics callback", () => {
    const observed = createSignal(0);
    const trigger = createSignal(0);
    const diagnostics = createRuntimeDiagnostics({
      traceUpdates: true,
      onEvent: (event) => {
        if (event.type === "effect-ran") observed();
      },
    });
    let runs = 0;
    const dispose = createRoot((disposeRoot) => {
      effect(() => {
        trigger();
        runs++;
      });
      return disposeRoot;
    });
    trigger.set(1);
    observed.set(1);
    expect(runs).toBe(2);
    dispose();
    diagnostics.dispose();
  });

  it("keeps update event objects independent between collectors", () => {
    const first = createRuntimeDiagnostics({ traceUpdates: true });
    const second = createRuntimeDiagnostics({ traceUpdates: true });
    const source = createSignal(0);
    const dispose = createRoot((disposeRoot) => {
      effect(() => source());
      return disposeRoot;
    });
    source.set(1);
    const firstEvent = first.events().find((event) => event.type === "effect-ran");
    const secondEvent = second.events().find((event) => event.type === "effect-ran");
    expect(firstEvent).toEqual(secondEvent);
    expect(firstEvent).not.toBe(secondEvent);
    expect(firstEvent?.triggerSourceIds).not.toBe(secondEvent?.triggerSourceIds);
    dispose();
    first.dispose();
    second.dispose();
  });

  it("defers a diagnostics-triggered flush until an enclosing effect finishes", () => {
    const source = createSignal(0);
    const observed = createSignal(0);
    let memoEffectId: number | undefined;
    const order: string[] = [];
    let cleanups = 0;
    const diagnostics = createRuntimeDiagnostics({
      traceUpdates: true,
      onEvent: (event) => {
        if (event.type === "effect-ran" && event.effectId === memoEffectId) observed.set(1);
      },
    });
    const dispose = createRoot((disposeRoot) => {
      const derived = createMemo(() => source());
      memoEffectId = diagnostics.events().find((event) => event.type === "effect-created")?.effectId;
      effect(() => {
        const value = observed();
        order.push(`start:${value}`);
        if (value === 0) {
          source.set(1);
          derived();
        }
        onCleanup(() => cleanups++);
        order.push(`end:${value}`);
      });
      return disposeRoot;
    });
    expect(order).toEqual(["start:0", "end:0", "start:1", "end:1"]);
    expect(cleanups).toBe(1);
    dispose();
    expect(cleanups).toBe(2);
    diagnostics.dispose();
  });

  it("records one rerun with every changed source in a batch and no values", () => {
    const traced = createRuntimeDiagnostics({ traceUpdates: true });
    const passive = createRuntimeDiagnostics();
    const first = createSignal("private-first");
    const second = createSignal("private-second");
    let runs = 0;
    const dispose = createRoot((disposeRoot) => {
      effect(() => {
        first();
        second();
        runs++;
      });
      return disposeRoot;
    });
    const effectId = traced.events().find((event) => event.type === "effect-created")?.effectId;
    expect(effectId).toBeTypeOf("number");
    expect(traced.events().filter((event) => event.type === "effect-ran")).toHaveLength(0);

    batch(() => {
      first.set("private-next-first");
      second.set("private-next-second");
    });
    expect(runs).toBe(2);
    const updates = traced.events().filter((event) => event.type === "effect-ran");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.effectId).toBe(effectId);
    expect(updates[0]?.triggerSourceIds).toHaveLength(2);
    expect(new Set(updates[0]?.triggerSourceIds).size).toBe(2);
    expect(passive.events().filter((event) => event.type === "effect-ran")).toHaveLength(0);

    first.set("private-next-first");
    expect(traced.events().filter((event) => event.type === "effect-ran")).toHaveLength(1);
    const report = createInspectorReport(traced, { includeLifecycleEvents: true });
    const reportedUpdate = report.observed.lifecycleEvents?.find((event) => event.type === "effect-ran");
    expect(reportedUpdate).toBeDefined();
    expect(reportedUpdate?.triggerSourceIds).toEqual(updates[0]?.triggerSourceIds);
    expect(reportedUpdate?.triggerSourceIds).not.toBe(updates[0]?.triggerSourceIds);
    expect(JSON.stringify(report)).not.toContain("private-");

    dispose();
    const count = traced.events().length;
    first.set("private-after-dispose");
    expect(traced.events()).toHaveLength(count);
    traced.dispose();
    passive.dispose();
  });

  it("tracks active dynamic dependencies and the original source through a memo", () => {
    const diagnostics = createRuntimeDiagnostics({ traceUpdates: true });
    const selected = createSignal(true);
    const left = createSignal(1);
    const right = createSignal(2);
    let value = 0;
    const dispose = createRoot((disposeRoot) => {
      const derived = createMemo(() => (selected() ? left() : right()) * 2);
      effect(() => {
        value = derived();
      });
      return disposeRoot;
    });
    expect(value).toBe(2);

    left.set(3);
    expect(value).toBe(6);
    const effectId = diagnostics.events().filter((event) => event.type === "effect-created").at(-1)?.effectId;
    const firstUpdate = diagnostics.events().find((event) => event.type === "effect-ran" && event.effectId === effectId);
    expect(firstUpdate?.triggerSourceIds).toHaveLength(1);

    selected.set(false);
    const afterSwitch = diagnostics.events().filter((event) => event.type === "effect-ran" && event.effectId === effectId);
    expect(value).toBe(4);
    left.set(4);
    expect(value).toBe(4);
    expect(diagnostics.events().filter((event) => event.type === "effect-ran" && event.effectId === effectId)).toHaveLength(
      afterSwitch.length,
    );
    right.set(5);
    expect(value).toBe(10);
    const lastUpdate = diagnostics.events().filter((event) => event.type === "effect-ran" && event.effectId === effectId).at(-1);
    expect(lastUpdate?.triggerSourceIds).toHaveLength(1);
    expect(lastUpdate?.triggerSourceIds).not.toEqual(firstUpdate?.triggerSourceIds);

    dispose();
    diagnostics.dispose();
  });

  it("keeps every source when a memo pulls another memo during the same batch", () => {
    const diagnostics = createRuntimeDiagnostics({ traceUpdates: true });
    const first = createSignal(1);
    const second = createSignal(1);
    const dispose = createRoot((disposeRoot) => {
      const inner = createMemo(() => first());
      const outer = createMemo(() => inner() + second());
      effect(() => outer());
      return disposeRoot;
    });
    const ids = diagnostics.events().filter((event) => event.type === "effect-created").map((event) => event.effectId);
    batch(() => {
      second.set(2);
      first.set(2);
    });
    const updates = diagnostics.events().filter((event) => event.type === "effect-ran");
    const innerSources = updates.find((event) => event.effectId === ids[0])?.triggerSourceIds;
    const outerSources = updates.find((event) => event.effectId === ids[1])?.triggerSourceIds;
    const effectSources = updates.find((event) => event.effectId === ids[2])?.triggerSourceIds;
    expect(innerSources).toHaveLength(1);
    expect(outerSources).toHaveLength(2);
    expect(effectSources).toHaveLength(2);
    expect(outerSources).toEqual(effectSources);
    expect(outerSources).toContain(innerSources?.[0]);
    dispose();
    diagnostics.dispose();
  });

  it("attributes generated binding reruns to source offsets without collecting store values", () => {
    const source = `<p>{profile.name}</p>`;
    const compiled = compileTemplate(source);
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(
      generateClientModule(compiled.value, { reactive: true, templateId: "profile.td", sourceRevision: "rev1" }),
    );
    const diagnostics = createRuntimeDiagnostics({ traceUpdates: true });
    const profile = createStore({ name: "secret-first" });
    const root = document.createElement("div");
    const handle = mount(root, module, { profile });
    try {
      profile.name = "secret-second";
      expect(root.textContent).toBe("secret-second");
      const update = diagnostics.events().find((event) => event.type === "effect-ran");
      expect(update?.triggerSourceIds).toHaveLength(1);
      const location = diagnostics.bindingForEffect(update?.effectId as number);
      expect(location?.templateId).toBe("profile.td");
      if (location?.sourceOffset === undefined || location.sourceEnd === undefined)
        throw new Error("Missing generated binding source span.");
      expect(source.slice(location.sourceOffset, location.sourceEnd)).toBe("profile.name");
      expect(JSON.stringify(createInspectorReport(diagnostics, { includeLifecycleEvents: true }))).not.toContain(
        "secret-",
      );
    } finally {
      handle.dispose();
      diagnostics.dispose();
    }
  });
});
