// @vitest-environment jsdom
// Regressions from the review of de188cb: list region lookup must not enter a server-only insertion, and a memo
// whose upstream memo recomputed to an equal value must not recompute or rerun its own dependents.
import { describe, expect, it } from "vitest";
import { listRegionStartAt, listRegionStartBetween } from "../src/conditional-marker";
import { compileTemplate, generateClientModule, renderServerTemplate } from "../src/compiler";
import { ensureListRegion } from "../src/runtime/list-core";
import { hydrate } from "../src/runtime/mount";
import { batch, createMemo, createSignal, effect } from "../src/runtime/signal";
import { evaluateGeneratedClientModule } from "./generated-client-module";

const compile = (template: string) => {
  const compiled = compileTemplate(template);
  if (!compiled.ok) throw new Error(compiled.error.message);
  return compiled.value;
};

const moduleFor = (template: string) =>
  evaluateGeneratedClientModule(generateClientModule(compile(template), { reactive: true, instrumentBindings: false }));

const strip = (html: string): string => html.replace(/<!--[^>]*-->/g, "");

const external = `<!--tachyon-for--><p>External</p><!--/tachyon-for-->`;

describe("list regions inside a server-only insertion", () => {
  const dom = (insertion: string): HTMLElement => {
    const main = document.createElement("main");
    main.innerHTML = `${insertion}<!--tachyon-for--><p>A</p><!--/tachyon-for-->`;
    return main;
  };
  const ownRegion = (main: HTMLElement): Comment => {
    const comments = Array.from(main.childNodes).filter((node) => node.nodeType === 8) as Comment[];
    return comments.filter((node) => node.nodeValue === "tachyon-for").at(-1) as Comment;
  };

  it.each([
    ["slot", `<!--tachyon-slot:header-->${external}<!--/tachyon-slot:header-->`],
    ["outlet", `<!--tachyon-outlet-->${external}<!--/tachyon-outlet-->`],
  ])("counts only the parent's own list past a %s", (_kind, insertion) => {
    const main = dom(insertion);
    expect(listRegionStartAt(main, 0)).toBe(ownRegion(main));
    expect(listRegionStartAt(main, 1)).toBeUndefined();
    expect(listRegionStartBetween(main.firstChild, null, 0)).toBe(ownRegion(main));
    expect(ensureListRegion(main, { index: 0 }).start).toBe(ownRegion(main));
  });

  it("does not adopt an insertion's list when the insertion is unterminated", () => {
    const main = document.createElement("main");
    main.innerHTML = `<!--tachyon-slot:header-->${external}<!--tachyon-for--><p>A</p><!--/tachyon-for-->`;
    expect(listRegionStartAt(main, 0)).toBeUndefined();
  });

  it("hydrates and updates the parent's list while the slot's list stays untouched", () => {
    const template = `<main><slot name="header"></slot><for each={rows} key={row.id}><p>{row.label}</p></for></main>`;
    const root = document.createElement("div");
    root.innerHTML = renderServerTemplate(compile(template), {
      slots: { header: external },
      rows: [{ id: 1, label: "A" }],
    });
    const rows = createSignal([{ id: 1, label: "A" }]);
    const result = hydrate(root, moduleFor(template), { rows });
    expect(result.ok).toBe(true);
    rows.set([
      { id: 1, label: "A2" },
      { id: 2, label: "B" },
    ]);
    expect(strip(root.innerHTML)).toBe(`<main><p>External</p><p>A2</p><p>B</p></main>`);
    rows.set([]);
    expect(strip(root.innerHTML)).toBe(`<main><p>External</p></main>`);
  });
});

describe("equal intermediate memo values stop downstream recomputation", () => {
  const setup = () => {
    const source = createSignal(1);
    const parity = createMemo(() => source() % 2);
    let modelRuns = 0;
    const model = createMemo(() => {
      modelRuns++;
      return { odd: parity() === 1 };
    });
    let effectRuns = 0;
    effect(() => {
      model();
      effectRuns++;
    });
    return { source, parity, model, runs: () => ({ modelRuns, effectRuns }) };
  };

  it("keeps the downstream memo and effect untouched after a plain set", () => {
    const { source, parity, model, runs } = setup();
    const original = model();
    source.set(3);
    expect(parity()).toBe(1);
    expect(model()).toBe(original);
    expect(runs()).toEqual({ modelRuns: 1, effectRuns: 1 });
    source.set(4);
    expect(model()).not.toBe(original);
    expect(runs()).toEqual({ modelRuns: 2, effectRuns: 2 });
  });

  it("keeps the downstream memo untouched when read inside batch", () => {
    const { source, model, runs } = setup();
    const original = model();
    batch(() => {
      source.set(3);
      expect(model()).toBe(original);
    });
    expect(runs()).toEqual({ modelRuns: 1, effectRuns: 1 });
  });

  it("still recomputes the downstream memo when any of several upstream memos changed", () => {
    const a = createSignal(1);
    const b = createSignal(1);
    const parityA = createMemo(() => a() % 2);
    const doubleB = createMemo(() => b() * 2);
    let runs = 0;
    const combined = createMemo(() => {
      runs++;
      return `${parityA()}:${doubleB()}`;
    });
    expect(combined()).toBe("1:2");
    batch(() => {
      a.set(3);
      b.set(2);
    });
    expect(combined()).toBe("1:4");
    expect(runs).toBe(2);
  });

  it("recomputes a downstream memo that also reads a changed signal directly", () => {
    const source = createSignal(1);
    const parity = createMemo(() => source() % 2);
    let runs = 0;
    const both = createMemo(() => {
      runs++;
      return `${source()}:${parity()}`;
    });
    expect(both()).toBe("1:1");
    source.set(3);
    expect(both()).toBe("3:1");
    expect(runs).toBe(2);
  });

  it("propagates a recovered failure as a change even when the value is equal", () => {
    const source = createSignal(0);
    const inner = createMemo(() => {
      if (source() === 1) throw new Error("bad");
      return "same";
    });
    let runs = 0;
    const outer = createMemo(() => {
      runs++;
      return inner();
    });
    expect(outer()).toBe("same");
    // Both memos fail in the flush, so the flush reports both.
    expect(() => source.set(1)).toThrow();
    expect(() => outer()).toThrow("bad");
    source.set(2);
    expect(outer()).toBe("same");
    expect(runs).toBe(3);
  });
});

describe("memo check state bookkeeping", () => {
  it("clears the dirty flag after a real recomputation so the next equal upstream value is skipped", () => {
    const source = createSignal(1);
    const parity = createMemo(() => source() % 2);
    let runs = 0;
    const model = createMemo(() => {
      runs++;
      return parity();
    });
    expect(model()).toBe(1);
    source.set(4);
    expect(runs).toBe(2);
    source.set(6);
    expect(runs).toBe(2);
    expect(model()).toBe(0);
  });

  it("runs a checked memo once when the pull of its dependency dirties it inside batch", () => {
    const source = createSignal(1);
    const parity = createMemo(() => source() % 2);
    let runs = 0;
    const model = createMemo(() => {
      runs++;
      return parity();
    });
    expect(model()).toBe(1);
    batch(() => {
      source.set(4);
      expect(model()).toBe(0);
    });
    expect(runs).toBe(2);
  });

  it("stops the list lookup at the given end node", () => {
    const main = document.createElement("main");
    main.innerHTML = `<p>x</p><!--tachyon-if--><!--/tachyon-if--><!--tachyon-for--><p>A</p><!--/tachyon-for-->`;
    const ifEnd = main.childNodes[2] as Node;
    expect(listRegionStartBetween(main.firstChild, ifEnd, 0)).toBeUndefined();
    expect(listRegionStartBetween(main.firstChild, null, 0)).toBe(main.childNodes[3]);
  });
});

describe("list lookup end bound inside an insertion", () => {
  const html = `<!--tachyon-slot:s--><p>inside</p><!--/tachyon-slot:s--><!--tachyon-for--><p>outside</p><!--/tachyon-for-->`;
  const outletHtml = html.replace("tachyon-slot:s", "tachyon-outlet").replace("/tachyon-slot:s", "/tachyon-outlet");

  it.each([
    ["the slot's end marker", html, 2],
    ["a node inside the slot", html, 1],
    ["the outlet's end marker", outletHtml, 2],
  ])("finds nothing when end is %s", (_label, markup, endIndex) => {
    const main = document.createElement("main");
    main.innerHTML = markup;
    expect(listRegionStartBetween(main.firstChild, main.childNodes[endIndex] as Node, 0)).toBeUndefined();
    expect(listRegionStartBetween(main.firstChild, null, 0)).toBe(main.childNodes[3]);
  });
});
