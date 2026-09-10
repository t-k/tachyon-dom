// @vitest-environment jsdom
// Regressions found by the clean-context review of the region-marker and reactivity changes.
import { describe, expect, it } from "vitest";
import { compileTemplate, explainCompiledTemplate, generateClientModule, renderServerTemplate } from "../src/compiler";
import { hydrate, mount } from "../src/runtime/mount";
import { batch, createMemo, createSignal } from "../src/runtime/signal";
import { evaluateGeneratedClientModule } from "./generated-client-module";

const compile = (template: string) => {
  const compiled = compileTemplate(template);
  if (!compiled.ok) throw new Error(compiled.error.message);
  return compiled.value;
};

const moduleFor = (template: string) =>
  evaluateGeneratedClientModule(generateClientModule(compile(template), { reactive: true, instrumentBindings: false }));

const strip = (html: string): string => html.replace(/<!--[^>]*-->/g, "");

describe("hydration after <await>", () => {
  const template = `<section><await value={data} then="v"><p>{v}</p><p>x</p></await><h1>{title}</h1></section>`;

  it("rejects hydration of a template with <await> instead of binding later siblings to the wrong node", () => {
    const root = document.createElement("div");
    root.innerHTML = renderServerTemplate(compile(template), { data: "D", title: "T" });
    const result = hydrate(root, moduleFor(template), { title: "T2" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/<await>/);
    expect(root.innerHTML).toBe(`<section><p>D</p><p>x</p><h1>T</h1></section>`);
  });

  it("still mounts the template on the client with the later sibling bound", () => {
    const root = document.createElement("div");
    const title = createSignal("T2");
    mount(root, moduleFor(template), { title });
    expect(strip(root.innerHTML)).toBe(`<section><h1>T2</h1></section>`);
    title.set("T3");
    expect(strip(root.innerHTML)).toBe(`<section><h1>T3</h1></section>`);
  });
});

describe("<for> as the direct child of <if>", () => {
  const template = `<ul><if test={open}><for each={rows} key={row.id}><li>{row.label}</li></for></if></ul>`;
  const rows = [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ];

  it("mounts the rows", () => {
    const root = document.createElement("div");
    const open = createSignal(true);
    mount(root, moduleFor(template), { open, rows });
    expect(strip(root.innerHTML)).toBe(`<ul><li>A</li><li>B</li></ul>`);
    open.set(false);
    expect(strip(root.innerHTML)).toBe(`<ul></ul>`);
    open.set(true);
    expect(strip(root.innerHTML)).toBe(`<ul><li>A</li><li>B</li></ul>`);
  });

  it("hydrates the server rows in place", () => {
    const root = document.createElement("div");
    root.innerHTML = renderServerTemplate(compile(template), { open: true, rows });
    const first = root.querySelector("li");
    const open = createSignal(true);
    const rowSignal = createSignal(rows);
    const result = hydrate(root, moduleFor(template), { open, rows: rowSignal });
    expect(result.ok).toBe(true);
    expect(strip(root.innerHTML)).toBe(`<ul><li>A</li><li>B</li></ul>`);
    expect(root.querySelector("li")).toBe(first);
    rowSignal.set([{ id: "b", label: "B2" }]);
    expect(strip(root.innerHTML)).toBe(`<ul><li>B2</li></ul>`);
    open.set(false);
    expect(strip(root.innerHTML)).toBe(`<ul></ul>`);
  });

  it("mounts a <for> after a static sibling inside the branch as a sibling, not a child", () => {
    const root = document.createElement("div");
    mount(
      root,
      moduleFor(`<ul><if test={open}><li>head</li><for each={rows} key={row.id}><li>{row.label}</li></for></if></ul>`),
      {
        open: true,
        rows,
      },
    );
    expect(strip(root.innerHTML)).toBe(`<ul><li>head</li><li>A</li><li>B</li></ul>`);
  });
});

describe("sibling lists directly inside a branch or row", () => {
  it("mounts two direct lists in one branch and removes both when hidden", () => {
    const root = document.createElement("div");
    const open = createSignal(true);
    mount(
      root,
      moduleFor(
        `<ul><if test={open}><for each={a} key={x.id}><li>{x.id}</li></for><for each={b} key={y.id}><li>{y.id}</li></for></if></ul>`,
      ),
      { open, a: [{ id: "a1" }, { id: "a2" }], b: [{ id: "b1" }] },
    );
    expect(strip(root.innerHTML)).toBe(`<ul><li>a1</li><li>a2</li><li>b1</li></ul>`);
    open.set(false);
    expect(root.innerHTML).toBe(`<ul><!--tachyon-if--><!--/tachyon-if--></ul>`);
    open.set(true);
    expect(strip(root.innerHTML)).toBe(`<ul><li>a1</li><li>a2</li><li>b1</li></ul>`);
  });

  it("hydrates two direct lists in one branch in place", () => {
    const template = `<ul><if test={open}><for each={a} key={x.id}><li>{x.id}</li></for><for each={b} key={y.id}><li>{y.id}</li></for></if></ul>`;
    const scope = { open: true, a: [{ id: "a1" }], b: [{ id: "b1" }, { id: "b2" }] };
    const root = document.createElement("div");
    root.innerHTML = renderServerTemplate(compile(template), scope);
    const items = Array.from(root.querySelectorAll("li"));
    const b = createSignal(scope.b);
    const result = hydrate(root, moduleFor(template), { ...scope, b });
    expect(result.ok).toBe(true);
    expect(Array.from(root.querySelectorAll("li"))).toEqual(items);
    b.set([{ id: "b2" }]);
    expect(strip(root.innerHTML)).toBe(`<ul><li>a1</li><li>b2</li></ul>`);
  });

  it("reports a <for> placed directly inside a <for> row instead of nesting its rows in a sibling", () => {
    const result = compileTemplate(
      `<ul><for each={groups} as="group" key={group.id}><li>{group.id}</li><for each={group.items} as="item" key={item.id}><li>{item.id}</li></for></for></ul>`,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/directly inside a <for> row/);
  });
});

describe("memo reads inside batch", () => {
  it("does not abort the batch body because an unrelated memo fails", () => {
    const a = createSignal(1);
    const b = createSignal(1);
    const good = createMemo(() => a() * 2);
    const bad = createMemo(() => {
      if (b() > 1) throw new Error("bad memo");
      return b();
    });
    void bad;
    let rest = false;
    expect(() =>
      batch(() => {
        a.set(5);
        b.set(5);
        expect(good()).toBe(10);
        rest = true;
      }),
    ).toThrow("bad memo");
    expect(rest).toBe(true);
  });

  it("recomputes queued memos in order so chained memos read fresh", () => {
    const a = createSignal(1);
    const inner = createMemo(() => a() * 2);
    const outer = createMemo(() => inner() + 1);
    batch(() => {
      a.set(3);
      expect(outer()).toBe(7);
    });
    expect(outer()).toBe(7);
  });
});

describe("explain for nested regions", () => {
  it("reports the generic list runtime for a <for> nested in a branch or row", () => {
    const explanation = explainCompiledTemplate(
      compile(`<div><if test={open}><ul><for each={rows} key={row.id}><li>{row.label}</li></for></ul></if></div>`),
    );
    const nested = explanation.regions.find((region) => region.kind === "list");
    expect(nested?.runtime).toBe("tachyon-dom/runtime/list");
    expect(nested?.reasons.join(" ")).toMatch(/nested/);
    expect(explanation.runtimeImports).not.toContain("tachyon-dom/runtime/list-text");
  });
});
