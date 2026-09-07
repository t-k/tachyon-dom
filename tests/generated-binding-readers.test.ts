import { describe, expect, it } from "vitest";
import { compileTemplate, generateClientModule } from "../src/compiler";
import { mountConditional } from "../src/runtime/conditional";
import { mountKeyedList } from "../src/runtime/list";
import { mount } from "../src/runtime/mount";
import { createSignal } from "../src/runtime/signal";
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

// 073 moved text, class, attribute, and event rows onto the generated adapter. Attributes still go through the
// same sanitizing setter the generic runtime uses, which is what the URL policy depends on.
describe("generated row bindings", () => {
  const rowModule = (source: string) => evaluateGeneratedClientModule(generated(source, { reactive: true }));

  it("applies text, class, attribute, and event rows through the generated adapter", () => {
    const module = rowModule(
      `<ul><for each={rows} key={row.id}><li class:active={row.active} title={row.tip} on:click={select}>{row.label}</li></for></ul>`,
    );
    const root = document.createElement("div");
    const clicked: string[] = [];
    const rows = createSignal([
      { id: "a", active: true, tip: "TA", label: "A" },
      { id: "b", active: false, tip: "TB", label: "B" },
    ]);
    const handle = mount(root, module, { rows, select: () => clicked.push("click") });

    const items = () => Array.from(root.querySelectorAll("li"));
    expect(items().map((item) => item.textContent)).toEqual(["A", "B"]);
    expect(items().map((item) => item.getAttribute("class"))).toEqual(["active", null]);
    expect(items().map((item) => item.getAttribute("title"))).toEqual(["TA", "TB"]);

    const firstBefore = items()[0];
    items()[0]?.click();
    expect(clicked).toEqual(["click"]);

    rows.set([
      { id: "b", active: true, tip: "TB2", label: "B2" },
      { id: "a", active: false, tip: "TA2", label: "A2" },
    ]);
    expect(items().map((item) => item.textContent)).toEqual(["B2", "A2"]);
    expect(items().map((item) => item.getAttribute("class"))).toEqual(["active", null]);
    expect(items().map((item) => item.getAttribute("title"))).toEqual(["TB2", "TA2"]);
    // The moved row keeps its element and its listener.
    expect(items()[1]).toBe(firstBefore);
    items()[1]?.click();
    expect(clicked).toEqual(["click", "click"]);

    rows.set([{ id: "a", active: false, tip: "TA3", label: "A3" }]);
    expect(root.textContent).toBe("A3");
    handle.dispose();
    root.querySelector("li")?.click();
    expect(clicked).toEqual(["click", "click"]);
  });

  it("still rejects an unsafe URL attribute in a generated row", () => {
    const module = rowModule(`<ul><for each={rows} key={row.id}><li><a href={row.url}>{row.label}</a></li></for></ul>`);
    const root = document.createElement("div");

    expect(() =>
      mount(root, module, {
        rows: createSignal([{ id: "a", url: "javascript:alert(1)", label: "A" }]),
      }),
    ).toThrow();

    const safe = document.createElement("div");
    const handle = mount(safe, module, {
      rows: createSignal([{ id: "a", url: "https://example.com/", label: "A" }]),
    });
    expect(safe.querySelector("a")?.getAttribute("href")).toBe("https://example.com/");
    handle.dispose();
  });

  it("keeps rows with refs, models, styles, or nested regions on the generic runtime", () => {
    for (const source of [
      `<ul><for each={rows} key={row.id}><li ref={refs.item}>{row.label}</li></for></ul>`,
      `<ul><for each={rows} key={row.id}><li><input bind:value={row.draft}></li></for></ul>`,
      `<ul><for each={rows} key={row.id}><li style:width={row.width}>{row.label}</li></for></ul>`,
      `<ul><for each={groups} key={group.id}><li><ul><for each={group.rows} key={row.id}><li>{row.label}</li></for></ul></li></for></ul>`,
      `<ul><for each={rows} key={row.id}><li><if test={row.on}><b>{row.label}</b></if></li></for></ul>`,
    ]) {
      const code = generated(source, { reactive: true });
      expect([source, code.includes(`from "tachyon-dom/runtime/list"`)]).toEqual([source, true]);
      expect([source, code.includes(`from "tachyon-dom/runtime/list-text"`)]).toEqual([source, false]);
    }
  });
});
