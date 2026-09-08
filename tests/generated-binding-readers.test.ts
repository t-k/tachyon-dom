import { describe, expect, it } from "vitest";
import { compileTemplate, generateClientModule } from "../src/compiler";
import { mountConditional, mountGeneratedConditional } from "../src/runtime/conditional";
import { mountGeneratedKeyedList, mountKeyedList } from "../src/runtime/list";
import { cleanupTextKeyedList, mountGeneratedTextKeyedList } from "../src/runtime/list-text";
import { mount } from "../src/runtime/mount";
import { createSignal } from "../src/runtime/signal";
import { createStore } from "../src/runtime/store";
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
    // A control in a generated region carries the binder that drives it, not a writer the runtime interprets.
    expect(code).toContain(`bind: (scope, element) =>`);
    expect(code).not.toContain(`write: (scope, value) =>`);
    expect(code).toContain(`keyReadItem:`);
  });

  // A ref used to ship its path as a string for the runtime to walk. It now ships a reader for the object that
  // holds it and the property name on that object, so no generated module carries a path parser and the runtime
  // can capture the container it wrote into.
  it("names a ref's container and property instead of shipping a path string", () => {
    const row = generated(`<ul><for each={rows} key={row.id}><li ref={refs.item}></li></for></ul>`);

    expect(row).not.toContain(`expression:`);
    expect(row).toContain(`owner: (scope) => scope.refs, property: "item"`);

    // Every step to the container is optional, so a deeper path still leaves a missing container alone.
    const deep = generated(`<ul><for each={rows} key={row.id}><li ref={refs.deep.item}></li></for></ul>`);
    expect(deep).toContain(`owner: (scope) => scope.refs?.deep, property: "item"`);

    const topLevel = generated(`<div ref={panel}></div>`);
    expect(topLevel).toContain(`bindRef as`);
    expect(topLevel).not.toContain(`setRef`);
    // A bare name is written straight onto the scope.
    expect(topLevel).toContain(`(scope) => scope, "panel"`);
  });

  // The generated writer assigns straight into the object the path names, so the property it writes has to be
  // one the expression parser allows. It rejects the prototype keys before any code is generated.
  it("refuses to compile a ref that would write a prototype key", () => {
    for (const source of [
      `<div ref={obj.__proto__}></div>`,
      `<div ref={obj.constructor}></div>`,
      `<div ref={obj.prototype}></div>`,
      `<ul><for each={rows} key={row.id}><li ref={row.__proto__}></li></for></ul>`,
    ]) {
      const result = compileTemplate(source);
      expect([source, result.ok]).toEqual([source, false]);
    }
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

  // A container that is present but is not something a property can be written to is left alone the same way a
  // missing one is, rather than throwing out of the whole bind.
  it("leaves a ref alone when the value in its container's place cannot hold one", () => {
    const module = evaluateGeneratedClientModule(generated(`<div ref={refs.panel}></div>`));

    // `typeof null` is "object", so a null container has to be caught by the null check rather than the type one.
    for (const refs of [null, "text", 7, true, Symbol("refs"), () => undefined]) {
      const root = document.createElement("div");
      const scope = { refs };
      const handle = mount(root, module, scope);

      expect([typeof refs, scope.refs]).toEqual([typeof refs, refs]);
      expect(() => handle.dispose()).not.toThrow();
      expect([typeof refs, scope.refs]).toEqual([typeof refs, refs]);
    }
  });

  // Rows the generic keyed list drives take everything from the descriptor: the setter for each value, the
  // binder for each control, and the entry that mounts each nested region. Nothing else reaches those
  // accessors, so every kind a row can hold is exercised through the generated entry here.
  it("drives every row binding kind through the generated keyed list entry", () => {
    const module = evaluateGeneratedClientModule(
      generated(
        `<ul><for each={rows} key={row.id}><li class:on={row.on} title={row.tip} style:color={row.hue} ref={refs.node} on:click={pick}><input bind:value={row.draft}><ul><for each={row.tags} key={tag.id}><li>{tag.label}</li></for></ul><if test={row.open}><em>{row.label}</em></if></li></for></ul>`,
        { reactive: true },
      ),
    );
    const root = document.createElement("div");
    const picks: string[] = [];
    const row = {
      id: "a",
      on: true,
      tip: "Tip",
      hue: "red",
      draft: "typed",
      label: "A",
      open: true,
      tags: [{ id: "t", label: "T" }],
    };
    const rows = createSignal([row]);
    const scope = { rows, refs: {} as { node?: Element }, pick: () => picks.push("pick") };

    const handle = mount(root, module, scope);
    const item = root.querySelector("li");
    const input = root.querySelector("input");
    if (!(item instanceof HTMLElement) || !(input instanceof HTMLInputElement)) throw new Error("Missing nodes.");

    expect(item.classList.contains("on")).toBe(true);
    expect(item.getAttribute("title")).toBe("Tip");
    expect(item.style.color).toBe("red");
    expect(scope.refs.node).toBe(item);
    expect(input.value).toBe("typed");
    expect(item.querySelector("li")?.textContent).toBe("T");
    expect(item.querySelector("em")?.textContent).toBe("A");

    item.click();
    expect(picks).toEqual(["pick"]);

    input.value = "edited";
    input.dispatchEvent(new Event("input"));
    expect(row.draft).toBe("edited");

    rows.set([{ ...row, on: false, tip: "Other", hue: "blue", open: false, tags: [{ id: "u", label: "U" }] }]);
    expect(item.classList.contains("on")).toBe(false);
    expect(item.getAttribute("title")).toBe("Other");
    expect(item.style.color).toBe("blue");
    expect(item.querySelector("li")?.textContent).toBe("U");
    expect(item.querySelector("em")).toBeNull();

    handle.dispose();
    expect(scope.refs.node).toBeUndefined();
  });

  // A region's signature only has to change when its shape changes. A build that ships no development
  // instrumentation identifies it by a digest of that shape rather than by a second copy of the template HTML
  // and of every expression string the readers already replaced.
  it("identifies generated regions by a digest when the module ships no instrumentation", () => {
    const source = `<main><ul><for each={rows} key={row.id}><li>{row.label}</li></for></ul><if test={open}><b>{title}</b></if></main>`;
    const production = generated(source, { reactive: true });
    const development = generated(source, { reactive: true, instrumentBindings: true });

    expect(production).toMatch(/signature: "list:[0-9a-f]{16}",/);
    expect(production).toMatch(/signature: "if:[0-9a-f]{16}",/);
    expect(production).not.toContain(`templateHtml\\"`);
    // The readable structure is still there for the build that carries the rest of the diagnostics.
    expect(development).toContain(`signature: "list:{`);
    expect(development).toContain(`signature: "if:{`);
  });

  it("keeps a region's digest stable for its shape and distinct between shapes", () => {
    const digestsFor = (source: string) =>
      [...generated(source, { reactive: true }).matchAll(/signature: "((?:list|if):[0-9a-f]{16})"/g)].map(
        (match) => match[1],
      );
    const rows = `<ul><for each={rows} key={row.id}><li>{row.label}</li></for></ul>`;

    expect(digestsFor(rows)).toEqual(digestsFor(rows));
    // A different binding inside the row is a different shape.
    expect(digestsFor(rows)).not.toEqual(
      digestsFor(`<ul><for each={rows} key={row.id}><li>{row.title}</li></for></ul>`),
    );
    // So is a different template.
    expect(digestsFor(rows)).not.toEqual(
      digestsFor(`<ul><for each={rows} key={row.id}><b>{row.label}</b></for></ul>`),
    );
  });

  // A ref's cleanup has to clear the object it was written into, not whatever the path resolves to later. A row
  // whose item is replaced under the same key rebinds against a scope that already holds the new item, so a
  // cleanup that re-resolved the path would leave the element on the item it was taken off.
  it("clears a ref from the object it was written into after the row item is replaced", () => {
    const module = evaluateGeneratedClientModule(
      generated(`<ul><for each={rows} key={row.id}><li ref={row.node}></li></for></ul>`, { reactive: true }),
    );
    const root = document.createElement("div");
    const first: { id: number; node?: unknown } = { id: 1 };
    const second: { id: number; node?: unknown } = { id: 1 };
    const rows = createSignal<Array<{ id: number; node?: unknown }>>([first]);

    const handle = mount(root, module, { rows });
    const item = root.querySelector("li");
    expect(first.node).toBe(item);

    rows.set([second]);
    expect(second.node).toBe(item);
    expect(first.node).toBeUndefined();

    handle.dispose();
    expect(second.node).toBeUndefined();
  });

  // The same rule for the container itself: a row that reads `refs` from the parent scope has to clear the
  // `refs` object it wrote into, not the one the parent scope holds by the time the row is torn down.
  it("clears a ref from the container it was written into after the container is replaced", () => {
    const module = evaluateGeneratedClientModule(
      generated(`<ul><for each={rows} key={row.id}><li ref={refs.item}>{row.label}</li></for></ul>`, {
        reactive: true,
      }),
    );
    const root = document.createElement("div");
    const first: { item?: unknown } = {};
    const second: { item?: unknown } = {};
    const scope = createStore<{ rows: Array<{ id: number; label: string }>; refs: { item?: unknown } }>({
      rows: [{ id: 1, label: "A" }],
      refs: first,
    });

    const handle = mount(root, module, scope);
    const item = root.querySelector("li");
    expect(first.item).toBe(item);

    scope.refs = second;
    expect(second.item).toBe(item);
    expect(first.item).toBeUndefined();

    handle.dispose();
    expect(second.item).toBeUndefined();
  });

  // Clearing is still conditional: a ref another writer has already replaced belongs to that writer.
  it("leaves a ref alone on cleanup when something else has replaced it", () => {
    const module = evaluateGeneratedClientModule(generated(`<div ref={refs.panel}></div>`));
    const root = document.createElement("div");
    const refs: { panel?: unknown } = {};

    const handle = mount(root, module, { refs });
    expect(refs.panel).toBe(root.querySelector("div"));

    const other = document.createElement("span");
    refs.panel = other;
    handle.dispose();
    expect(refs.panel).toBe(other);
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
      signature: "list:test",
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
      signature: "if:test",
      templateHtml: `<p> </p>`,
      bindings: [{ kind: "text", path: [0], read: (scope) => scope.message }],
    });
    expect(branch.textContent).toBe("M");

    // The generated entries never compute a signature, so a descriptor that leaves it out is a compile error
    // rather than two descriptors that compare equal at runtime.
    type ListOptions = Parameters<typeof mountGeneratedKeyedList>[3];
    type BranchOptions = Parameters<typeof mountGeneratedConditional>[4];
    // @ts-expect-error a generated list descriptor has to carry its signature
    const listWithoutSignature: ListOptions = { key: "item.id", itemName: "item", templateHtml: "", bindings: [] };
    // @ts-expect-error a generated branch descriptor has to carry its signature
    const branchWithoutSignature: BranchOptions = { templateHtml: "", bindings: [] };
    expect([listWithoutSignature, branchWithoutSignature]).toHaveLength(2);

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
