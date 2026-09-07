import { describe, expect, it } from "vitest";
import { compileTemplate, generateClientModule } from "../src/compiler";
import { mountConditional } from "../src/runtime/conditional";
import { mountKeyedList } from "../src/runtime/list";
import { mount } from "../src/runtime/mount";
import { evaluateGeneratedClientModule } from "./generated-client-module";

const generated = (source: string, options: Parameters<typeof generateClientModule>[1] = {}) => {
  const compiled = compileTemplate(source);
  if (!compiled.ok) throw new Error(compiled.error.message);
  return generateClientModule(compiled.value, { instrumentBindings: false, ...options });
};

describe("generated binding readers", () => {
  it("ships compiled readers instead of the expression strings they came from", () => {
    const code = generated(
      `<main><ul><for each={data.rows} key={row.id}><li class:on={row.on} title={row.tip} on:click={select}>{row.label}</li></for></ul><if test={panel.open}><section><b>{panel.heading}</b><input bind:value={panel.draft}></section></if></main>`,
      { reactive: true },
    );

    expect(code).not.toContain(`expression:`);
    expect(code).not.toContain(`handler:`);
    expect(code).toContain(`read: (scope) =>`);
    expect(code).toContain(`write: (scope, value) =>`);
    expect(code).toContain(`keyReadItem:`);
  });

  it("keeps the path string only where the runtime writes back through it", () => {
    const code = generated(`<ul><for each={rows} key={row.id}><li ref={refs.item}></li></for></ul>`);

    expect(code).toContain(`expression: "refs.item"`);
    expect(code.match(/expression:/g)).toHaveLength(1);
  });

  it("drops the declaration strings from generated stores and component props", () => {
    const code = generated(
      `<main><ul><for each={rows} key={row.id}><li><store name="draft" initial={row.label}></store>{draft}</li></for></ul></main>`,
      { reactive: true },
    );

    expect(code).toMatch(/stores: \[\{ name: "\w+", key: "__tachyon_store_\d+_\d+", read: \(scope\) => scope\.row\.label \}\]/);
    expect(code).not.toContain(`initial:`);
  });

  it("runs a generated list and conditional entirely from their readers", () => {
    const module = evaluateGeneratedClientModule(
      generated(
        `<main><ul><for each={data.rows} key={row.id}><li class:on={row.on} title={row.tip}>{row.label}</li></for></ul><if test={panel.open}><b>{panel.heading}</b></if></main>`,
        { reactive: true },
      ),
    );
    const root = document.createElement("div");
    const handle = mount(root, module, {
      data: { rows: [{ id: "a", on: true, tip: "T", label: "A" }] },
      panel: { open: true, heading: "H" },
    });

    expect(root.querySelector("li")?.getAttribute("class")).toBe("on");
    expect(root.querySelector("li")?.getAttribute("title")).toBe("T");
    expect(root.textContent).toBe("AH");
    handle.dispose();
  });

  // Hand-written descriptors carry expression strings and no readers; that path stays supported.
  it("still resolves a hand-written descriptor that has no readers", () => {
    const root = document.createElement("ul");
    mountKeyedList(root, [], [{ id: "a", label: "A" }], {
      key: "item.id",
      itemName: "item",
      templateHtml: `<li><span> </span></li>`,
      bindings: [{ kind: "text", path: [0, 0], expression: "item.label" }],
    });

    expect(root.textContent).toBe("A");

    const branch = document.createElement("section");
    branch.innerHTML = `<!---->`;
    mountConditional(branch, [0], true, { message: "M" }, {
      templateHtml: `<p> </p>`,
      bindings: [{ kind: "text", path: [0], expression: "message" }],
    });

    expect(branch.textContent).toBe("M");
  });

  it("clears a row ref only while it still holds the element it set", () => {
    const root = document.createElement("ul");
    const refs: { item?: Element } = {};
    const options = {
      key: "item.id",
      itemName: "item",
      templateHtml: `<li></li>`,
      bindings: [{ kind: "ref" as const, path: [], expression: "refs.item" }],
      scope: { refs },
    };

    mountKeyedList(root, [], [{ id: "a" }], options);
    const first = refs.item;
    expect(first).toBe(root.querySelector("li"));

    const other = document.createElement("div");
    refs.item = other;
    mountKeyedList(root, [], [], options);

    expect(refs.item).toBe(other);
  });
});
