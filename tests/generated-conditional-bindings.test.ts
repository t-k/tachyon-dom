// @vitest-environment jsdom
// 073 moves a lightweight conditional's class, attribute, style, and event bindings onto setters the generated
// module injects, the way keyed rows already work. The branch runtime then keeps only the text path, so a
// template that never uses those bindings never pays for them.
import { describe, expect, it } from "vitest";
import { compileTemplate, generateClientModule } from "../src/compiler";
import { mountConditionalCore, mountGeneratedConditional } from "../src/runtime/conditional-core";
import { hydrate, mount } from "../src/runtime/mount";
import { createSignal } from "../src/runtime/signal";
import { evaluateGeneratedClientModule } from "./generated-client-module";

const generated = (source: string, options: Parameters<typeof generateClientModule>[1] = {}) => {
  const compiled = compileTemplate(source);
  if (!compiled.ok) throw new Error(compiled.error.message);
  return generateClientModule(compiled.value, { reactive: true, instrumentBindings: false, ...options });
};

describe("generated conditional bindings", () => {
  it("compiles branch values into injected setters instead of tagged descriptors", () => {
    const code = generated(
      `<main><if test={open}><b class:on={flag} title={tip} style:color={hue} on:click={save}>{label}</b></if></main>`,
    );

    expect(code).toContain(`mountGeneratedConditional as`);
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
    root.innerHTML = `<main><b class="on" title="T">L</b><p>Tail</p></main>`;
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

    mountConditionalCore(branch, [0], true, { message: "M", flag: true }, {
      templateHtml: `<p> </p>`,
      bindings: [
        { kind: "text", path: [0], expression: "message" },
        { kind: "class", path: [], className: "on", expression: "flag" },
      ],
    });

    expect(branch.textContent).toBe("M");
    expect(branch.querySelector("p")?.getAttribute("class")).toBe("on");
  });

  // The generated entry has no expression strings to fall back to, so a descriptor without a reader cannot be
  // written at all. TypeScript rejects it, and the runtime never silently resolves a path instead.
  it("requires a reader on every generated branch binding", () => {
    const branch = document.createElement("section");
    branch.innerHTML = `<!---->`;

    mountGeneratedConditional(branch, [0], true, { message: "M" }, {
      signature: "generated",
      templateHtml: `<p> </p>`,
      bindings: [{ path: [0], read: (scope) => scope.message }],
    });

    expect(branch.textContent).toBe("M");
    // @ts-expect-error a generated binding without a reader is a compile error
    const missing: Parameters<typeof mountGeneratedConditional>[4]["bindings"][number] = { path: [0] };
    expect(missing.read).toBeUndefined();
  });
});
