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

    expect(result.ok).toBe(true);
    if (!result.ok) {
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

    expect(result.ok).toBe(true);
    if (!result.ok) {
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
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(
      renderServerTemplate(result.value, {
        selected: true,
        label: `<Save & close>`,
      }),
    ).toBe(`<button class="btn danger" title="&lt;Save &amp; close&gt;">&lt;Save &amp; close&gt;</button>`);
  });

  it("accepts expression syntax in text and braced attributes", () => {
    const result = compileTemplate(
      `<section data-count={count + 1} title={format(label)}><p>{selected ? label : "none"}</p></section>`,
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.value.client.bindings).toEqual([
      { kind: "attr", path: [], name: "data-count", expression: "count + 1" },
      { kind: "attr", path: [], name: "title", expression: "format(label)" },
      { kind: "text", path: [0, 0], expression: `selected ? label : "none"` },
    ]);
    expect(
      renderServerTemplate(result.value, {
        count: 2,
        label: "Ready",
        selected: false,
        format: (value: string) => `Status: ${value}`,
      }),
    ).toBe(`<section data-count="3" title="Status: Ready"><p>none</p></section>`);
  });

  it("extracts attr, style, ref, and form model bindings from client markup", () => {
    const result = compileTemplate(
      `<section data-count={count + 1} style:width={size + "px"} ref={refs.panel}><input bind:value={user.name}></input><label><input bind:checked={user.active}></input>{user.name}</label></section>`,
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.value.client.templateHtml).toBe(`<section><input></input><label><input></input> </label></section>`);
    expect(result.value.client.bindings).toEqual([
      { kind: "attr", path: [], name: "data-count", expression: "count + 1" },
      { kind: "style", path: [], name: "width", expression: `size + "px"` },
      { kind: "ref", path: [], expression: "refs.panel" },
      { kind: "model", path: [0], property: "value", expression: "user.name" },
      { kind: "model", path: [1, 0], property: "checked", expression: "user.active" },
      { kind: "text", path: [1, 1], expression: "user.name" },
    ]);

    const refs: { panel?: Element } = {};
    expect(renderServerTemplate(result.value, { count: 2, size: 10, user: { name: "Ada", active: true }, refs })).toBe(
      `<section data-count="3" style="width:10px"><input></input><label><input></input>Ada</label></section>`,
    );

    const code = generateClientModule(result.value);
    expect(code).toContain(`from "tachyon-dom/runtime/attr"`);
    expect(code).toContain(`from "tachyon-dom/runtime/form"`);
    expect(code).toContain(`setAttributeValue(root, "data-count", (scope.count + 1));`);
    expect(code).toContain(`setStyleValue(root, "width", (scope.size + "px"));`);
    expect(code).toContain(`setRef(scope, "refs.panel", root);`);
    expect(code).toContain(`bindControl(elementAt(root, [0]), "value"`);
    expect(code).toContain(`bindControl(elementAt(root, [1,0]), "checked"`);
  });

  it("generates modular client code that imports only needed runtime helpers", () => {
    const result = compileTemplate(`<button class:danger={selected} on:click={select}>{label}</button>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const code = generateClientModule(result.value);

    expect(code).toContain(`from "tachyon-dom/runtime/text"`);
    expect(code).toContain(`from "tachyon-dom/runtime/class"`);
    expect(code).toContain(`from "tachyon-dom/runtime/event"`);
    expect(code).toContain(`export const templateHtml = "<button> </button>";`);
    expect(code).toContain(`setText(textAt(root, [0]), scope.label);`);
    expect(code).toContain(`setClassPresence(root, "danger", scope.selected);`);
    expect(code).toContain(`cleanups.push(delegate(root, "click", [], scope.select));`);
  });

  it("generates class bindings against nested element paths", () => {
    const result = compileTemplate(`<div><span class:active={selected}>{label}</span></div>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const code = generateClientModule(result.value);

    expect(code).toContain(`import { elementAt, setClassPresence } from "tachyon-dom/runtime/class";`);
    expect(code).toContain(`setClassPresence(elementAt(root, [0]), "active", scope.selected);`);
  });

  it("can generate reactive client bindings with modular signal imports", () => {
    const result = compileTemplate(
      `<section><h1>{title}</h1><ul><for each={rows} key={row.id}><li>{row.label}</li></for></ul></section>`,
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const code = generateClientModule(result.value, { reactive: true });

    expect(code).toContain(`import { effect, read } from "tachyon-dom/runtime/signal";`);
    expect(code).toContain(`const cleanups = [];`);
    expect(code).toContain(`cleanups.push(effect(() => setText(textAt(root, [0,0]), read(scope.title))));`);
    expect(code).toContain(`cleanups.push(effect(() => mountKeyedList(root, [1], read(scope.rows)`);
    expect(code).toContain(`return () => {`);
  });

  it("extracts store tags without adding client DOM nodes", () => {
    const result = compileTemplate(`<section><store count={initialCount}/><button>{count}</button></section>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.value.client.templateHtml).toBe(`<section><button> </button></section>`);
    expect(result.value.client.stores).toEqual([{ name: "count", initial: "initialCount" }]);

    const code = generateClientModule(result.value, { reactive: true });

    expect(code).toContain(`import { createStore } from "tachyon-dom/runtime/store";`);
    expect(code).toContain(`const state = createStore({ ...scope, count: scope.initialCount });`);
    expect(code).toContain(`setText(textAt(root, [0,0]), read(state.count))`);

    const withoutStore = compileTemplate(`<section><button>{count}</button></section>`);
    if (!withoutStore.ok) {
      throw new Error(withoutStore.error.message);
    }
    expect(generateClientModule(withoutStore.value, { reactive: true })).not.toContain(`runtime/store`);
  });

  it("generates a separate server target without client runtime imports", () => {
    const result = compileTemplate(`<button class:danger={selected}>{label}</button>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const code = generateServerModule(result.value);

    expect(code).toContain(`export const render = (scope) =>`);
    expect(code).toContain(`escapeHtml(scope.label)`);
    expect(code).toContain(`scope.selected ? " danger" : ""`);
    expect(code).toContain(`" class=`);
    expect(code).not.toContain(`tachyon-dom/runtime`);
  });

  it("generates server list code that uses loop-local item scope", () => {
    const result = compileTemplate(`<tbody><for each={rows} key={row.id}><tr><td>{row.id}</td></tr></for></tbody>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const code = generateServerModule(result.value);

    expect(code).toContain(`scope.rows.map((row) =>`);
    expect(code).toContain(`escapeHtml(row.id)`);
    expect(code).not.toContain(`escapeHtml(scope.row.id)`);
  });

  it("generates a streaming server target without client runtime imports", () => {
    const result = compileTemplate(`<tbody><for each={rows} key={row.id}><tr><td>{row.id}</td></tr></for></tbody>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const code = generateServerStreamModule(result.value);

    expect(code).toContain(`export const stream = async function* (scope)`);
    expect(code).toContain(`for (const row of scope.rows)`);
    expect(code).toContain(`yield escapeHtml(row.id);`);
    expect(code).not.toContain(`tachyon-dom/runtime`);
  });

  it("records hydrate boundaries and emits server markers", () => {
    const result = compileTemplate(`<main><section hydrate:id={islandId}><button>{label}</button></section></main>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.value.client.hydrationBoundaries).toEqual([{ path: [0], id: "islandId" }]);
    expect(result.value.client.templateHtml).toBe(`<main><section><button> </button></section></main>`);
    expect(renderServerTemplate(result.value, { islandId: "cart", label: "Buy" })).toBe(
      `<main><!--tachyon-hydrate:cart:start--><section><button>Buy</button></section><!--tachyon-hydrate:cart:end--></main>`,
    );

    const code = generateServerStreamModule(result.value);

    expect(code).toContain(`yield "<!--tachyon-hydrate:" + escapeMarker(scope.islandId) + ":start-->";`);
    expect(code).toContain(`yield "<!--tachyon-hydrate:" + escapeMarker(scope.islandId) + ":end-->";`);
  });

  it("extracts keyed list boundaries for client code", () => {
    const result = compileTemplate(
      `<tbody><for each={rows} key={row.id}><tr><td>{row.id}</td><td>{row.label}</td></tr></for></tbody>`,
    );
    if (!result.ok) {
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
    if (!result.ok) {
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
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const code = generateClientModule(result.value);

    expect(code).toContain(`from "tachyon-dom/runtime/list"`);
    expect(code).toContain(`mountKeyedList(root, [], scope.rows`);
    expect(code).toContain(`key: "row.id"`);
    expect(code).toContain(`itemName: "row"`);
  });

  it("fixes the HTML-first syntax surface in an explicit IR", () => {
    const result = compileTemplate(
      `<main><store count={initialCount}/><component name="CounterPanel"><section hydrate:id={islandId}><if test={active}><button on:click={increment}>{count}</button></if><ul><for each={rows} key={row.id}><li>{row.label}</li></for></ul></section></component></main>`,
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.value.ir.directives).toEqual([
      { kind: "store", path: [0], stores: [{ name: "count", initial: "initialCount" }] },
      { kind: "component", path: [1], name: "CounterPanel", props: [], stores: [] },
      { kind: "hydrate", path: [1], id: "islandId" },
      { kind: "if", path: [1, 0], test: "active" },
      { kind: "event", path: [1, 0, 0], eventName: "click", handler: "increment" },
      { kind: "for", path: [1, 1, 0], each: "rows", key: "row.id", itemName: "row" },
    ]);
  });

  it("lowers conditional rendering and transparent component boundaries to client and server targets", () => {
    const result = compileTemplate(
      `<main><component name="Panel"><section><if test={active}><button on:click={increment}>{count}</button></if></section></component></main>`,
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.value.client.templateHtml).toBe(`<main><section><!----></section></main>`);
    expect(result.value.client.bindings).toEqual([
      {
        kind: "if",
        path: [0, 0],
        test: "active",
        templateHtml: "<button> </button>",
        bindings: [
          { kind: "event", path: [], eventName: "click", handler: "increment" },
          { kind: "text", path: [0], expression: "count" },
        ],
      },
    ]);
    expect(renderServerTemplate(result.value, { active: true, count: 3 })).toBe(
      `<main><section><button>3</button></section></main>`,
    );
    expect(renderServerTemplate(result.value, { active: false, count: 3 })).toBe(`<main><section></section></main>`);

    const code = generateClientModule(result.value, { reactive: true });
    expect(code).toContain(`from "tachyon-dom/runtime/conditional"`);
    expect(code).toContain(`mountConditional(root, [0,0], read(scope.active), scope, {`);
  });

  it("rejects unsupported syntax before target generation", () => {
    const cases = [
      [`<ul><for key={row.id}><li>{row.label}</li></for></ul>`, "<for> requires each={items}."],
      [`<ul><for each={rows}><li>{row.label}</li></for></ul>`, "<for> requires key={item.id}."],
      [`<section><if><button>Save</button></if></section>`, "<if> requires test={condition}."],
      [
        `<main><section hydrate:id={islandId}></section><section hydrate:id={islandId}></section></main>`,
        "Duplicate hydrate boundary id expression: islandId.",
      ],
      [`<input bind:value={count + 1}></input>`, "bind:value requires an assignable expression."],
      [
        `<component name="Panel"><h1>One</h1><p>Two</p></component>`,
        "<component> requires exactly one renderable root child.",
      ],
      [`<main><await then="message"><p>{message}</p></await></main>`, "<await> requires value={promise}."],
      [`<main><await value={messagePromise}><p>{message}</p></await></main>`, `<await> requires then="name".`],
    ] as const;

    for (const [source, message] of cases) {
      const result = compileTemplate(source);
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("Expected compiler error.");
      }
      expect(result.error.message).toBe(message);
    }
  });

  it("renders component props and local stores on server targets", () => {
    const result = compileTemplate(
      `<component name="Panel" label={title} initial={initialCount}><section><store count={initial}/><h1>{label}</h1><button>{count}</button><component name="Nested" value={label}><p>{value}</p></component></section></component>`,
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.value.ir.directives).toContainEqual({
      kind: "component",
      path: [],
      name: "Panel",
      props: [
        { name: "label", expression: "title" },
        { name: "initial", expression: "initialCount" },
      ],
      stores: [{ name: "count", initial: "initial" }],
    });
    expect(result.value.client.components).toEqual([
      {
        path: [],
        name: "Panel",
        props: [
          { name: "label", expression: "title" },
          { name: "initial", expression: "initialCount" },
        ],
        stores: [{ name: "count", initial: "initial" }],
      },
      {
        path: [2],
        name: "Nested",
        props: [{ name: "value", expression: "label" }],
        stores: [],
      },
    ]);
    expect(renderServerTemplate(result.value, { title: "Hello", initialCount: 4 })).toBe(
      `<section><h1>Hello</h1><button>4</button><p>Hello</p></section>`,
    );

    const code = generateServerModule(result.value);
    expect(code).toContain(`const label = scope.title;`);
    expect(code).toContain(`const count = initial;`);
    expect(code).toContain(`const value = label;`);

    const clientCode = generateClientModule(result.value);
    expect(clientCode).toContain(`export const componentBoundaries = [{"path":[],"name":"Panel"`);
  });

  it("generates await fragments for the streaming server target", async () => {
    const result = compileTemplate(
      `<main><h1>Before</h1><await value={messagePromise} then="message"><p>{message}</p></await></main>`,
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const code = generateServerStreamModule(result.value);
    expect(code).toContain(`const message = await scope.messagePromise;`);

    const module = (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as {
      stream: (scope: { messagePromise: Promise<string> }) => AsyncIterable<string>;
    };
    const chunks: string[] = [];
    for await (const chunk of module.stream({ messagePromise: Promise.resolve("Ready") })) {
      chunks.push(chunk);
    }
    expect(chunks.join("")).toBe(`<main><h1>Before</h1><p>Ready</p></main>`);
  });

  it("generates hydration state helpers for server modules", () => {
    const result = compileTemplate(`<main><section hydrate:id={islandId}>{label}</section></main>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const code = generateServerModule(result.value);

    expect(code).toContain(`export const hydrationBoundaries = [{"path":[0],"id":"islandId"}];`);
    expect(code).toContain(`export const renderHydrationState = (id, state) =>`);
  });

  it("records await streaming options and emits fallback and error chunks", async () => {
    const result = compileTemplate(
      `<main><await value={messagePromise} then="message" fallback="Loading" error="Failed" reorder="preserve"><p>{message}</p></await></main>`,
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.value.ir.directives).toContainEqual({
      kind: "await",
      path: [0],
      value: "messagePromise",
      thenName: "message",
      fallback: "Loading",
      error: "Failed",
      reorder: "preserve",
    });

    const code = generateServerStreamModule(result.value);
    expect(code).toContain(`yield "Loading";`);
    expect(code).toContain(`} catch {`);
    expect(code).toContain(`yield "Failed";`);

    const module = (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as {
      stream: (scope: { messagePromise: Promise<string> }) => AsyncIterable<string>;
    };
    const successChunks: string[] = [];
    for await (const chunk of module.stream({ messagePromise: Promise.resolve("Ready") })) {
      successChunks.push(chunk);
    }
    expect(successChunks.join("")).toBe(`<main>Loading<p>Ready</p></main>`);

    const errorChunks: string[] = [];
    for await (const chunk of module.stream({ messagePromise: Promise.reject(new Error("Nope")) })) {
      errorChunks.push(chunk);
    }
    expect(errorChunks.join("")).toBe(`<main>LoadingFailed</main>`);
  });
});
