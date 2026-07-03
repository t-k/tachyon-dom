import { describe, expect, it } from "vitest";
import {
  compileTemplate,
  generateClientModule,
  generateServerModule,
  generateServerStreamModule,
  renderServerTemplate,
} from "../src/compiler";
import { setText, textAt } from "../src/runtime/text";

const mountClientTextBindings = (
  templateHtml: string,
  bindings: Array<{ kind: string; path: number[] }>,
  scope: Record<string, unknown>,
): HTMLElement => {
  document.body.innerHTML = templateHtml;
  const root = document.body.firstElementChild;
  if (!(root instanceof HTMLElement)) {
    throw new Error("Missing mounted root.");
  }
  for (const binding of bindings) {
    if (binding.kind === "text") {
      const expression = "expression" in binding && typeof binding.expression === "string" ? binding.expression : "";
      setText(textAt(root, binding.path), scope[expression]);
    }
  }
  return root;
};

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

  it("preserves static text around client text bindings after mounting", () => {
    const result = compileTemplate(`<p>Hello {name}!</p>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const root = mountClientTextBindings(result.value.client.templateHtml, result.value.client.bindings, {
      name: "World",
    });

    expect(root.textContent).toBe("Hello World!");
  });

  it("keeps multiple expressions in one text node independent after client mounting", () => {
    const result = compileTemplate(`<p>{a} and {b}</p>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const root = mountClientTextBindings(result.value.client.templateHtml, result.value.client.bindings, {
      a: "x",
      b: "y",
    });

    expect(root.textContent).toBe("x and y");
  });

  it("matches SSR text node layout to client bindings for mixed text", () => {
    const result = compileTemplate(`<section><p>Hello {name}!</p><span>{a} {b}</span></section>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const html = renderServerTemplate(result.value, { name: "World", a: "x", b: "y" });
    document.body.innerHTML = html;
    const root = document.body.firstElementChild;
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing SSR root.");
    }

    expect(html).toBe(`<section><p>Hello <!---->World<!---->!</p><span>x<!----> <!---->y</span></section>`);
    for (const binding of result.value.client.bindings) {
      if (binding.kind === "text") {
        expect(textAt(root, binding.path)).toBeInstanceOf(Text);
      }
    }
    expect(generateServerModule(result.value)).toContain(`"<!---->"`);
    expect(generateServerStreamModule(result.value)).toContain(`__tachyonPush("<!---->");`);
  });

  it("omits closing tags for void elements in client and server targets", () => {
    const result = compileTemplate(`<div><br/>{label}<hr/></div>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.value.client.templateHtml).toBe(`<div><br> <hr></div>`);
    expect(renderServerTemplate(result.value, { label: "Ready" })).toBe(`<div><br>Ready<hr></div>`);
    expect(generateServerStreamModule(result.value)).not.toContain(`</hr>`);
  });

  it("accepts bare void elements and drops HTML comments without shifting bindings", () => {
    const result = compileTemplate(`<div><!-- note --><br><input type="text"><param name="movie">{label}</div>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.value.client.templateHtml).toBe(`<div><br><input type="text"><param name="movie"> </div>`);
    expect(result.value.client.bindings).toEqual([{ kind: "text", path: [3], expression: "label" }]);
    expect(renderServerTemplate(result.value, { label: "Ready" })).toBe(
      `<div><br><input type="text"><param name="movie">Ready</div>`,
    );
    expect(generateServerModule(result.value)).not.toContain(`</param>`);
    expect(generateServerStreamModule(result.value)).not.toContain(`</param>`);
  });

  it("escapes quoted static attributes in generated markup", () => {
    const result = compileTemplate(`<button title='say "hi"' data-note="rock & roll">Save</button>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.value.client.templateHtml).toBe(
      `<button title="say &quot;hi&quot;" data-note="rock &amp; roll">Save</button>`,
    );
    expect(renderServerTemplate(result.value, {})).toBe(
      `<button title="say &quot;hi&quot;" data-note="rock &amp; roll">Save</button>`,
    );
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

    expect(result.value.client.templateHtml).toBe(`<section><input><label><input> </label></section>`);
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
      `<section data-count="3" style="width:10px"><input><label><input>Ada</label></section>`,
    );

    const code = generateClientModule(result.value);
    expect(code).toContain(`from "tachyon-dom/runtime/attr"`);
    expect(code).toContain(`from "tachyon-dom/runtime/form"`);
    expect(code).toContain(`__tachyonSetAttributeValue(root, "data-count", (scope.count + 1));`);
    expect(code).toContain(`__tachyonSetStyleValue(root, "width", (scope.size + "px"));`);
    expect(code).toContain(`__tachyonSetRef(scope, "refs.panel", root);`);
    expect(code).toContain(`__tachyonBindControl(__tachyonElementAt(root, [0]), "value"`);
    expect(code).toContain(`__tachyonBindControl(__tachyonElementAt(root, [1,0]), "checked"`);
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
    expect(code).toContain(`__tachyonSetText(__tachyonTextAt(root, [0]), scope.label);`);
    expect(code).toContain(`__tachyonSetClassPresence(root, "danger", scope.selected);`);
    expect(code).toContain(`cleanups.push(__tachyonDelegate(root, "click", [], scope.select));`);
  });

  it("generates class bindings against nested element paths", () => {
    const result = compileTemplate(`<div><span class:active={selected}>{label}</span></div>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const code = generateClientModule(result.value);

    expect(code).toContain(
      `import { elementAt as __tachyonElementAt, setClassPresence as __tachyonSetClassPresence } from "tachyon-dom/runtime/class";`,
    );
    expect(code).toContain(`__tachyonSetClassPresence(__tachyonElementAt(root, [0]), "active", scope.selected);`);
  });

  it("can generate reactive client bindings with modular signal imports", () => {
    const result = compileTemplate(
      `<section><h1>{title}</h1><ul><for each={rows} key={row.id}><li>{row.label}</li></for></ul></section>`,
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const code = generateClientModule(result.value, { reactive: true });

    expect(code).toContain(
      `import { effect as __tachyonEffect, read as __tachyonRead } from "tachyon-dom/runtime/signal";`,
    );
    expect(code).toContain(`const cleanups = [];`);
    expect(code).toContain(`const __tachyonTarget0 = __tachyonTextAt(root, [0,0]);`);
    expect(code).toContain(
      `cleanups.push(__tachyonEffect(() => __tachyonSetText(__tachyonTarget0, __tachyonRead(scope.title))));`,
    );
    expect(code).toContain(
      `cleanups.push(__tachyonEffect(() => __tachyonMountKeyedList(root, [1], __tachyonRead(scope.rows)`,
    );
    expect(code).toContain(`return () => {`);
  });

  it("keeps nested client control-flow bindings instead of dropping them", () => {
    const result = compileTemplate(
      `<section><if test={visible}><ul><for each={groups} key={group.id}><li>{group.name}<ul><for each={group.items} key={item.id}><li>{item.label}</li></for></ul></li></for></ul><if test={showNote}><p>{note}</p></if></if></section>`,
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const [outer] = result.value.client.bindings;
    expect(outer?.kind).toBe("if");
    if (outer?.kind !== "if") {
      throw new Error("Missing outer conditional binding.");
    }
    expect(outer.bindings.map((binding) => binding.kind)).toEqual(["list", "if"]);
    const [list] = outer.bindings;
    expect(list?.kind).toBe("list");
    if (list?.kind !== "list") {
      throw new Error("Missing nested list binding.");
    }
    expect(list.bindings.some((binding) => binding.kind === "list")).toBe(true);

    const code = generateClientModule(result.value);
    expect(code).toContain(`kind: "list"`);
    expect(code).toContain(`kind: "if"`);
    expect(code).toContain(`signature: "list:`);
    expect(code).toContain(`signature: "if:`);
  });

  it("hoists reactive binding node lookups outside effect bodies", () => {
    const result = compileTemplate(
      `<section><h1>{title}</h1><button class:active={active} title={title} style:width={width} bind:value={title}></button></section>`,
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const code = generateClientModule(result.value, { reactive: true });

    expect(code).toContain(`const __tachyonTarget0 = __tachyonTextAt(root, [0,0]);`);
    expect(code).toContain(`cleanups.push(__tachyonEffect(() => __tachyonSetText(__tachyonTarget0`);
    expect(code).not.toContain(`__tachyonEffect(() => __tachyonSetText(__tachyonTextAt(root`);
    expect(code).not.toContain(`__tachyonEffect(() => __tachyonSetClassPresence(__tachyonElementAt(root`);
    expect(code).not.toContain(`__tachyonEffect(() => __tachyonSetAttributeValue(__tachyonElementAt(root`);
    expect(code).not.toContain(`__tachyonEffect(() => __tachyonSetStyleValue(__tachyonElementAt(root`);
    expect(code).not.toContain(`__tachyonEffect(() => __tachyonSetControlValue(__tachyonElementAt(root`);
  });

  it("extracts store tags without adding client DOM nodes", () => {
    const result = compileTemplate(`<section><store count={initialCount}/><button>{count}</button></section>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.value.client.templateHtml).toBe(`<section><button> </button></section>`);
    expect(result.value.client.stores).toEqual([{ name: "count", initial: "initialCount" }]);

    const code = generateClientModule(result.value, { reactive: true });

    expect(code).toContain(`import { createStore as __tachyonCreateStore } from "tachyon-dom/runtime/store";`);
    expect(code).toContain(`const state = __tachyonCreateStore({ ...scope, count: scope.initialCount });`);
    expect(code).toContain(`const __tachyonTarget0 = __tachyonTextAt(root, [0,0]);`);
    expect(code).toContain(`__tachyonSetText(__tachyonTarget0, __tachyonRead(state.count))`);

    const withoutStore = compileTemplate(`<section><button>{count}</button></section>`);
    if (!withoutStore.ok) {
      throw new Error(withoutStore.error.message);
    }
    expect(generateClientModule(withoutStore.value, { reactive: true })).not.toContain(`runtime/store`);
  });

  it("hoists conditional options and emits compiled binding readers", () => {
    const result = compileTemplate(`<section><if test={active}><button title={label}>{label}</button></if></section>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const code = generateClientModule(result.value, { reactive: true });

    expect(code).toContain(`const conditionalOptions0 = {`);
    expect(code).toContain(`signature: "if:`);
    expect(code).toContain(`read: (scope) => scope.label`);
    expect(code).toContain(
      `cleanups.push(__tachyonEffect(() => __tachyonMountConditional(root, [0], __tachyonRead(scope.active), scope, conditionalOptions0)));`,
    );
    expect(code).not.toContain(`__tachyonMountConditional(root, [0], __tachyonRead(scope.active), scope, {`);
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

  it("generates single-pass HTML escaping helpers for server targets", () => {
    const result = compileTemplate(`<p>{label}</p>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const serverCode = generateServerModule(result.value);
    const streamCode = generateServerStreamModule(result.value);

    expect(serverCode).toContain(`replace(/[&<>"']/g`);
    expect(streamCode).toContain(`replace(/[&<>"']/g`);
    expect(serverCode).not.toContain(`replaceAll("&", "&amp;").replaceAll("<", "&lt;")`);
    expect(streamCode).not.toContain(`replaceAll("&", "&amp;").replaceAll("<", "&lt;")`);
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
    expect(code).toContain(`__tachyonPush(escapeHtml(row.id));`);
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

    expect(code).toContain(`__tachyonPush("<!--tachyon-hydrate:" + escapeMarker(scope.islandId) + ":start-->");`);
    expect(code).toContain(`__tachyonPush("<!--tachyon-hydrate:" + escapeMarker(scope.islandId) + ":end-->");`);
  });

  it("generates stable hydrate ids and records shorthand hydration strategies", () => {
    const result = compileTemplate(
      `<main><section hydrate><button>{label}</button></section><aside hydrate:visible="128px">{summary}</aside><footer hydrate:interaction="pointerenter">{status}</footer></main>`,
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.value.client.templateHtml).toBe(
      `<main><section><button> </button></section><aside> </aside><footer> </footer></main>`,
    );
    expect(result.value.client.hydrationBoundaries).toEqual([
      { path: [0], id: "td-h-0", idKind: "static" },
      { path: [1], id: "td-h-1", idKind: "static", strategy: "visible", rootMargin: "128px" },
      { path: [2], id: "td-h-2", idKind: "static", strategy: "interaction", interaction: "pointerenter" },
    ]);
    expect(result.value.ir.directives).toContainEqual({
      kind: "hydrate",
      path: [1],
      id: "td-h-1",
      idKind: "static",
      strategy: "visible",
      rootMargin: "128px",
    });
    expect(renderServerTemplate(result.value, { label: "Buy", summary: "Ready", status: "Idle" })).toBe(
      `<main><!--tachyon-hydrate:td-h-0:start--><section><button>Buy</button></section><!--tachyon-hydrate:td-h-0:end--><!--tachyon-hydrate:td-h-1:start--><aside>Ready</aside><!--tachyon-hydrate:td-h-1:end--><!--tachyon-hydrate:td-h-2:start--><footer>Idle</footer><!--tachyon-hydrate:td-h-2:end--></main>`,
    );

    const code = generateServerStreamModule(result.value);
    expect(code).toContain(`escapeMarker("td-h-0")`);
    expect(code).toContain(`escapeMarker("td-h-1")`);
    expect(code).toContain(`escapeMarker("td-h-2")`);
  });

  it("renders outlet and named slots on server targets", () => {
    const result = compileTemplate(`<main><header><slot name="header"></slot></header><outlet></outlet></main>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.value.client.templateHtml).toBe(
      `<main><header><!--tachyon-slot:header--></header><!--tachyon-outlet--></main>`,
    );
    expect(
      renderServerTemplate(result.value, {
        outlet: `<section>Child</section>`,
        slots: { header: `<h1>Title</h1>` },
      }),
    ).toBe(`<main><header><h1>Title</h1></header><section>Child</section></main>`);

    const serverCode = generateServerModule(result.value);
    expect(serverCode).toContain(`String(scope.slots?.header ?? "")`);
    expect(serverCode).toContain(`String(scope.outlet ?? "")`);

    const streamCode = generateServerStreamModule(result.value);
    expect(streamCode).toContain(`__tachyonPush(String(scope.slots?.header ?? ""));`);
    expect(streamCode).toContain(`__tachyonPush(String(scope.outlet ?? ""));`);
  });

  it("generates bracket slot access for non-identifier slot names", () => {
    const result = compileTemplate(`<main><slot name="header-title"></slot></main>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(renderServerTemplate(result.value, { slots: { "header-title": "<h1>Title</h1>" } })).toBe(
      `<main><h1>Title</h1></main>`,
    );
    expect(generateServerModule(result.value)).toContain(`String(scope.slots?.["header-title"] ?? "")`);
    expect(generateServerStreamModule(result.value)).toContain(
      `__tachyonPush(String(scope.slots?.["header-title"] ?? ""));`,
    );
  });

  it("rejects component prop and store names that cannot become local bindings", () => {
    const propResult = compileTemplate(`<component name="Panel" data-x={value}><section>{value}</section></component>`);
    expect(propResult.ok).toBe(false);
    expect(propResult.ok ? "" : propResult.error.message).toBe("Invalid component prop binding name: data-x.");

    const storeResult = compileTemplate(`<main><store data-x={value}/><span>{value}</span></main>`);
    expect(storeResult.ok).toBe(false);
    expect(storeResult.ok ? "" : storeResult.error.message).toBe("Invalid store binding name: data-x.");
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
    expect(code).toContain(`__tachyonMountKeyedList(root, [], scope.rows`);
    expect(code).toContain(`key: "row.id"`);
    expect(code).toContain(`itemName: "row"`);
  });

  it("generates compiled list binding readers instead of runtime dot parsing", () => {
    const result = compileTemplate(
      `<ul><for each={rows} key={row.ids[0]}><li>{row.profile?.name ?? row.name}</li></for></ul>`,
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const code = generateClientModule(result.value);

    expect(code).toContain(`const listOptions0 = {`);
    expect(code).toContain(`keyRead: (scope) => scope.row.ids[0]`);
    expect(code).toContain(`read: (scope) => (scope.row.profile?.name ?? scope.row.name)`);
    expect(code).toContain(`__tachyonMountKeyedList(root, [], scope.rows, listOptions0)`);
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
    expect(code).toContain(`const conditionalOptions0 = {`);
    expect(code).toContain(
      `__tachyonMountConditional(root, [0,0], __tachyonRead(scope.active), scope, conditionalOptions0)`,
    );
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
    expect(code).toContain(`__tachyonPush("Loading");`);
    expect(code).toContain(`} catch {`);
    expect(code).toContain(`__tachyonPush("Failed");`);

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
