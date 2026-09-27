import { describe, expect, it } from "vitest";
import { compileTemplate, generateClientModule } from "../src/compiler";
import { mount } from "../src/runtime/mount";
import { createSignal } from "../src/runtime/signal";
import { evaluateGeneratedClientModule } from "./generated-client-module";

const generated = (source: string): string => {
  const compiled = compileTemplate(source);
  if (!compiled.ok) throw new Error(compiled.error.message);
  return generateClientModule(compiled.value, { reactive: true, instrumentBindings: false });
};

describe("generated region metadata", () => {
  it("omits empty ownership and hydration fields from list and conditional options", () => {
    const code = generated(
      `<ul><for each={rows} key={row.id}><li><if test={row.visible}><span>{row.label}</span></if></li></for></ul>`,
    );

    expect(code).not.toMatch(/\b(?:stores|components|hydrationBoundaries): \[\]/);
  });

  it("retains nonempty row stores and updates rows after metadata omission", () => {
    const code = generated(
      `<ul><for each={rows} key={row.id}><li><store seen={row.label}/><b>{seen}</b></li></for></ul>`,
    );
    expect(code).toMatch(/\bstores: \[/);

    const module = evaluateGeneratedClientModule(code);
    const root = document.createElement("div");
    const rows = createSignal([{ id: 1, label: "A" }]);
    const handle = mount(root, module, { rows });
    try {
      expect(root.querySelector("b")?.textContent).toBe("A");
      rows.set([{ id: 2, label: "B" }]);
      expect(root.querySelector("b")?.textContent).toBe("B");
    } finally {
      handle.dispose();
    }
  });
});
