import { describe, expect, it } from "vitest";
import { compileTemplate, generateClientModule } from "../src/compiler";
import { mountConditional, mountGeneratedConditional } from "../src/runtime/conditional";
import { mountGeneratedKeyedList, mountKeyedList } from "../src/runtime/list";
import { cleanupTextKeyedList, mountGeneratedTextKeyedList } from "../src/runtime/list-text";
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

  // A ref used to ship its path as a string for the runtime to walk. It now ships the same reader every other
  // binding does, plus the writer that puts the element there, so no generated module carries a path parser.
  it("writes a ref through a generated setter instead of a path string", () => {
    const row = generated(`<ul><for each={rows} key={row.id}><li ref={refs.item}></li></for></ul>`);

    expect(row).not.toContain(`expression:`);
    expect(row).toContain(`read: (scope) => scope.refs?.item`);
    expect(row).toContain(
      `write: (scope, value) => { const target = scope.refs; if (target != null && typeof target === "object") target["item"] = value; }`,
    );

    // Every step to the container is optional, so a deeper path still leaves a missing container alone.
    const deep = generated(`<ul><for each={rows} key={row.id}><li ref={refs.deep.item}></li></for></ul>`);
    expect(deep).toContain(`read: (scope) => scope.refs?.deep?.item`);
    expect(deep).toContain(`const target = scope.refs?.deep;`);
    expect(deep).toContain(`target["item"] = value`);

    const topLevel = generated(`<div ref={panel}></div>`);
    expect(topLevel).toContain(`bindRef as`);
    expect(topLevel).not.toContain(`setRef`);
    // A bare name is written straight onto the scope.
    expect(topLevel).toContain(
      `(scope, value) => { const target = scope; if (target != null && typeof target === "object") target["panel"] = value; }`,
    );
  });

  it("leaves a ref alone when the object that would hold it is missing", () => {
    const module = evaluateGeneratedClientModule(generated(`<div ref={refs.panel}></div>`));
    const root = document.createElement("div");
    const scope: { refs?: { panel?: Element } } = {};

    const handle = mount(root, module, scope);
    expect(scope.refs).toBeUndefined();
    handle.dispose();

    scope.refs = {};
    const second = mount(root, module, scope);
    expect(scope.refs.panel).toBe(root.querySelector("div"));
    second.dispose();
    expect(scope.refs.panel).toBeUndefined();
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

  // C01: the entries a generated module calls take descriptors whose readers are required and whose expression
  // strings are gone, so a codegen regression in either direction stops compiling instead of silently
  // resolving a different value.
  it("requires a reader on every generated list and branch descriptor", () => {
    type ListBinding = Parameters<typeof mountGeneratedKeyedList>[3]["bindings"][number];
    type BranchBinding = Parameters<typeof mountGeneratedConditional>[4]["bindings"][number];

    const root = document.createElement("ul");
    mountGeneratedKeyedList(root, [], [{ id: "a", label: "A" }], {
      key: "item.id",
      keyReadItem: (item) => (item as { id: string }).id,
      itemName: "item",
      templateHtml: `<li> </li>`,
      bindings: [{ kind: "text", path: [0], read: (scope) => (scope.item as { label: string }).label }],
    });
    expect(root.textContent).toBe("A");

    const branch = document.createElement("section");
    branch.innerHTML = `<!---->`;
    mountGeneratedConditional(branch, [0], true, { message: "M" }, {
      templateHtml: `<p> </p>`,
      bindings: [{ kind: "text", path: [0], read: (scope) => scope.message }],
    });
    expect(branch.textContent).toBe("M");

    // @ts-expect-error a generated descriptor without its reader is a compile error
    const listWithoutReader: ListBinding = { kind: "text", path: [0] };
    // @ts-expect-error a generated descriptor cannot carry an expression string to be resolved at runtime
    const listWithExpression: ListBinding = { kind: "text", path: [0], expression: "item.label" };
    // @ts-expect-error a generated ref has to carry the writer that puts the element there
    const listRefWithoutWriter: ListBinding = { kind: "ref", path: [], read: (scope) => scope.refs };
    // @ts-expect-error the same contract holds for a branch the generic runtime drives
    const branchWithoutReader: BranchBinding = { kind: "class", path: [], className: "on" };

    expect([listWithoutReader, listWithExpression, listRefWithoutWriter, branchWithoutReader]).toHaveLength(4);
  });

  it("clears a generated row ref only while it still holds the element it set", () => {
    const module = evaluateGeneratedClientModule(
      generated(`<ul><for each={rows} key={row.id}><li ref={refs.item}></li></for></ul>`, { reactive: true }),
    );
    const root = document.createElement("div");
    const refs: { item?: Element } = {};
    const rows = createSignal([{ id: "a" }]);
    const handle = mount(root, module, { rows, refs });

    expect(refs.item).toBe(root.querySelector("li"));

    const other = document.createElement("div");
    refs.item = other;
    rows.set([]);

    expect(refs.item).toBe(other);
    handle.dispose();
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

  // The handler is read when the event fires, so replacing it under the same key takes effect on the next click.
  it("calls the handler the row currently holds, not the one it was bound with", () => {
    const module = rowModule(`<ul><for each={rows} key={row.id}><li on:click={row.handler}>{row.label}</li></for></ul>`);
    const root = document.createElement("div");
    const calls: string[] = [];
    const row = (label: string, handler: (() => void) | undefined) => ({ id: "a", label, handler });
    const rows = createSignal([row("A", () => void calls.push("old"))]);
    const handle = mount(root, module, { rows });
    const firstRow = root.querySelector("li");

    firstRow?.click();
    rows.set([row("B", () => void calls.push("new"))]);
    expect(root.querySelector("li")).toBe(firstRow);
    expect(root.textContent).toBe("B");
    firstRow?.click();

    // A handler replaced by something that is not callable is skipped rather than thrown at.
    rows.set([row("C", undefined)]);
    expect(() => firstRow?.click()).not.toThrow();

    rows.set([row("D", () => void calls.push("third"))]);
    firstRow?.click();
    handle.dispose();
    firstRow?.click();

    expect(calls).toEqual(["old", "new", "third"]);
  });

  // A row that adopts server markup and then fails to bind leaves that markup in the document, so its listeners
  // have to come off; otherwise the page keeps reacting through a row nobody owns.
  it("releases an adopted row's listeners when its own binding fails while creating it", () => {
    const root = document.createElement("ul");
    root.innerHTML = `<li>server</li>`;
    const serverRow = root.firstElementChild;
    let clicks = 0;
    const options = {
      signature: "rollback",
      key: "item.id",
      keyReadItem: (item: unknown) => (item as { id: string }).id,
      itemName: "item",
      templateHtml: `<li> </li>`,
      bindings: [
        {
          kind: "text" as const,
          path: [0],
          read: () => {
            throw new Error("reader failed");
          },
        },
      ],
      events: [
        {
          path: [] as number[],
          bind: (element: Element): (() => void) => {
            const listener = (): void => {
              clicks++;
            };
            element.addEventListener("click", listener);
            return () => element.removeEventListener("click", listener);
          },
        },
      ],
    };

    expect(() => mountGeneratedTextKeyedList(root, [], [{ id: "a" }], options)).toThrow("reader failed");
    cleanupTextKeyedList(root, []);
    (serverRow as HTMLElement | null)?.click();

    expect(clicks).toBe(0);
    // The server markup itself is left where it was, the way the general keyed list leaves it.
    expect(root.firstElementChild).toBe(serverRow);
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
