import { describe, expect, it } from "vitest";
import { compileTemplate, generateClientModule, renderServerTemplate } from "../src/compiler";
import {
  analyzeConditionalTest,
  expressionScopeNames,
  listParentScopeNames,
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

  it("bounds a list's parent scope to what its rows can read", () => {
    const parentScopeKeys = (source: string) => {
      const binding = compiled(source).client.bindings.find((candidate) => candidate.kind === "list");
      if (!binding || binding.kind !== "list") throw new Error("Missing list binding.");
      const names = listParentScopeNames(binding);
      return names === undefined ? undefined : [...names].sort();
    };

    expect(parentScopeKeys(`<ul><for each={rows} key={row.id}><li>{row.label}</li></for></ul>`)).toEqual([]);
    expect(
      parentScopeKeys(`<ul><for each={rows} key={row.id}><li>{prefix}<b on:click={select}>x</b></li></for></ul>`),
    ).toEqual(["prefix", "select"]);
    expect(parentScopeKeys(`<ul><for each={rows} key={row.id}><li>{lookup(row)}</li></for></ul>`)).toEqual(["lookup"]);
    expect(
      parentScopeKeys(`<ul><for each={rows} key={row.id}><li><if test={open}>{detail}</if></li></for></ul>`),
    ).toEqual(["detail", "open"]);
    // The item name shadows a parent key of the same name, so it never reaches the parent.
    expect(parentScopeKeys(`<ul><for each={rows} as="prefix" key={prefix.id}><li>{prefix.label}</li></for></ul>`))
      .toEqual([]);
    // A nested list's own item and index names shadow too, while its each and key stay parent reads.
    expect(
      parentScopeKeys(
        `<ul><for each={rows} key={row.id}><li><for each={groups} key={group.id}><span>{group.name}{gap}</span></for></li></for></ul>`,
      ),
    ).toEqual(["gap", "groups"]);
    expect(
      parentScopeKeys(`<ul><for each={rows} index="position" key={row.id}><li>{position}{row.label}</li></for></ul>`),
    ).toEqual([]);
  });

  it("emits the bounded parent scope keys in the generated list options", () => {
    const code = generateClientModule(
      compiled(`<ul><for each={rows} key={row.id}><li>{prefix}{row.label}</li></for></ul>`),
      { reactive: true },
    );

    expect(code).toContain(`parentScopeKeys: ["prefix"],`);
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
