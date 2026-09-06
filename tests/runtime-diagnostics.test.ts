import { describe, expect, it } from "vitest";
import { createRuntimeDiagnostics } from "../src/runtime/diagnostics";
import { createResource, createRoot, createSignal, effect } from "../src/runtime/signal";
import { compileTemplate, generateClientHydrationChunkModule, generateClientModule } from "../src/compiler";
import { mount } from "../src/runtime/mount";
import { evaluateGeneratedClientModule } from "./generated-client-module";

describe("development runtime diagnostics", () => {
  it("detaches individually disposed resource cleanups from a live root", () => {
    const diagnostics = createRuntimeDiagnostics();
    const before = diagnostics.snapshot();
    const resources: Array<ReturnType<typeof createResource<string, never>>> = [];
    const disposeRoot = createRoot((dispose) => {
      for (let index = 0; index < 1000; index++) {
        resources.push(createResource("source", () => new Promise<never>(() => undefined)));
      }
      return dispose;
    });

    const active = diagnostics.snapshot();
    expect(active.cleanups).toBe(before.cleanups + 1000);
    for (const resource of resources) resource.dispose();

    expect(diagnostics.snapshot()).toEqual({ ...active, cleanups: before.cleanups });
    disposeRoot();
    expect(diagnostics.snapshot()).toEqual(before);
    diagnostics.dispose();
  });

  it("returns to the diagnostics baseline after initial effect self-disposal", () => {
    const diagnostics = createRuntimeDiagnostics();
    const before = diagnostics.snapshot();
    const source = createSignal(0);
    let runs = 0;
    const disposeRoot = createRoot((dispose) => {
      effect(() => {
        source();
        runs++;
        dispose();
      });
      return dispose;
    });

    source.set(1);

    expect(runs).toBe(1);
    expect(diagnostics.snapshot()).toEqual(before);
    disposeRoot();
    diagnostics.dispose();
  });

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

  it("resolves live effects and owners of a generated module back to template source spans", () => {
    const source = `<main><h1>{title}</h1><p class:on={active}>x</p><if test={show}><b>{note}</b></if><ul><for each={rows} key={row.id}><li>{row.label}</li></for></ul></main>`;
    const compiled = compileTemplate(source);
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(
      generateClientModule(compiled.value, { reactive: true, templateId: "src/page.td", sourceRevision: "rev1" }),
    );
    const diagnostics = createRuntimeDiagnostics();
    const show = createSignal(false);
    const rows = createSignal([{ id: 1, label: "one" }]);
    const root = document.createElement("div");
    document.body.append(root);
    const handle = mount(root, module, { title: "T", active: true, show, rows });
    try {
      const spans = new Map<string, string>();
      for (const location of diagnostics.liveBindings()) {
        if (location.sourceOffset === undefined || location.sourceEnd === undefined) continue;
        spans.set(location.bindingId ?? "", source.slice(location.sourceOffset, location.sourceEnd));
      }
      expect([...spans.values()].sort()).toEqual(["active", "rows", "show", "title"]);

      const textEffect = diagnostics
        .events()
        .filter((event) => event.type === "effect-created")
        .map((event) => diagnostics.bindingForEffect(event.effectId as number))
        .find((location) => location?.kind === "text");
      expect(textEffect?.templateId).toBe("src/page.td");
      expect(textEffect?.revision).toBe("rev1");
      expect(textEffect?.path).toEqual([0, 0]);

      // Bindings created lazily by reruns (a branch, a new row) are attributed
      // to the enclosing generated binding rather than leaking to another.
      const listEffects = (): Set<number> =>
        new Set(
          diagnostics
            .liveBindings()
            .filter((location) => location.kind === "list" && location.effectId !== undefined)
            .map((location) => location.effectId as number),
        );
      const before = listEffects();
      show.set(true);
      rows.set([...rows(), { id: 2, label: "two" }]);
      const after = diagnostics.liveBindings();
      // The second row's effect is created during the list effect's rerun and
      // is attributed to the <for> binding, not to any other one.
      const newListEffects = [...listEffects()].filter((effectId) => !before.has(effectId));
      expect(newListEffects.length).toBeGreaterThan(0);
      expect(new Set(after.map((location) => location.kind))).toEqual(new Set(["class", "text", "if", "list"]));
      const listOwners = after.filter((location) => location.kind === "list" && location.ownerId !== undefined);
      expect(listOwners.length).toBeGreaterThan(0);
      const first = listOwners[0] as { ownerId: number };
      expect(diagnostics.bindingsForOwner(first.ownerId).every((location) => location.kind === "list")).toBe(true);
    } finally {
      handle.dispose();
    }
    expect(diagnostics.liveBindings()).toEqual([]);
    diagnostics.dispose();
  });

  it("assigns stable anonymous diagnostics identities to direct compilations", () => {
    const source = `<main><h1>{title}</h1><p>{message}</p></main>`;
    const compiled = compileTemplate(source);
    if (!compiled.ok) throw new Error(compiled.error.message);
    const code = generateClientModule(compiled.value, { reactive: true });
    const repeatedCode = generateClientModule(compiled.value, { reactive: true });
    const other = compileTemplate(`<main><h1>{title}</h1><p>{other}</p></main>`);
    if (!other.ok) throw new Error(other.error.message);
    const otherCode = generateClientModule(other.value, { reactive: true });
    const identityFrom = (value: string): { templateId: string; revision: string } => {
      const match = value.match(/__tachyonRegisterBindings\("([^"]+)", "([^"]+)"/);
      if (!match?.[1] || !match[2]) throw new Error("Missing anonymous diagnostics identity.");
      return { templateId: match[1], revision: match[2] };
    };
    const identity = identityFrom(code);
    const otherIdentity = identityFrom(otherCode);
    expect(repeatedCode).toBe(code);
    expect(identity.templateId).toMatch(/^anonymous:/);
    expect(identity.revision).toMatch(/^[0-9a-f]+$/);
    expect(identity).not.toEqual(otherIdentity);

    const module = evaluateGeneratedClientModule(code);
    const diagnostics = createRuntimeDiagnostics();
    const root = document.createElement("div");
    document.body.append(root);
    const handle = mount(root, module, { title: "Ada", message: "Ready" });
    try {
      const locations = diagnostics.liveBindings().filter((location) => location.kind === "text");
      expect(locations.filter((location) => location.effectId !== undefined)).toHaveLength(2);
      expect(locations.every((location) => location.templateId === identity.templateId)).toBe(true);
      expect(locations.every((location) => location.revision === identity.revision)).toBe(true);
      expect(locations.every((location) => location.sourceOffset !== undefined)).toBe(true);
    } finally {
      handle.dispose();
      diagnostics.dispose();
    }
  });

  it("assigns independent anonymous diagnostics identities to hydration chunks", () => {
    const source = `<main><p hydrate:idle>{first}</p><p hydrate:idle>{second}</p></main>`;
    const compiled = compileTemplate(source);
    if (!compiled.ok) throw new Error(compiled.error.message);
    const diagnostics = createRuntimeDiagnostics();
    const disposers: Array<() => void> = [];
    const sourceSlices = (): string[] =>
      diagnostics
        .liveBindings()
        .filter((location) => location.kind === "text" && location.effectId !== undefined)
        .flatMap((location) =>
          location.sourceOffset === undefined || location.sourceEnd === undefined
            ? []
            : [source.slice(location.sourceOffset, location.sourceEnd)],
        );
    try {
      for (const boundary of compiled.value.client.hydrationBoundaries) {
        const module = evaluateGeneratedClientModule(
          generateClientHydrationChunkModule(compiled.value, boundary.id, { reactive: true }),
        );
        const host = document.createElement("div");
        host.innerHTML = module.templateHtml;
        const root = host.firstElementChild;
        if (!(root instanceof HTMLElement)) throw new Error("Missing hydration chunk root.");
        const dispose = module.bind?.(root, { first: "ONE", second: "TWO" });
        if (dispose) disposers.push(dispose);
      }

      expect(sourceSlices()).toEqual(["first", "second"]);
    } finally {
      for (const dispose of disposers.reverse()) dispose();
      diagnostics.dispose();
    }
  });
});
