import { describe, expect, it } from "vitest";
import {
  compileTemplate,
  generateClientModule,
  generateServerModule,
  generateServerStreamModule,
  renderServerTemplate,
} from "../src/compiler";

describe("HTML-first compiler", () => {
  it("extracts text bindings while keeping a static client template", () => {
    const result = compileTemplate(`<tr><td>{row.id}</td><td><a>{row.label}</a></td></tr>`);

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      throw new Error(result.error.message);
    }

    expect(result.value.client.templateHtml).toBe("<tr><td> </td><td><a> </a></td></tr>");
    expect(result.value.client.bindings).toEqual([
      { kind: "text", path: [0, 0], expression: "row.id" },
      { kind: "text", path: [1, 0, 0], expression: "row.label" },
    ]);
  });

  it("separates class and event directives from static markup", () => {
    const result = compileTemplate(`<button class="btn" class:danger={selected} on:click={select}>{label}</button>`);

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      throw new Error(result.error.message);
    }

    expect(result.value.client.templateHtml).toBe(`<button class="btn"> </button>`);
    expect(result.value.client.bindings).toEqual([
      { kind: "class", path: [], className: "danger", expression: "selected" },
      { kind: "event", path: [], eventName: "click", handler: "select" },
      { kind: "text", path: [0], expression: "label" },
    ]);
  });

  it("renders an escaped server string with static and dynamic classes", () => {
    const result = compileTemplate(`<button class="btn" class:danger={selected} title={label}>{label}</button>`);
    if (result.isErr()) {
      throw new Error(result.error.message);
    }

    expect(
      renderServerTemplate(result.value, {
        selected: true,
        label: `<Save & close>`,
      }),
    ).toBe(`<button class="btn danger" title="&lt;Save &amp; close&gt;">&lt;Save &amp; close&gt;</button>`);
  });

  it("generates modular client code that imports only needed runtime helpers", () => {
    const result = compileTemplate(`<button class:danger={selected} on:click={select}>{label}</button>`);
    if (result.isErr()) {
      throw new Error(result.error.message);
    }

    const code = generateClientModule(result.value);

    expect(code).toContain(`from "@local/tachyon-dom/runtime/text"`);
    expect(code).toContain(`from "@local/tachyon-dom/runtime/class"`);
    expect(code).toContain(`from "@local/tachyon-dom/runtime/event"`);
    expect(code).toContain(`export const templateHtml = "<button> </button>";`);
    expect(code).toContain(`setText(textAt(root, [0]), scope.label);`);
    expect(code).toContain(`setClassPresence(root, "danger", scope.selected);`);
    expect(code).toContain(`cleanups.push(delegate(root, "click", [], scope.select));`);
  });

  it("generates class bindings against nested element paths", () => {
    const result = compileTemplate(`<div><span class:active={selected}>{label}</span></div>`);
    if (result.isErr()) {
      throw new Error(result.error.message);
    }

    const code = generateClientModule(result.value);

    expect(code).toContain(`import { elementAt, setClassPresence } from "@local/tachyon-dom/runtime/class";`);
    expect(code).toContain(`setClassPresence(elementAt(root, [0]), "active", scope.selected);`);
  });

  it("can generate reactive client bindings with modular signal imports", () => {
    const result = compileTemplate(
      `<section><h1>{title}</h1><ul><for each={rows} key={row.id}><li>{row.label}</li></for></ul></section>`,
    );
    if (result.isErr()) {
      throw new Error(result.error.message);
    }

    const code = generateClientModule(result.value, { reactive: true });

    expect(code).toContain(`import { effect, read } from "@local/tachyon-dom/runtime/signal";`);
    expect(code).toContain(`const cleanups = [];`);
    expect(code).toContain(`cleanups.push(effect(() => setText(textAt(root, [0,0]), read(scope.title))));`);
    expect(code).toContain(`cleanups.push(effect(() => mountKeyedList(root, [1], read(scope.rows)`);
    expect(code).toContain(`return () => {`);
  });

  it("generates a separate server target without client runtime imports", () => {
    const result = compileTemplate(`<button class:danger={selected}>{label}</button>`);
    if (result.isErr()) {
      throw new Error(result.error.message);
    }

    const code = generateServerModule(result.value);

    expect(code).toContain(`export const render = (scope) =>`);
    expect(code).toContain(`escapeHtml(scope.label)`);
    expect(code).toContain(`scope.selected ? " danger" : ""`);
    expect(code).toContain(`" class=`);
    expect(code).not.toContain(`@local/tachyon-dom/runtime`);
  });

  it("generates server list code that uses loop-local item scope", () => {
    const result = compileTemplate(`<tbody><for each={rows} key={row.id}><tr><td>{row.id}</td></tr></for></tbody>`);
    if (result.isErr()) {
      throw new Error(result.error.message);
    }

    const code = generateServerModule(result.value);

    expect(code).toContain(`scope.rows.map((row) =>`);
    expect(code).toContain(`escapeHtml(row.id)`);
    expect(code).not.toContain(`escapeHtml(scope.row.id)`);
  });

  it("generates a streaming server target without client runtime imports", () => {
    const result = compileTemplate(`<tbody><for each={rows} key={row.id}><tr><td>{row.id}</td></tr></for></tbody>`);
    if (result.isErr()) {
      throw new Error(result.error.message);
    }

    const code = generateServerStreamModule(result.value);

    expect(code).toContain(`export const stream = function* (scope)`);
    expect(code).toContain(`for (const row of scope.rows)`);
    expect(code).toContain(`yield escapeHtml(row.id);`);
    expect(code).not.toContain(`@local/tachyon-dom/runtime`);
  });

  it("extracts keyed list boundaries for client code", () => {
    const result = compileTemplate(
      `<tbody><for each={rows} key={row.id}><tr><td>{row.id}</td><td>{row.label}</td></tr></for></tbody>`,
    );
    if (result.isErr()) {
      throw new Error(result.error.message);
    }

    expect(result.value.client.templateHtml).toBe("<tbody></tbody>");
    expect(result.value.client.bindings).toEqual([
      {
        kind: "list",
        path: [],
        each: "rows",
        itemName: "row",
        key: "row.id",
        templateHtml: "<tr><td> </td><td> </td></tr>",
        bindings: [
          { kind: "text", path: [0, 0], expression: "row.id" },
          { kind: "text", path: [1, 0], expression: "row.label" },
        ],
      },
    ]);
  });

  it("renders keyed lists on the server", () => {
    const result = compileTemplate(
      `<tbody><for each={rows} key={row.id}><tr class:danger={row.selected}><td>{row.id}</td><td>{row.label}</td></tr></for></tbody>`,
    );
    if (result.isErr()) {
      throw new Error(result.error.message);
    }

    expect(
      renderServerTemplate(result.value, {
        rows: [
          { id: 1, label: "One", selected: false },
          { id: 2, label: "<Two>", selected: true },
        ],
      }),
    ).toBe(`<tbody><tr><td>1</td><td>One</td></tr><tr class="danger"><td>2</td><td>&lt;Two&gt;</td></tr></tbody>`);
  });

  it("keeps list runtime imports modular", () => {
    const result = compileTemplate(`<tbody><for each={rows} key={row.id}><tr><td>{row.id}</td></tr></for></tbody>`);
    if (result.isErr()) {
      throw new Error(result.error.message);
    }

    const code = generateClientModule(result.value);

    expect(code).toContain(`from "@local/tachyon-dom/runtime/list"`);
    expect(code).toContain(`mountKeyedList(root, [], scope.rows`);
    expect(code).toContain(`key: "row.id"`);
    expect(code).toContain(`itemName: "row"`);
  });
});
