// @vitest-environment jsdom
// 073 moves a lightweight conditional's class, attribute, style, and event bindings onto setters the generated
// module injects, the way keyed rows already work. The branch runtime then keeps only the text path, so a
// template that never uses those bindings never pays for them.
import { describe, expect, it } from "vitest";
import { compileTemplate, generateClientModule } from "../src/compiler";
import { mountConditionalCore, mountGeneratedConditionalCore } from "../src/runtime/conditional-core";
import { hydrate, mount } from "../src/runtime/mount";
import { createSignal } from "../src/runtime/signal";
import { evaluateGeneratedClientModule } from "./generated-client-module";

const generated = (source: string, options: Parameters<typeof generateClientModule>[1] = {}) => {
  const compiled = compileTemplate(source);
  if (!compiled.ok) throw new Error(compiled.error.message);
  return generateClientModule(compiled.value, { reactive: true, instrumentBindings: false, ...options });
};

describe("generated conditional bindings", () => {
  // A branch the core cannot take - one that declares a store - is driven by the generic branch runtime's
  // generated entry, which reads and applies everything through the descriptor. Every kind it can hold is
  // exercised here, because nothing else reaches that entry's accessors.
  it("drives every binding kind through the generic branch entry", () => {
    const module = evaluateGeneratedClientModule(
      generated(
        `<main><if test={open}><store draft={seed}/><section class:on={flag} title={tip} style:color={hue} ref={refs.panel} on:click={pick}><input bind:value={draft}><ul><for each={rows} key={row.id}><li>{row.label}</li></for></ul><if test={deep}><store note={draft}/><em>{note}</em></if></section></if></main>`,
      ),
    );
    const root = document.createElement("div");
    const picks: string[] = [];
    const scope = {
      open: createSignal(true),
      seed: "typed",
      flag: createSignal(true),
      tip: createSignal("Tip"),
      hue: createSignal("red"),
      refs: {} as { panel?: Element },
      pick: () => picks.push("pick"),
      rows: createSignal([{ id: "a", label: "A" }]),
      deep: createSignal(true),
    };

    const handle = mount(root, module, scope);
    const section = root.querySelector("section");
    const input = root.querySelector("input");
    if (!(section instanceof HTMLElement) || !(input instanceof HTMLInputElement)) throw new Error("Missing nodes.");

    expect(section.classList.contains("on")).toBe(true);
    expect(section.getAttribute("title")).toBe("Tip");
    expect(section.style.color).toBe("red");
    expect(scope.refs.panel).toBe(section);
    expect(input.value).toBe("typed");
    expect(root.querySelector("li")?.textContent).toBe("A");
    expect(root.querySelector("em")?.textContent).toBe("typed");

    section.click();
    expect(picks).toEqual(["pick"]);

    scope.flag.set(false);
    scope.tip.set("Other");
    scope.hue.set("blue");
    scope.rows.set([{ id: "b", label: "B" }]);
    expect(section.classList.contains("on")).toBe(false);
    expect(section.getAttribute("title")).toBe("Other");
    expect(section.style.color).toBe("blue");
    expect(root.querySelector("li")?.textContent).toBe("B");
    scope.deep.set(false);
    expect(root.querySelector("em")).toBeNull();

    handle.dispose();
  });

  it("compiles branch values into injected setters instead of tagged descriptors", () => {
    const code = generated(
      `<main><if test={open}><b class={theme} class:on={flag} title={tip} style:color={hue} on:click={save}>{label}</b></if></main>`,
    );

    // Each value carries the exact setter it needs, including the class attribute's dedicated one.
    expect(code).toContain(`apply: (node, value) => __tachyonSetClassValue(node, value)`);
    expect(code).toContain(`apply: (node, value) => __tachyonSetClassPresence(node, "on", value)`);
    expect(code).toContain(`apply: (node, value) => __tachyonSetAttributeValue(node, "title", value)`);
    expect(code).toContain(`apply: (node, value) => __tachyonSetStyleValue(node, "color", value)`);
    expect(code).toContain(`mountGeneratedConditionalCore as`);
    expect(code).not.toContain(`mountConditionalCore as`);
    expect(code).toContain(`apply: (node, value) =>`);
    expect(code).toContain(`bind: (element, readScope) =>`);
    expect(code).not.toContain(`kind: "class"`);
    expect(code).not.toContain(`kind: "style"`);
    expect(code).not.toContain(`className:`);
    expect(code).not.toContain(`eventName:`);
    // A branch listener is the only reason to reach for the event runtime, and it comes from the same
    // delegate the generated rows use, so the target-only variant is no longer generated at all.
    expect(code).not.toContain(`delegateTarget`);
  });

  it("emits an events field only for a branch that has listeners, and keeps every listener it has", () => {
    const withoutEvents = generated(`<main><if test={open}><b title={tip}>{label}</b></if></main>`);
    expect(withoutEvents).not.toContain(`events:`);

    const module = evaluateGeneratedClientModule(
      generated(`<main><if test={open}><input on:input={typed} on:focus={focused}></if></main>`),
    );
    const root = document.createElement("div");
    const calls: string[] = [];
    const handle = mount(root, module, {
      open: createSignal(true),
      typed: () => void calls.push("input"),
      focused: () => void calls.push("focus"),
    });
    const input = root.querySelector("input");

    input?.dispatchEvent(new Event("input"));
    input?.dispatchEvent(new Event("focus"));
    handle.dispose();
    input?.dispatchEvent(new Event("input"));

    expect(calls).toEqual(["input", "focus"]);
  });

  it("mounts, updates, and disposes a branch through the injected setters", () => {
    const module = evaluateGeneratedClientModule(
      generated(
        `<main><if test={open}><b class:on={flag} title={tip} style:color={hue} on:click={save}>{label}</b></if></main>`,
      ),
    );
    const root = document.createElement("div");
    const clicks: string[] = [];
    const scope = {
      open: createSignal(true),
      flag: createSignal(true),
      tip: createSignal("T"),
      hue: createSignal("red"),
      label: createSignal("L"),
      save: () => void clicks.push("save"),
    };
    const handle = mount(root, module, scope);

    const branch = () => root.querySelector("b");
    expect(branch()?.textContent).toBe("L");
    expect(branch()?.getAttribute("class")).toBe("on");
    expect(branch()?.getAttribute("title")).toBe("T");
    expect(branch()?.getAttribute("style")).toContain("red");
    branch()?.dispatchEvent(new Event("click"));

    const sameNode = branch();
    scope.flag.set(false);
    scope.tip.set("T2");
    scope.hue.set("blue");
    scope.label.set("L2");
    expect(branch()).toBe(sameNode);
    expect(branch()?.textContent).toBe("L2");
    expect(branch()?.getAttribute("class")).toBeNull();
    expect(branch()?.getAttribute("title")).toBe("T2");
    expect(branch()?.getAttribute("style")).toContain("blue");
    branch()?.dispatchEvent(new Event("click"));

    scope.open.set(false);
    expect(root.querySelector("b")).toBeNull();
    scope.open.set(true);
    expect(root.querySelector("b")?.textContent).toBe("L2");

    handle.dispose();
    expect(root.querySelector("b")).toBeNull();
    expect(clicks).toEqual(["save", "save"]);
  });

  // The branch listener reads its handler when the event fires, so a scope whose handler changed between runs
  // dispatches to the current one.
  it("calls the handler the branch scope currently holds", () => {
    const module = evaluateGeneratedClientModule(
      generated(`<main><if test={open}><button on:click={save}>Go</button></if></main>`),
    );
    const root = document.createElement("div");
    const calls: string[] = [];
    const scope = { open: createSignal(true), save: () => void calls.push("first") };
    const handle = mount(root, module, scope);
    const button = root.querySelector("button");

    button?.dispatchEvent(new Event("click"));
    scope.save = () => void calls.push("second");
    // The branch survives an unrelated re-run, so its listener is not re-registered.
    scope.open.set(true);
    expect(root.querySelector("button")).toBe(button);
    button?.dispatchEvent(new Event("click"));

    handle.dispose();
    button?.dispatchEvent(new Event("click"));
    expect(calls).toEqual(["first", "second"]);
  });

  it("hydrates a server-rendered branch through the same setters", () => {
    const module = evaluateGeneratedClientModule(
      generated(`<main><if test={open}><b class:on={flag} title={tip}>{label}</b></if><p>{tail}</p></main>`),
    );
    const root = document.createElement("div");
    root.innerHTML = `<main><!--tachyon-if--><b class="on" title="T">L</b><!--/tachyon-if--><p>Tail</p></main>`;
    const server = root.querySelector("b");
    const scope = {
      open: createSignal(true),
      flag: createSignal(true),
      tip: createSignal("T"),
      label: createSignal("L"),
      tail: createSignal("Tail"),
    };
    const result = hydrate(root, module, scope);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(root.querySelector("b")).toBe(server);
    scope.tip.set("T2");
    expect(root.querySelector("b")?.getAttribute("title")).toBe("T2");
    result.value.dispose();
  });

  // C02 of 079: the descriptor form that carries expression strings stays part of the published runtime.
  it("still resolves a hand-written conditional-core descriptor", () => {
    const branch = document.createElement("section");
    branch.innerHTML = `<!---->`;

    mountConditionalCore(
      branch,
      [0],
      true,
      { message: "M", flag: true },
      {
        templateHtml: `<p> </p>`,
        bindings: [
          { kind: "text", path: [0], expression: "message" },
          { kind: "class", path: [], className: "on", expression: "flag" },
        ],
      },
    );

    expect(branch.textContent).toBe("M");
    expect(branch.querySelector("p")?.getAttribute("class")).toBe("on");
  });

  // A branch whose markup no longer matches the descriptor still has to come up: the binding whose node is
  // missing is skipped rather than read and written through a path that resolves to nothing.
  it("skips a generated branch binding whose node is missing", () => {
    const branch = document.createElement("section");
    branch.innerHTML = `<!---->`;
    let reads = 0;

    expect(() =>
      mountGeneratedConditionalCore(
        branch,
        [0],
        true,
        {},
        {
          signature: "missing-node",
          templateHtml: `<p> </p>`,
          bindings: [
            { path: [0], read: () => "kept" },
            {
              path: [5],
              read: () => {
                reads += 1;
                return "unreachable";
              },
            },
          ],
        },
      ),
    ).not.toThrow();

    expect(branch.textContent).toBe("kept");
    expect(reads).toBe(0);
  });

  it("registers a branch listener only on a node that can carry one", () => {
    const branch = document.createElement("section");
    branch.innerHTML = `<!---->`;
    const bound: Node[] = [];
    const bind = (element: Element): (() => void) => {
      bound.push(element);
      return () => undefined;
    };

    mountGeneratedConditionalCore(
      branch,
      [0],
      true,
      {},
      {
        signature: "text-target",
        templateHtml: `<p> </p>`,
        bindings: [{ path: [0], read: () => "T" }],
        // Path [0] is the template's text node, and path [] is the element that holds it.
        events: [
          { path: [0], bind },
          { path: [], bind },
        ],
      },
    );

    expect(bound).toEqual([branch.querySelector("p")]);
  });

  // The generated entry has no expression strings to fall back to, so a descriptor without a reader cannot be
  // written at all. TypeScript rejects it, and the runtime never silently resolves a path instead.
  it("requires a reader on every generated branch binding", () => {
    const branch = document.createElement("section");
    branch.innerHTML = `<!---->`;

    mountGeneratedConditionalCore(
      branch,
      [0],
      true,
      { message: "M" },
      {
        signature: "generated",
        templateHtml: `<p> </p>`,
        bindings: [{ path: [0], read: (scope) => scope.message }],
      },
    );

    expect(branch.textContent).toBe("M");
    // @ts-expect-error a generated binding without a reader is a compile error
    const missing: Parameters<typeof mountGeneratedConditionalCore>[4]["bindings"][number] = { path: [0] };
    expect(missing.read).toBeUndefined();
  });
});
