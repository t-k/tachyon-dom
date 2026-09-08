import { afterEach, describe, expect, it, vi } from "vitest";
import { compileTemplate, generateClientModule, renderServerTemplate } from "../src/compiler";
import { mountConditional } from "../src/runtime/conditional";
import { prepareConditionalCore } from "../src/runtime/conditional-core";
import { mountKeyedList } from "../src/runtime/list";
import { hydrate, mount } from "../src/runtime/mount";
import { createSignal } from "../src/runtime/signal";
import { evaluateGeneratedClientModule } from "./generated-client-module";

afterEach(() => {
  vi.restoreAllMocks();
});

// A boundary that hydrates on interaction binds its values only when the interaction arrives. Whatever it
// bound then has to keep following the signals it read, and has to stop again when the branch or row goes
// away. Checking the first paint alone never exercises that contract, so every case here updates a single
// signal after hydration and reads the DOM again.

describe("deferred hydration boundaries keep following their signals", () => {
  it("updates a text binding inside an interaction-hydrated branch when only its signal changes", async () => {
    const compiled = compileTemplate(
      `<main><if test={shown}><section hydrate:id={boundaryId} hydrate:interaction="click"><p>{count}</p><input bind:value={draft}></section></if></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const root = document.createElement("div");
    root.innerHTML = renderServerTemplate(compiled.value, {
      shown: true,
      boundaryId: "panel",
      count: 1,
      draft: "hello",
    });
    const paragraph = root.querySelector("p");
    const input = root.querySelector("input");
    if (!(paragraph instanceof HTMLParagraphElement) || !(input instanceof HTMLInputElement)) {
      throw new Error("Missing SSR nodes.");
    }
    const shown = createSignal(true);
    const count = createSignal(1);
    const draft = createSignal("hello");

    const result = hydrate(root, module, { shown, boundaryId: "panel", count, draft });
    expect(result.ok).toBe(true);
    // Deferred: the branch adopted the SSR nodes without reading count.
    count.set(2);
    expect(paragraph.textContent).toBe("1");

    paragraph.click();
    await Promise.resolve();
    expect(paragraph.textContent).toBe("2");
    expect(input.value).toBe("hello");

    // Only the signal changes: neither the branch test nor the parent scope moves.
    count.set(3);
    expect(paragraph.textContent).toBe("3");
    draft.set("edited");
    expect(input.value).toBe("edited");

    // The form binding was registered once: one user edit writes once.
    input.value = "typed";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(draft()).toBe("typed");

    shown.set(false);
    expect(root.querySelector("section")).toBeNull();
    count.set(4);
    if (result.ok) result.value.dispose();
  });

  it("updates a text binding inside an interaction-hydrated row when only its signal changes", async () => {
    const compiled = compileTemplate(
      `<main><ul><for each={rows} key={row.id}><li><button hydrate:id={row.id} hydrate:interaction="click" on:click={select}>{row.label}:{suffix}</button></li></for></ul></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const root = document.createElement("div");
    const select = vi.fn();
    const rows = [{ id: "a", label: "A" }];
    root.innerHTML = renderServerTemplate(compiled.value, { rows, suffix: "one", select });
    const button = root.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) throw new Error("Missing row button.");
    const suffix = createSignal("one");

    const result = hydrate(root, module, { rows: createSignal(rows), suffix, select });
    expect(result.ok).toBe(true);
    suffix.set("two");
    expect(button.textContent).toBe("A:one");

    button.click();
    await Promise.resolve();
    expect(select).toHaveBeenCalledTimes(1);
    expect(button.textContent).toBe("A:two");

    suffix.set("three");
    expect(button.textContent).toBe("A:three");

    button.click();
    expect(select).toHaveBeenCalledTimes(2);
    if (result.ok) result.value.dispose();
  });
});

describe("hydration ids are evaluated as expressions", () => {
  it("resolves a concatenated row id in a list boundary", async () => {
    const compiled = compileTemplate(
      `<main><ul><for each={rows} key={row.id}><li><button hydrate:id={prefix + row.id} hydrate:interaction="click" on:click={select}>{row.label}</button></li></for></ul></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const root = document.createElement("div");
    const select = vi.fn();
    let labelReads = 0;
    const row = {
      id: "a",
      get label() {
        labelReads++;
        return "A";
      },
    };
    const scope = { rows: [row], prefix: "row-", select };
    root.innerHTML = renderServerTemplate(compiled.value, scope);
    expect(root.innerHTML).toContain("tachyon-hydrate:row-a:start");
    const button = root.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) throw new Error("Missing row button.");

    labelReads = 0;
    const result = hydrate(root, module, scope);
    expect(result.ok).toBe(true);
    // Deferred: the id resolved, so the boundary owns the label read.
    expect(labelReads).toBe(0);

    button.click();
    await Promise.resolve();
    expect(select).toHaveBeenCalledTimes(1);
    expect(labelReads).toBeGreaterThan(0);
    if (result.ok) result.value.dispose();
  });

  it("resolves a concatenated id in a branch boundary", async () => {
    const compiled = compileTemplate(
      `<main><if test={shown}><section hydrate:id={prefix + name} hydrate:interaction="click"><p>{count}</p><input bind:value={draft}></section></if></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const root = document.createElement("div");
    root.innerHTML = renderServerTemplate(compiled.value, {
      shown: true,
      prefix: "panel-",
      name: "main",
      count: 1,
      draft: "",
    });
    expect(root.innerHTML).toContain("tachyon-hydrate:panel-main:start");
    const paragraph = root.querySelector("p");
    if (!(paragraph instanceof HTMLParagraphElement)) throw new Error("Missing SSR paragraph.");
    const count = createSignal(1);

    const result = hydrate(root, module, {
      shown: createSignal(true),
      prefix: "panel-",
      name: "main",
      count,
      draft: createSignal(""),
    });
    expect(result.ok).toBe(true);
    count.set(2);
    expect(paragraph.textContent).toBe("1");

    paragraph.click();
    await Promise.resolve();
    expect(paragraph.textContent).toBe("2");
    if (result.ok) result.value.dispose();
  });
});

describe("hydration ids are compiled into readers", () => {
  it("emits an id reader beside the expression for rows and branches", () => {
    const compiled = compileTemplate(
      `<main><ul><for each={rows} key={row.id}><li><button hydrate:id={prefix + row.id} hydrate:interaction="click" on:click={select}>{row.label}</button></li></for></ul><if test={shown}><section hydrate:id={prefix + name}><p>{count}</p><input bind:value={draft}></section></if></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const code = generateClientModule(compiled.value, { reactive: true });

    expect(code).toContain(`"id":"prefix + row.id","idKind":"expression"`);
    expect(code).toContain(`idRead: (scope) => (scope.prefix + scope.row.id)`);
    expect(code).toContain(`idRead: (scope) => (scope.prefix + scope.name)`);
    // The parent snapshot a row reads has to carry every name the id reads, not only the first path segment.
    expect(code).toMatch(/parentScopeKeys: \[[^\]]*"prefix"[^\]]*\]/);
  });

  it("resolves an aliased component prop inside a row id", async () => {
    const compiled = compileTemplate(
      `<main><ul><for each={rows} key={row.id}><component name="Row" label={row.label}><li><button hydrate:id={"row-" + label} hydrate:interaction="click" on:click={select}>{label}</button></li></component></for></ul></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const root = document.createElement("div");
    const select = vi.fn();
    const scope = { rows: [{ id: "a", label: "A" }], select };
    root.innerHTML = renderServerTemplate(compiled.value, scope);
    expect(root.innerHTML).toContain("tachyon-hydrate:row-A:start");
    const button = root.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) throw new Error("Missing row button.");

    const result = hydrate(root, module, scope);
    expect(result.ok).toBe(true);
    button.click();
    await Promise.resolve();
    expect(select).toHaveBeenCalledTimes(1);
    if (result.ok) result.value.dispose();
  });
});

describe("hand-written descriptors are serialized once per container", () => {
  it("does not serialize an unchanged list descriptor again on update", () => {
    const root = document.createElement("ul");
    const options = {
      key: "row.id",
      itemName: "row",
      templateHtml: `<li> </li>`,
      bindings: [{ kind: "text" as const, path: [0], expression: "row.label" }],
    };
    mountKeyedList(root, [], [{ id: "a", label: "A" }], options);
    expect(root.textContent).toBe("A");

    const stringify = vi.spyOn(JSON, "stringify");
    mountKeyedList(root, [], [{ id: "a", label: "A2" }, { id: "b", label: "B" }], options);
    expect(root.textContent).toBe("A2B");
    expect(stringify).not.toHaveBeenCalled();

    // A different descriptor is still told apart by its serialized form.
    mountKeyedList(root, [], [{ id: "a", label: "A3" }], {
      ...options,
      templateHtml: `<li><b>x</b> </li>`,
      bindings: [{ kind: "text" as const, path: [1], expression: "row.label" }],
    });
    expect(root.textContent).toBe("xA3");
    expect(stringify).toHaveBeenCalled();
  });

  it("does not serialize an unchanged branch descriptor again on update", () => {
    const root = document.createElement("section");
    root.innerHTML = `<!---->`;
    const options = {
      templateHtml: `<p> </p>`,
      bindings: [{ kind: "text" as const, path: [0], expression: "message" }],
    };
    mountConditional(root, [0], true, { message: "M" }, options);
    expect(root.textContent).toBe("M");

    const stringify = vi.spyOn(JSON, "stringify");
    mountConditional(root, [0], true, { message: "M2" }, options);
    expect(root.textContent).toBe("M2");
    expect(stringify).not.toHaveBeenCalled();
  });
});

describe("an id that resolves to nothing while adopting server nodes is an error", () => {
  it("rejects a row boundary whose id is missing instead of binding the row eagerly", () => {
    const compiled = compileTemplate(
      `<main><ul><for each={rows} key={row.id}><li><button hydrate:id={row.boundary} hydrate:interaction="click" on:click={select}>{row.label}</button></li></for></ul></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const root = document.createElement("div");
    const select = vi.fn();
    root.innerHTML = renderServerTemplate(compiled.value, {
      rows: [{ id: "a", label: "A", boundary: "row-a" }],
      select,
    });

    const result = hydrate(root, module, { rows: [{ id: "a", label: "A" }], select });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("hydrate:id={row.boundary} resolved to no value");
  });

  it("rejects a branch boundary whose id is missing instead of binding the branch eagerly", () => {
    const compiled = compileTemplate(
      `<main><if test={shown}><section hydrate:id={boundaryId} hydrate:interaction="click"><p>{count}</p><input bind:value={draft}></section></if></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const root = document.createElement("div");
    root.innerHTML = renderServerTemplate(compiled.value, { shown: true, boundaryId: "panel", count: 1, draft: "" });

    const result = hydrate(root, module, { shown: true, count: 1, draft: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("hydrate:id={boundaryId} resolved to no value");
  });

  it("still binds a client-created branch eagerly when its id is missing", () => {
    const compiled = compileTemplate(
      `<main><if test={shown}><section hydrate:id={boundaryId} hydrate:interaction="click"><p>{count}</p><input bind:value={draft}></section></if></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const root = document.createElement("div");
    const count = createSignal(1);
    const handle = mount(root, module, { shown: true, count, draft: "" });
    expect(root.querySelector("p")?.textContent).toBe("1");
    count.set(2);
    expect(root.querySelector("p")?.textContent).toBe("2");
    handle.dispose();
  });
});

describe("hand-written descriptors still resolve an expression id as a path", () => {
  it("defers a hand-written row boundary whose id is a dotted path", async () => {
    const root = document.createElement("ul");
    root.innerHTML = `<li><!--tachyon-hydrate:row-a:start--><button>A</button><!--tachyon-hydrate:row-a:end--></li>`;
    const button = root.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) throw new Error("Missing SSR button.");
    const select = vi.fn();
    let labelReads = 0;
    const row = {
      id: "a",
      marker: { id: "row-a" },
      get label() {
        labelReads++;
        return "A";
      },
    };
    mountKeyedList(root, [], [row], {
      key: "row.id",
      itemName: "row",
      templateHtml: `<li><button> </button></li>`,
      bindings: [
        { kind: "text", path: [0, 0], expression: "row.label" },
        { kind: "event", path: [0], eventName: "click", handler: "select" },
      ],
      hydrationBoundaries: [{ path: [0], id: "row.marker.id", idKind: "expression", strategy: "interaction" }],
      scope: { select },
    });
    expect(labelReads).toBe(0);

    button.click();
    await Promise.resolve();
    expect(select).toHaveBeenCalledTimes(1);
    expect(labelReads).toBeGreaterThan(0);
  });

  it("defers a hand-written branch boundary whose id is a dotted path", async () => {
    const root = document.createElement("main");
    root.innerHTML = `<!--tachyon-hydrate:panel:start--><section><p>1</p></section><!--tachyon-hydrate:panel:end-->`;
    const paragraph = root.querySelector("p");
    if (!(paragraph instanceof HTMLParagraphElement)) throw new Error("Missing SSR paragraph.");
    // The branch snapshots its scope on mount, so the read count cannot tell deferral apart; the DOM can.
    const scope = { marker: { id: "panel" }, count: 2 };
    prepareConditionalCore(root, [{ path: [0], visible: true, templateHtml: `<section><p> </p></section>` }]);
    mountConditional(root, [0], true, scope, {
      templateHtml: `<section><p> </p></section>`,
      bindings: [{ kind: "text", path: [0, 0], expression: "count" }],
      hydrationBoundaries: [{ path: [], id: "marker.id", idKind: "expression", strategy: "interaction" }],
    });
    expect(root.querySelector("p")).toBe(paragraph);
    expect(paragraph.textContent).toBe("1");

    paragraph.click();
    await Promise.resolve();
    expect(paragraph.textContent).toBe("2");
  });
});

describe("a null id is treated like a missing one", () => {
  it("rejects a branch whose id resolves to null while adopting server nodes", () => {
    const compiled = compileTemplate(
      `<main><if test={shown}><section hydrate:id={boundaryId} hydrate:interaction="click"><p>{count}</p><input bind:value={draft}></section></if></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const root = document.createElement("div");
    root.innerHTML = renderServerTemplate(compiled.value, { shown: true, boundaryId: "panel", count: 1, draft: "" });

    const result = hydrate(root, module, { shown: true, boundaryId: null, count: 1, draft: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("resolved to no value");
  });

  it("rejects a row whose id resolves to null while adopting server rows", () => {
    const compiled = compileTemplate(
      `<main><ul><for each={rows} key={row.id}><li><button hydrate:id={row.boundary} hydrate:interaction="click" on:click={select}>{row.label}</button></li></for></ul></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const root = document.createElement("div");
    const select = vi.fn();
    root.innerHTML = renderServerTemplate(compiled.value, { rows: [{ id: "a", label: "A", boundary: "row-a" }], select });

    const result = hydrate(root, module, { rows: [{ id: "a", label: "A", boundary: null }], select });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("resolved to no value");
  });
});
