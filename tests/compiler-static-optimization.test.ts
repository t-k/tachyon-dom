import { describe, expect, it } from "vitest";
import { compileTemplate, generateClientModule, renderServerTemplate } from "../src/compiler";
import {
  analyzeConditionalTest,
  expressionCallsSomething,
  expressionScopeNames,
  removeConstantFalseConditionals,
} from "../src/compiler/optimize";
import { mount } from "../src/runtime/mount";
import { evaluateGeneratedClientModule } from "./generated-client-module";

const compiled = (source: string, options: Parameters<typeof compileTemplate>[1] = {}) => {
  const result = compileTemplate(source, options);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

describe("static template optimization", () => {
  // Compile-time constant, decided once at mount, and changing at run time are three different classes; only
  // the first may be removed.
  it("classifies literal tests as constant and everything else as dynamic", () => {
    for (const [test, value] of [
      ["false", false],
      ["0", false],
      ["null", false],
      [`""`, false],
      ["true", true],
      ["1", true],
      [`"text"`, true],
      ["!false", true],
      ["!!0", false],
    ] as const) {
      expect(analyzeConditionalTest(test)).toEqual({ kind: "constant", value });
    }

    for (const test of [
      "visible",
      "user.visible",
      "check()",
      "!check()",
      "count > 0",
      "a && b",
      "items.length",
      "flag ?? true",
      "!!user",
      "((",
    ]) {
      expect(analyzeConditionalTest(test)).toEqual({ kind: "dynamic" });
    }
  });

  it("removes a constant false branch from the template, the SSR output, and the client module", () => {
    const template = compiled(
      `<main><if test={false}><form><input bind:value={value}></form></if><p>{tail}</p></main>`,
    );

    expect(template.client.templateHtml).toBe(`<main><p> </p></main>`);
    expect(template.client.bindings).toEqual([{ kind: "text", path: [0, 0], expression: "tail" }]);
    expect(renderServerTemplate(template, { tail: "T", value: "V" })).toBe(`<main><p>T</p></main>`);

    const code = generateClientModule(template, { reactive: true });
    expect(code).not.toContain("tachyon-dom/runtime/form");
    expect(code).not.toContain("tachyon-dom/runtime/conditional");
  });

  it("keeps constant true and dynamic branches with their runtime imports", () => {
    for (const test of ["true", "visible"]) {
      const template = compiled(`<main><if test={${test}}><form><input bind:value={value}></form></if></main>`);

      expect(template.client.templateHtml).toBe(`<main><!----></main>`);
      expect(template.client.bindings.map((binding) => binding.kind)).toEqual(["if"]);
      expect(generateClientModule(template, { reactive: true })).toContain("tachyon-dom/runtime/conditional");
    }
  });

  it("renumbers later sibling paths and nested regions after a removal", () => {
    const template = compiled(
      `<main><if test={0}><span>gone</span></if><section><if test={""}><b>gone</b></if><em>{first}</em></section><p>{second}</p></main>`,
    );

    expect(template.client.templateHtml).toBe(`<main><section><em> </em></section><p> </p></main>`);
    expect(template.client.bindings).toEqual([
      { kind: "text", path: [0, 0, 0], expression: "first" },
      { kind: "text", path: [1, 0], expression: "second" },
    ]);

    const module = evaluateGeneratedClientModule(generateClientModule(template));
    const root = document.createElement("div");
    mount(root, module, { first: "F", second: "S" });

    expect(root.querySelector("em")?.textContent).toBe("F");
    expect(root.querySelector("p")?.textContent).toBe("S");
    expect(root.textContent).toBe("FS");
  });

  it("keeps a list intact when a constant false conditional sits inside its rows", () => {
    const template = compiled(
      `<ul><for each={rows} key={row.id}><li><if test={false}><b>gone</b></if>{row.label}</li></for></ul>`,
    );

    expect(renderServerTemplate(template, { rows: [{ id: "a", label: "A" }] })).toBe(`<ul><li>A</li></ul>`);
    const module = evaluateGeneratedClientModule(generateClientModule(template));
    const root = document.createElement("div");
    mount(root, module, {
      rows: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    });

    expect(root.textContent).toBe("AB");
  });

  it("leaves a missing or unparsable test for the compiler to reject", () => {
    expect(compileTemplate(`<main><if><span>x</span></if></main>`).ok).toBe(false);
    expect(compileTemplate(`<main><if test="literal"><span>x</span></if></main>`).ok).toBe(false);
  });

  it("collects the scope names an expression reads", () => {
    expect([...(expressionScopeNames("a") ?? [])]).toEqual(["a"]);
    expect([...(expressionScopeNames("a.b.c") ?? [])]).toEqual(["a"]);
    expect([...(expressionScopeNames("items[index]") ?? [])].sort()).toEqual(["index", "items"]);
    expect([...(expressionScopeNames("lookup(row, offset)") ?? [])].sort()).toEqual(["lookup", "offset", "row"]);
    expect([...(expressionScopeNames("`${a} ${b}`") ?? [])].sort()).toEqual(["a", "b"]);
    expect([...(expressionScopeNames("flag ? yes : no") ?? [])].sort()).toEqual(["flag", "no", "yes"]);
    expect([...(expressionScopeNames("{ x: a, y: b }") ?? [])].sort()).toEqual(["a", "b"]);
    expect([...(expressionScopeNames("[a, b.c]") ?? [])].sort()).toEqual(["a", "b"]);
    expect([...(expressionScopeNames("!a && b > 1") ?? [])].sort()).toEqual(["a", "b"]);
    expect([...(expressionScopeNames("'text'") ?? [])]).toEqual([]);
    expect(expressionScopeNames("((")).toBeUndefined();
  });

  it("recognises expressions that call something", () => {
    for (const expression of ["lookup()", "row.format()", "a + b()", "flag ? f() : 1", "`${f()}`", "[f()]", "(("]) {
      expect(expressionCallsSomething(expression)).toBe(true);
    }
    for (const expression of ["value", "row.label", "a + b", "!flag", "`${a}`", "[a, b]", "{ x: a }"]) {
      expect(expressionCallsSomething(expression)).toBe(false);
    }
  });

  // The bound is only safe if a bounded row scope renders exactly what an unbounded one does. Each case is
  // compared against the same generated module with the bound stripped out.
  const boundedMatchesUnbounded = (source: string, scope: Record<string, unknown>) => {
    const code = generateClientModule(compiled(source), { reactive: true, instrumentBindings: false });
    const render = (moduleCode: string) => {
      const root = document.createElement("div");
      const handle = mount(root, evaluateGeneratedClientModule(moduleCode), scope);
      const text = root.textContent;
      handle.dispose();
      return text;
    };
    return {
      keys: code.match(/parentScopeKeys: .*$/gm) ?? [],
      bounded: render(code),
      unbounded: render(code.replaceAll(/^ *parentScopeKeys: .*\n/gm, "")),
    };
  };

  it("renders a bounded row scope exactly like an unbounded one", () => {
    const cases: Array<[string, string, Record<string, unknown>]> = [
      [
        "plain parent read",
        `<ul><for each={rows} key={row.id}><li>{prefix}{row.label}</li></for></ul>`,
        { prefix: "P", rows: [{ id: "a", label: "A" }] },
      ],
      [
        "nested list item name shadows a parent key of the same name",
        `<ul><for each={rows} key={row.id}><li><b>{group}</b><for each={row.groups} key={group.id}><i>{group.label}</i></for></li></for></ul>`,
        { group: "parent", rows: [{ id: "a", groups: [{ id: "g", label: "child" }] }] },
      ],
      [
        "component prop read from an inner list",
        `<component name="Panel" label={title}><ul><store count={0}/><for each={rows} key={row.id}><li>{label}</li></for></ul></component>`,
        { title: "TITLE", rows: [{ id: "a" }] },
      ],
      [
        "component prop initial reads the parent key it shadows",
        `<ul><for each={rows} key={row.id}><li><component name="Panel" label={label}><b>{label}</b></component></li></for></ul>`,
        { label: "LABEL", rows: [{ id: "a" }] },
      ],
      [
        "row store initial reads a parent key",
        `<ul><for each={rows} key={row.id}><li><store seen={caption}/><b>{seen}</b></li></for></ul>`,
        { caption: "CAPTION", rows: [{ id: "a" }] },
      ],
      [
        "nested conditional inside a row",
        `<ul><for each={rows} key={row.id}><li><b>{row.id}</b><if test={open}><i>{detail}</i></if></li></for></ul>`,
        { open: true, detail: "D", rows: [{ id: "a" }] },
      ],
      [
        "index name shadows a parent key of the same name",
        `<ul><for each={rows} index="position" key={row.id}><li>{position}:{row.id}</li></for></ul>`,
        { position: "PARENT", rows: [{ id: "a" }, { id: "b" }] },
      ],
      [
        "row component store initial reads a parent key",
        `<ul><for each={rows} key={row.id}><li><component name="Row"><b><store seen={caption}/>{seen}</b></component></li></for></ul>`,
        { caption: "CAPTION", rows: [{ id: "a" }] },
      ],
      [
        "conditional inside a row declares its own store",
        `<ul><for each={rows} key={row.id}><li><b>{row.id}</b><if test={open}><store seen={caption}/><i>{seen}</i></if></li></for></ul>`,
        { open: true, caption: "CAPTION", rows: [{ id: "a" }] },
      ],
      [
        "nested list each and key read the enclosing scope",
        `<ul><for each={rows} key={row.id}><li><for each={groups} key={group.id}><i>{gap}{group.label}</i></for></li></for></ul>`,
        { groups: [{ id: "g", label: "G" }], gap: "-", rows: [{ id: "a" }] },
      ],
    ];

    for (const [name, source, scope] of cases) {
      const result = boundedMatchesUnbounded(source, scope);
      expect([name, result.bounded]).toEqual([name, result.unbounded]);
      expect([name, result.keys.length]).toEqual([name, 1]);
    }
  });

  it("names exactly the parent keys the rows reach", () => {
    const keysFor = (source: string) =>
      generateClientModule(compiled(source), { reactive: true, instrumentBindings: false }).match(
        /parentScopeKeys: (\[[^\]]*\])/,
      )?.[1];

    expect(keysFor(`<ul><for each={rows} key={row.id}><li>{row.label}</li></for></ul>`)).toBe(`[]`);
    expect(keysFor(`<ul><for each={rows} key={row.id}><li>{prefix}{row.label}</li></for></ul>`)).toBe(`["prefix"]`);
    // A row store's own key is provided by the row; only its initial expression reaches the parent.
    expect(keysFor(`<ul><for each={rows} key={row.id}><li><store seen={caption}/><b>{seen}</b></li></for></ul>`)).toBe(
      `["caption"]`,
    );
    // A nested list's item name shadows only inside it, so the outer read still names the parent key.
    expect(
      keysFor(
        `<ul><for each={rows} key={row.id}><li><b>{group}</b><for each={row.groups} key={group.id}><i>{group.label}</i></for></li></for></ul>`,
      ),
    ).toBe(`["group"]`);
  });

  // A hydration boundary id is read from the row scope at mount time just like any binding, so the bound has to
  // name the parent keys it reaches. Dropping them left the id unresolved, which silently skipped the boundary
  // and bound its contents eagerly instead of deferring them.
  it("names the parent keys a row's hydration boundary ids reach", () => {
    const keysFor = (source: string) =>
      generateClientModule(compiled(source), { reactive: true, instrumentBindings: false }).match(
        /parentScopeKeys: (\[[^\]]*\])/,
      )?.[1];

    expect(
      keysFor(
        `<ul><for each={rows} key={row.id}><li><button hydrate:id={boundaryId} hydrate:interaction="click" on:click={select}>{row.label}</button></li></for></ul>`,
      ),
    ).toBe(`["boundaryId","select"]`);
    // A row-rooted id is provided by the row itself.
    expect(
      keysFor(
        `<ul><for each={rows} key={row.id}><li><button hydrate:id={row.id} hydrate:interaction="click">{row.label}</button></li></for></ul>`,
      ),
    ).toBe(`[]`);
    // A boundary inside a nested region of the row reaches the same parent scope.
    expect(
      keysFor(
        `<ul><for each={rows} key={row.id}><li><if test={row.on}><section hydrate:id={panelId} hydrate:interaction="click">{row.label}</section></if></li></for></ul>`,
      ),
    ).toBe(`["panelId"]`);
    expect(
      keysFor(
        `<ul><for each={rows} key={row.id}><li><ul><for each={row.groups} key={group.id}><li hydrate:id={groupId} hydrate:interaction="click">{group.label}</li></for></ul></li></for></ul>`,
      ),
    ).toBe(`["groupId"]`);
  });

  it("drops the bound for a row expression that calls something", () => {
    // The callee receives the row scope as `this`, so it can read a parent key the expression never names.
    const result = boundedMatchesUnbounded(`<ul><for each={rows} key={row.id}><li>{lookup()}</li></for></ul>`, {
      prefix: "PREFIX",
      rows: [{ id: "a" }],
      lookup(this: { prefix: string }) {
        return this.prefix;
      },
    });

    expect(result.keys).toEqual([]);
    expect(result.bounded).toBe("PREFIX");
    expect(result.bounded).toBe(result.unbounded);
  });

  it("emits the aliased key a generated reader actually reads", () => {
    const inner = generateClientModule(
      compiled(`<component name="Panel" label={title}><ul><for each={rows} key={row.id}><li>{label}</li></for></ul></component>`),
      { reactive: true, instrumentBindings: false },
    );

    // The reader resolves `label` to the component's declaration key, so the bound has to name that key.
    expect(inner).toMatch(/parentScopeKeys: \["__tachyon_prop_[^"]+"\]/);
    expect(inner).not.toContain(`parentScopeKeys: ["label"]`);
  });

  it("returns the same tree object when nothing is removed", () => {
    const template = compiled(`<main><if test={visible}><span>x</span></if></main>`);
    const optimized = removeConstantFalseConditionals(template.root as never);

    expect(optimized.removedConditionals).toEqual([]);
  });

  it("reports the removed conditionals with their template paths", () => {
    const parsed = compileTemplate(`<main><span></span><if test={visible}></if></main>`);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const root = {
      type: "element" as const,
      tagName: "main",
      attrs: [],
      children: [
        { type: "element" as const, tagName: "span", attrs: [], children: [] },
        { type: "element" as const, tagName: "if", attrs: [{ name: "test", value: "{false}" }], children: [] },
        {
          type: "element" as const,
          tagName: "div",
          attrs: [],
          children: [{ type: "element" as const, tagName: "if", attrs: [{ name: "test", value: "{0}" }], children: [] }],
        },
      ],
    };

    const optimized = removeConstantFalseConditionals(root);

    expect(optimized.removedConditionals).toEqual([
      { path: [1], test: "false" },
      { path: [2, 0], test: "0" },
    ]);
    expect(optimized.root.children.map((child) => (child.type === "element" ? child.tagName : "#text"))).toEqual([
      "span",
      "div",
    ]);
  });
});
