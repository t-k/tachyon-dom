import { describe, expect, it } from "vitest";
import { compileTemplate, generateClientModule } from "../src/compiler";
import { hydrate, mount } from "../src/runtime/mount";
import { createSignal } from "../src/runtime/signal";
import { evaluateGeneratedClientModule } from "./generated-client-module";

const compiled = (source: string) => {
  const result = compileTemplate(source);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

const templates = {
  static: `<main><h1>Static</h1></main>`,
  text: `<main><p>{message}</p></main>`,
  conditional: `<main><if test={visible}><button on:click={save}>{label}</button></if><p>{tail}</p></main>`,
  list: `<ul><for each={rows} key={row.id}><li>{row.label}</li></for></ul>`,
  dialog: `<dialog><form><input bind:value={draft}></form></dialog>`,
} as const;

describe("mount-only client modules", () => {
  it("omits hydration metadata and the hydrate entry", () => {
    for (const source of Object.values(templates)) {
      const code = generateClientModule(compiled(source), { reactive: true, mountOnly: true });

      expect(code).toContain(`export const mountOnly = true;`);
      expect(code).toContain(`export const bind =`);
      expect(code).not.toContain(`export const hydrationBoundaries`);
      expect(code).not.toContain(`export const hydrationDynamicAttributes`);
      expect(code).not.toContain(`export const hydrationDynamicRegions`);
      expect(code).not.toContain(`export const componentBoundaries`);
      expect(code).not.toContain(`export const hydrate`);
    }
  });

  it("prepares conditionals from their template positions alone", () => {
    const code = generateClientModule(compiled(templates.conditional), { reactive: true, mountOnly: true });

    expect(code).toContain(`prepareConditionalCoreForMount as`);
    expect(code).not.toContain(`prepareConditionalCore as`);
    expect(code).not.toContain(`parentTagName`);
    expect(code).toContain(`__tachyonPrepareConditionalCoreForMount(root, [{ path: [0] }]);`);
  });

  it("rejects a mode that is both mount-only and hydration aware", () => {
    for (const options of [{ hydrateOnly: true }, { hydrationChunk: true }, { hydrationBoundaryId: "b" }] as const) {
      expect(() => generateClientModule(compiled(templates.text), { mountOnly: true, ...options })).toThrow(
        /mount-only/,
      );
    }
  });

  // A hydration boundary only means something against server output. Compiling one as mount-only would emit the
  // hydrate entry, the chunk loaders, and the hydration runtime the mode exists to leave out.
  it("rejects a template that declares a hydration boundary", () => {
    const withBoundary = compiled(
      `<main><section hydrate:interaction="click"><button on:click={save}>Save</button></section></main>`,
    );

    expect(() => generateClientModule(withBoundary, { reactive: true, mountOnly: true })).toThrow(
      /hydration boundaries/,
    );

    // Without the mode the same template keeps its boundary metadata, and the hydrate entry and chunk loaders
    // appear as soon as a caller supplies the chunk imports.
    const normal = generateClientModule(withBoundary, { reactive: true });
    expect(normal).toContain("export const hydrationBoundaries");
    expect(normal).not.toContain("export const mountOnly");
    const withChunks = generateClientModule(withBoundary, {
      reactive: true,
      hydrationChunkImports: { "td-h-1": "./island.td?client&tachyon-hydration=td-h-1" },
    });
    expect(withChunks).toContain("export const hydrate");
    expect(withChunks).toContain("hydrationChunks");
  });

  it("caches the two modes separately", () => {
    const template = compiled(templates.conditional);
    const normal = generateClientModule(template, { reactive: true });
    const mountOnly = generateClientModule(template, { reactive: true, mountOnly: true });

    expect(mountOnly).not.toBe(normal);
    expect(generateClientModule(template, { reactive: true })).toBe(normal);
    expect(generateClientModule(template, { reactive: true, mountOnly: true })).toBe(mountOnly);
  });

  it("refuses to hydrate before touching the server DOM", () => {
    const module = evaluateGeneratedClientModule(
      generateClientModule(compiled(templates.text), { reactive: true, mountOnly: true, instrumentBindings: false }),
    );
    const root = document.createElement("div");
    root.innerHTML = `<main><p>Server</p></main>`;
    const before = root.innerHTML;

    const result = hydrate(root, module, { message: createSignal("Client") });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected a hydration error.");
    expect(result.error.message).toContain("mount-only");
    expect(root.innerHTML).toBe(before);
  });

  it("mounts, updates, and disposes exactly like the hydration-aware module", () => {
    for (const [name, source] of Object.entries(templates)) {
      const run = (mountOnly: boolean) => {
        const module = evaluateGeneratedClientModule(
          generateClientModule(compiled(source), { reactive: true, mountOnly, instrumentBindings: false }),
        );
        const root = document.createElement("div");
        const scope = {
          message: createSignal("M"),
          visible: createSignal(true),
          label: createSignal("L"),
          tail: createSignal("T"),
          draft: createSignal("D"),
          save: () => undefined,
          rows: createSignal([{ id: "a", label: "A" }]),
        };
        const handle = mount(root, module, scope);
        const mounted = root.innerHTML;
        scope.message.set("M2");
        scope.label.set("L2");
        scope.visible.set(false);
        scope.rows.set([{ id: "b", label: "B" }]);
        const updated = root.innerHTML;
        handle.dispose();
        return { mounted, updated, disposed: root.innerHTML };
      };

      expect({ name, ...run(true) }).toEqual({ name, ...run(false) });
    }
  });
});
