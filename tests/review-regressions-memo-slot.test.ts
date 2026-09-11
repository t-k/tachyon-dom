// @vitest-environment jsdom
// Regressions from the 0.3.0 review: memo recomputation glitches, cached memo failures, and the position of
// bindings that follow a server-only <slot> or <outlet> insertion.
import { describe, expect, it } from "vitest";
import { compileTemplate, generateClientModule, generateServerModule, renderServerTemplate } from "../src/compiler";
import { hydrate, mount } from "../src/runtime/mount";
import { batch, createMemo, createReactiveErrorScope, createSignal, effect } from "../src/runtime/signal";
import { evaluateGeneratedClientModule } from "./generated-client-module";

const compile = (template: string) => {
  const compiled = compileTemplate(template);
  if (!compiled.ok) throw new Error(compiled.error.message);
  return compiled.value;
};

const moduleFor = (template: string) =>
  evaluateGeneratedClientModule(generateClientModule(compile(template), { reactive: true, instrumentBindings: false }));

const strip = (html: string): string => html.replace(/<!--[^>]*-->/g, "");

describe("memo recomputation follows dependencies", () => {
  const setup = () => {
    const source = createSignal(1);
    const constant = createMemo(() => 10);
    const derived = createMemo(() => source() + constant());
    const seen: Array<[number, number]> = [];
    const checked = createMemo(() => {
      const current = source();
      const value = derived();
      seen.push([current, value]);
      if (value !== current + 10) throw new Error(`inconsistent:${current},${value}`);
      return value;
    });
    return { source, derived, checked, seen };
  };

  it("never lets a memo observe a stale dependency during a plain set", () => {
    const { source, checked, seen } = setup();
    expect(() => source.set(2)).not.toThrow();
    expect(checked()).toBe(12);
    expect(seen).toEqual([
      [1, 11],
      [2, 12],
    ]);
  });

  it("never lets a memo observe a stale dependency when read inside batch", () => {
    const { source, checked, seen } = setup();
    batch(() => {
      source.set(2);
      expect(checked()).toBe(12);
    });
    expect(seen).toEqual([
      [1, 11],
      [2, 12],
    ]);
  });

  it("reading one memo does not run an unrelated queued memo", () => {
    const a = createSignal(1);
    const b = createSignal(1);
    let otherRuns = 0;
    const onA = createMemo(() => a() * 2);
    const onB = createMemo(() => {
      otherRuns++;
      return b();
    });
    void onB;
    otherRuns = 0;
    batch(() => {
      a.set(2);
      b.set(2);
      expect(onA()).toBe(4);
      expect(otherRuns).toBe(0);
    });
    expect(otherRuns).toBe(1);
  });

  it("still recomputes each memo at most once per flush", () => {
    const source = createSignal(1);
    let derivedRuns = 0;
    const derived = createMemo(() => {
      derivedRuns++;
      return source() * 2;
    });
    const seen: number[] = [];
    effect(() => {
      seen.push(derived());
    });
    derivedRuns = 0;
    batch(() => {
      source.set(2);
      derived();
      source.set(3);
    });
    expect(derivedRuns).toBe(2);
    expect(seen).toEqual([2, 6]);
  });
});

describe("failed memos keep their failure", () => {
  it("rethrows the same failure on a second read inside batch", () => {
    const source = createSignal(0);
    let runs = 0;
    const value = createMemo(() => {
      runs++;
      if (source() !== 0) throw new Error("invalid");
      return "old";
    });
    expect(value()).toBe("old");
    batch(() => {
      source.set(1);
      expect(() => value()).toThrow("invalid");
      expect(() => value()).toThrow("invalid");
    });
    expect(runs).toBe(2);
  });

  it("rethrows the failure to a reader after the flush reported it", () => {
    const source = createSignal(0);
    const value = createMemo(() => {
      if (source() !== 0) throw new Error("invalid");
      return "old";
    });
    effect(() => {
      void source();
    });
    expect(() => source.set(1)).toThrow("invalid");
    expect(() => value()).toThrow("invalid");
    source.set(0);
    expect(value()).toBe("old");
  });

  it("fails a dependent memo instead of handing it the last good value", () => {
    const source = createSignal(0);
    const inner = createMemo(() => {
      if (source() !== 0) throw new Error("invalid");
      return "old";
    });
    const outer = createMemo(() => `outer:${inner()}`);
    expect(outer()).toBe("outer:old");
    batch(() => {
      source.set(1);
      expect(() => outer()).toThrow("invalid");
    });
    expect(() => outer()).toThrow("invalid");
  });

  it("reruns effects that read a failed memo so their error owner sees the failure", () => {
    const source = createSignal(0);
    const errors: string[] = [];
    const scope = createReactiveErrorScope((error) => errors.push(String((error as Error).message)));
    const seen: string[] = [];
    scope.run(() => {
      const value = createMemo(() => {
        if (source() !== 0) throw new Error("invalid");
        return "old";
      });
      effect(() => {
        seen.push(value());
      });
    });
    source.set(1);
    expect(seen).toEqual(["old"]);
    expect(errors).toContain("invalid");
    scope.dispose();
  });
});

describe("bindings after a server-only <slot> or <outlet>", () => {
  const slotTemplate = `<section><slot name="header"></slot><p>{title}</p></section>`;
  const outletTemplate = `<section><outlet></outlet><p>{title}</p></section>`;

  it.each([
    ["", 0],
    ["<h2>A</h2>", 1],
    ["<h2>A</h2><h2>B</h2>", 2],
  ])("hydrates the sibling text after a slot filled with %j", (header) => {
    const root = document.createElement("div");
    root.innerHTML = renderServerTemplate(compile(slotTemplate), { slots: { header }, title: "T" });
    expect(strip(root.innerHTML)).toBe(`<section>${header}<p>T</p></section>`);
    const headings = Array.from(root.querySelectorAll("h2"));
    const title = createSignal("T");
    const result = hydrate(root, moduleFor(slotTemplate), { title });
    expect(result.ok).toBe(true);
    title.set("T2");
    expect(strip(root.innerHTML)).toBe(`<section>${header}<p>T2</p></section>`);
    expect(Array.from(root.querySelectorAll("h2"))).toEqual(headings);
  });

  it.each([
    ["", 0],
    ["<h2>A</h2>", 1],
    ["<h2>A</h2><h2>B</h2>", 2],
  ])("hydrates the sibling text after an outlet filled with %j", (outlet) => {
    const root = document.createElement("div");
    root.innerHTML = renderServerTemplate(compile(outletTemplate), { outlet, title: "T" });
    const title = createSignal("T");
    const result = hydrate(root, moduleFor(outletTemplate), { title });
    expect(result.ok).toBe(true);
    title.set("T2");
    expect(strip(root.innerHTML)).toBe(`<section>${outlet}<p>T2</p></section>`);
  });

  it("binds events and attributes after a two-element slot to the right element", () => {
    const template = `<section><slot name="header"></slot><button class:active={active} data-id={id} on:click={onClick}>go</button></section>`;
    const root = document.createElement("div");
    root.innerHTML = renderServerTemplate(compile(template), {
      slots: { header: "<button>A</button><button>B</button>" },
      active: false,
      id: "x",
    });
    let clicks = 0;
    const active = createSignal(false);
    const id = createSignal("x");
    const result = hydrate(root, moduleFor(template), { active, id, onClick: () => clicks++ });
    expect(result.ok).toBe(true);
    const buttons = Array.from(root.querySelectorAll("button"));
    buttons[0]?.dispatchEvent(new Event("click"));
    expect(clicks).toBe(0);
    buttons[2]?.dispatchEvent(new Event("click"));
    expect(clicks).toBe(1);
    active.set(true);
    id.set("y");
    expect(buttons[2]?.className).toBe("active");
    expect(buttons[2]?.getAttribute("data-id")).toBe("y");
    expect(buttons[0]?.className).toBe("");
  });

  it("delimits slot and outlet output with markers in the server and generated modules", () => {
    const compiled = compile(slotTemplate);
    expect(renderServerTemplate(compiled, { slots: { header: "<h2>A</h2>" }, title: "T" })).toBe(
      `<section><!--tachyon-slot:header--><h2>A</h2><!--/tachyon-slot:header--><p>T</p></section>`,
    );
    expect(compiled.client.templateHtml).toBe(
      `<section><!--tachyon-slot:header--><!--/tachyon-slot:header--><p> </p></section>`,
    );
    expect(generateServerModule(compiled)).toContain("<!--tachyon-slot:header-->");
    const outlet = compile(outletTemplate);
    expect(renderServerTemplate(outlet, { outlet: "<h2>A</h2>", title: "T" })).toBe(
      `<section><!--tachyon-outlet--><h2>A</h2><!--/tachyon-outlet--><p>T</p></section>`,
    );
  });

  it("mounts the template on the client with no slot content and the sibling bound", () => {
    const root = document.createElement("div");
    const title = createSignal("T");
    mount(root, moduleFor(slotTemplate), { title });
    expect(strip(root.innerHTML)).toBe(`<section><p>T</p></section>`);
    title.set("T2");
    expect(strip(root.innerHTML)).toBe(`<section><p>T2</p></section>`);
  });

  it("keeps hydrating a slot whose content carries nested region markers", () => {
    const inner = compile(`<div><if test={open}><b>x</b></if><for each={rows} key={r}><i>{r}</i></for></div>`);
    const header = renderServerTemplate(inner, { open: true, rows: ["a", "b"] });
    const root = document.createElement("div");
    root.innerHTML = renderServerTemplate(compile(slotTemplate), { slots: { header }, title: "T" });
    const title = createSignal("T");
    const result = hydrate(root, moduleFor(slotTemplate), { title });
    expect(result.ok).toBe(true);
    title.set("T2");
    expect(strip(root.innerHTML)).toBe(`<section><div><b>x</b><i>a</i><i>b</i></div><p>T2</p></section>`);
  });
});

describe("memo notification details", () => {
  it("delivers an early-read failure to the memo's error owner and to the reader", () => {
    const source = createSignal(0);
    const errors: string[] = [];
    const scope = createReactiveErrorScope((error) => errors.push(String((error as Error).message)));
    const value = scope.run(() =>
      createMemo(() => {
        if (source() !== 0) throw new Error("invalid");
        return "old";
      }),
    );
    batch(() => {
      source.set(1);
      expect(() => value()).toThrow("invalid");
    });
    expect(errors).toEqual(["invalid"]);
    scope.dispose();
  });

  it("reruns a dependent effect on failure even when the memo later recovers to the same value", () => {
    const source = createSignal(0);
    const errors: string[] = [];
    const scope = createReactiveErrorScope((error) => errors.push(String((error as Error).message)));
    const attempts: string[] = [];
    scope.run(() => {
      const value = createMemo(() => {
        if (source() === 1) throw new Error("invalid");
        return "same";
      });
      effect(() => {
        attempts.push("run");
        attempts.push(value());
      });
    });
    source.set(1);
    // The memo's own failure reaches the scope, and so does the rerun effect's.
    expect(errors).toEqual(["invalid", "invalid"]);
    expect(attempts).toEqual(["run", "same", "run"]);
    source.set(2);
    expect(attempts).toEqual(["run", "same", "run", "run", "same"]);
    scope.dispose();
  });

  it("does not rerun a dependent effect when the memo recomputes to an equal value", () => {
    const source = createSignal(1);
    const parity = createMemo(() => source() % 2);
    let runs = 0;
    effect(() => {
      parity();
      runs++;
    });
    source.set(3);
    expect(runs).toBe(1);
    source.set(4);
    expect(runs).toBe(2);
  });
});

describe("insertions inside managed regions", () => {
  const template = `<section><if test={open}><slot name="s"></slot><p>{title}</p></if></section>`;

  it("hydrates a branch holding a two-element slot and binds the sibling after it", () => {
    const root = document.createElement("div");
    root.innerHTML = renderServerTemplate(compile(template), {
      open: true,
      slots: { s: "<b>A</b><b>B</b>" },
      title: "T",
    });
    const open = createSignal(true);
    const title = createSignal("T");
    const result = hydrate(root, moduleFor(template), { open, title });
    expect(result.ok).toBe(true);
    title.set("T2");
    expect(strip(root.innerHTML)).toBe(`<section><b>A</b><b>B</b><p>T2</p></section>`);
    open.set(false);
    expect(strip(root.innerHTML)).toBe(`<section></section>`);
    open.set(true);
    expect(strip(root.innerHTML)).toBe(`<section><p>T2</p></section>`);
  });

  it("hydrates a row holding a slot and binds the row text after it", () => {
    const rows = `<ul><for each={rows} key={r}><li><slot name="s"></slot><span>{r}</span></li></for></ul>`;
    const root = document.createElement("div");
    root.innerHTML = renderServerTemplate(compile(rows), { rows: ["a", "b"], slots: { s: "<b>1</b><b>2</b>" } });
    const list = createSignal(["a", "b"]);
    const result = hydrate(root, moduleFor(rows), { rows: list });
    expect(result.ok).toBe(true);
    list.set(["b"]);
    expect(strip(root.innerHTML)).toBe(`<ul><li><b>1</b><b>2</b><span>b</span></li></ul>`);
  });
});

describe("insertions inside generic regions and new rows", () => {
  it("mounts, hides, and re-shows a generic branch holding a slot and a nested list", () => {
    const template = `<section><if test={open}><slot name="s"></slot><ul><for each={rows} key={r}><li>{r}</li></for></ul><p>{title}</p></if></section>`;
    const root = document.createElement("div");
    const open = createSignal(true);
    const title = createSignal("T");
    mount(root, moduleFor(template), { open, title, rows: ["a"] });
    expect(strip(root.innerHTML)).toBe(`<section><ul><li>a</li></ul><p>T</p></section>`);
    open.set(false);
    expect(strip(root.innerHTML)).toBe(`<section></section>`);
    open.set(true);
    title.set("T2");
    expect(strip(root.innerHTML)).toBe(`<section><ul><li>a</li></ul><p>T2</p></section>`);
  });

  it("hydrates a generic branch holding a two-element slot and removes the slot content with the branch", () => {
    const template = `<section><if test={open}><slot name="s"></slot><ul><for each={rows} key={r}><li>{r}</li></for></ul><p>{title}</p></if></section>`;
    const root = document.createElement("div");
    root.innerHTML = renderServerTemplate(compile(template), {
      open: true,
      rows: ["a"],
      slots: { s: "<b>A</b><b>B</b>" },
      title: "T",
    });
    const open = createSignal(true);
    const title = createSignal("T");
    const result = hydrate(root, moduleFor(template), { open, title, rows: ["a"] });
    expect(result.ok).toBe(true);
    title.set("T2");
    expect(strip(root.innerHTML)).toBe(`<section><b>A</b><b>B</b><ul><li>a</li></ul><p>T2</p></section>`);
    open.set(false);
    expect(strip(root.innerHTML)).toBe(`<section></section>`);
  });

  it("creates new rows whose template carries an empty slot and binds the row text", () => {
    const rows = `<ul><for each={rows} key={r}><li><slot name="s"></slot><span>{r}</span></li></for></ul>`;
    const root = document.createElement("div");
    const list = createSignal(["a"]);
    mount(root, moduleFor(rows), { rows: list });
    list.set(["a", "b"]);
    expect(strip(root.innerHTML)).toBe(`<ul><li><span>a</span></li><li><span>b</span></li></ul>`);
  });
});
