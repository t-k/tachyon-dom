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
