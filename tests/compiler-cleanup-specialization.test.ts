import { describe, expect, it } from "vitest";
import { compileTemplate, generateClientModule } from "../src/compiler";
import { mount } from "../src/runtime/mount";
import { createSignal } from "../src/runtime/signal";
import { registerOwnedSubtree } from "../src/runtime/subtree";
import { evaluateGeneratedClientModule } from "./generated-client-module";

const generated = (source: string, options: Parameters<typeof generateClientModule>[1] = {}) => {
  const compiled = compileTemplate(source);
  if (!compiled.ok) throw new Error(compiled.error.message);
  return generateClientModule(compiled.value, { instrumentBindings: false, ...options });
};

const registersCleanup = (code: string) => code.includes("const cleanups = [];");

describe("generated cleanup specialization", () => {
  it("emits the cleanup list only for templates that register a disposer", () => {
    expect(registersCleanup(generated(`<main><h1>Static</h1></main>`))).toBe(false);
    expect(registersCleanup(generated(`<main><h1>Static</h1></main>`, { reactive: true }))).toBe(false);
    expect(registersCleanup(generated(`<p>{message}</p>`))).toBe(false);

    expect(registersCleanup(generated(`<p>{message}</p>`, { reactive: true }))).toBe(true);
    expect(registersCleanup(generated(`<button on:click={save}>x</button>`))).toBe(true);
    expect(registersCleanup(generated(`<form><input bind:value={value}></form>`))).toBe(true);
    expect(registersCleanup(generated(`<div ref={refs.panel}></div>`))).toBe(true);
    // Text lists always register their region cleanup; other lists and conditionals only do so reactively.
    expect(registersCleanup(generated(`<ul><for each={rows} key={row.id}><li>{row.label}</li></for></ul>`))).toBe(true);
    expect(registersCleanup(generated(`<main><if test={visible}><span>x</span></if></main>`))).toBe(false);
    expect(registersCleanup(generated(`<main><if test={visible}><span>x</span></if></main>`, { reactive: true }))).toBe(
      true,
    );
    // A class row is driven by the generated adapter, which always registers its region cleanup.
    expect(
      registersCleanup(generated(`<ul><for each={rows} key={row.id}><li class:on={row.on}></li></for></ul>`)),
    ).toBe(true);
    expect(
      registersCleanup(generated(`<ul><for each={rows} key={row.id}><li style:opacity={row.o}></li></for></ul>`)),
    ).toBe(false);
    expect(
      registersCleanup(
        generated(`<ul><for each={rows} key={row.id}><li style:opacity={row.o}></li></for></ul>`, { reactive: true }),
      ),
    ).toBe(true);
  });

  it("returns the root disposer directly when nothing registers cleanup", () => {
    const code = generated(`<p>{message}</p>`);

    expect(code).toContain(`  return __tachyonDisposeRoot;`);
    expect(code).not.toContain(`__tachyonCleanupFailed`);
  });

  it("disposes a specialized module once and stays idempotent", () => {
    const module = evaluateGeneratedClientModule(generated(`<p>{message}</p>`));
    const root = document.createElement("div");
    const handle = mount(root, module, { message: "M" });

    expect(root.textContent).toBe("M");
    expect(() => handle.dispose()).not.toThrow();
    expect(() => handle.dispose()).not.toThrow();
    expect(root.textContent).toBe("M");
  });

  it("still releases every registered resource when one cleanup throws", () => {
    const module = evaluateGeneratedClientModule(
      generated(`<main><button on:click={save}>x</button><if test={visible}><span>{label}</span></if></main>`, {
        reactive: true,
      }),
    );
    const root = document.createElement("div");
    const visible = createSignal(true);
    const calls: string[] = [];
    const handle = mount(root, module, {
      save: () => calls.push("save"),
      visible,
      label: createSignal("L"),
    });
    const branch = root.querySelector("span");
    if (!branch) throw new Error("Missing branch.");
    registerOwnedSubtree(branch, () => {
      throw new Error("branch cleanup failed");
    });

    expect(() => handle.dispose()).toThrow("branch cleanup failed");

    // The click listener is still released even though the branch cleanup threw.
    root.querySelector("button")?.click();
    expect(calls).toEqual([]);
    expect(() => handle.dispose()).not.toThrow();
  });

  it("rolls back registered cleanups when a later binding fails during bind", () => {
    const module = evaluateGeneratedClientModule(
      generated(`<main><button on:click={save}>x</button><p>{message}</p></main>`, { reactive: true }),
    );
    const root = document.createElement("div");
    const calls: string[] = [];

    expect(() =>
      mount(root, module, {
        save: () => calls.push("save"),
        get message(): string {
          throw new Error("binding failed");
        },
      }),
    ).toThrow("binding failed");

    root.querySelector("button")?.click();
    expect(calls).toEqual([]);
  });
});
