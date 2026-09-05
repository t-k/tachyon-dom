import { describe, expect, it } from "vitest";
import { createRuntimeDiagnostics } from "../src/runtime/diagnostics";
import { createRoot, createSignal, effect } from "../src/runtime/signal";

describe("development runtime diagnostics", () => {
  it("observes resource counts without retaining disposed owners", () => {
    const diagnostics = createRuntimeDiagnostics({
      bindings: [{ templateId: "page.td", path: [0, 1], sourceOffset: 24 }],
    });
    const before = diagnostics.snapshot();
    const dispose = createRoot((disposeRoot) => {
      const value = createSignal(0);
      effect(() => value());
      value.set(1);
      return disposeRoot;
    });
    const active = diagnostics.snapshot();

    expect(active.owners).toBeGreaterThan(before.owners);
    expect(active.effects).toBeGreaterThan(before.effects);
    dispose();

    expect(diagnostics.snapshot()).toEqual(before);
    expect(diagnostics.bindingFor("page.td", [0, 1])).toEqual({
      templateId: "page.td",
      path: [0, 1],
      sourceOffset: 24,
    });
    expect(diagnostics.events().length).toBeGreaterThan(0);
    diagnostics.dispose();
  });

  it("keeps multiple diagnostic observers independent", () => {
    const first = createRuntimeDiagnostics();
    const second = createRuntimeDiagnostics();
    const dispose = createRoot((disposeRoot) => disposeRoot);

    expect(first.events().some((event) => event.type === "owner-created")).toBe(true);
    expect(second.events().some((event) => event.type === "owner-created")).toBe(true);

    const firstEventCount = first.events().length;
    const secondEventCount = second.events().length;
    first.dispose();
    const nextDispose = createRoot((disposeRoot) => disposeRoot);

    expect(first.events()).toHaveLength(firstEventCount);
    expect(second.events().length).toBeGreaterThan(secondEventCount);

    dispose();
    nextDispose();
    second.dispose();
  });
});
