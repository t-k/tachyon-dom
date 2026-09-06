import { describe, expect, it, vi } from "vitest";
import { compileTemplate, generateClientModule, renderServerTemplate } from "../src/compiler";
import { hydrate, mount, type ClientTemplateModule } from "../src/runtime/mount";
import { createRoot, createSignal, effect } from "../src/runtime/signal";
import { evaluateGeneratedClientModule } from "./generated-client-module";

describe("client mount entrypoints", () => {
  it("binds generated client modules against the generated template root", () => {
    const compiled = compileTemplate(`<p>{name}</p>`);
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value));
    const root = document.createElement("main");

    mount(root, module, { name: "Alice" });

    expect(root.innerHTML).toBe(`<p>Alice</p>`);
  });

  it("rejects hydration when the existing root structure does not match", () => {
    const compiled = compileTemplate(`<p>{name}</p>`);
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value));
    const root = document.createElement("b");
    root.textContent = "SSR";
    const before = root.outerHTML;

    const result = hydrate(root, module, { name: "Alice" });

    expect(result.ok).toBe(false);
    expect(root.outerHTML).toBe(before);
  });

  it("rejects unexpected hydration attributes and unsafe extra nodes", () => {
    const root = document.createElement("main");
    root.innerHTML = `<p>SSR</p><script>alert(1)</script>`;
    root.setAttribute("onclick", "alert(2)");
    const before = root.outerHTML;
    const module: ClientTemplateModule = {
      templateHtml: `<main><!----><p> </p></main>`,
      bind: () => undefined,
    };

    const result = hydrate(root, module);

    expect(result.ok).toBe(false);
    expect(root.outerHTML).toBe(before);
  });

  it("allows compiler-declared dynamic attributes during hydration", () => {
    const compiled = compileTemplate(`<main><p class:active={active} aria-label={label}>Hello</p></main>`);
    if (!compiled.ok) throw new Error(compiled.error.message);
    const generated = evaluateGeneratedClientModule(generateClientModule(compiled.value));
    const module: ClientTemplateModule = {
      templateHtml: generated.templateHtml,
      hydrationDynamicAttributes: generated.hydrationDynamicAttributes ?? [],
      bind: () => undefined,
    };
    const root = document.createElement("main");
    root.innerHTML = `<p class="active" aria-label="server">Hello</p>`;
    const scope = { name: "ignored", active: true, label: "client" };

    const result = hydrate(root, module, scope);

    expect(result.ok).toBe(true);
    expect(root.querySelector("p")?.getAttribute("aria-label")).toBe("server");
    if (result.ok) result.value.dispose();
  });

  it("hydrates SSR rows around static siblings", () => {
    const compiled = compileTemplate(
      `<ul><for each={items} key={item.id}><li class="row">{item.name}</li></for><li class="footer">Footer</li></ul>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const root = document.createElement("main");
    root.innerHTML = renderServerTemplate(compiled.value, {
      items: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
    });

    const result = hydrate(root, {
      templateHtml: compiled.value.client.templateHtml,
      hydrationDynamicRegions: compiled.value.client.hydrationDynamicRegions,
      bind: () => undefined,
    });

    expect(result.ok).toBe(true);
    expect(root.textContent).toBe("ABFooter");
    if (result.ok) result.value.dispose();
  });

  it("binds a generated list module without consuming static siblings", () => {
    const compiled = compileTemplate(
      `<ul><for each={items} key={item.id}><li class="row">{item.name}</li></for><li class="footer">Footer</li></ul>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value));
    const root = document.createElement("main");
    root.innerHTML = renderServerTemplate(compiled.value, {
      items: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
    });
    const serverRows = Array.from(root.querySelectorAll("li.row"));

    const result = hydrate(root, module, {
      items: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
    });

    expect(result.ok).toBe(true);
    expect(root.innerHTML).toBe(`<ul><li class="row">A</li><li class="row">B</li><li class="footer">Footer</li></ul>`);
    expect(root.querySelectorAll("li.row")[0]).toBe(serverRows[0]);
    expect(root.querySelectorAll("li.row")[1]).toBe(serverRows[1]);
    if (result.ok) result.value.dispose();
  });

  it("executes compiler-generated row store readers on the generic list path", () => {
    const compiled = compileTemplate(
      `<main><ul><for each={rows} key={row.id}><li><store count={row.count}/><span>{count}</span></li></for></ul></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const generated = generateClientModule(compiled.value);
    expect(generated).toContain("mountKeyedList");
    const module = evaluateGeneratedClientModule(generated);
    const root = document.createElement("div");

    mount(root, module, { rows: [{ id: "a", count: 7 }] });

    expect(root.innerHTML).toBe(`<main><ul><li><span>7</span></li></ul></main>`);
  });

  it("executes compiler-generated row component props and stores on the generic list path", () => {
    const compiled = compileTemplate(
      `<main><ul><for each={rows} key={row.id}><component name="Row" label={row.label}><li><store count={row.count}/><span>{label}:{count}</span></li></component></for></ul></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const generated = generateClientModule(compiled.value);
    expect(generated).toContain('components: [{ path: [], name: "Row"');
    const module = evaluateGeneratedClientModule(generated);
    const root = document.createElement("div");

    mount(root, module, { rows: [{ id: "a", label: "A", count: 7 }] });

    expect(root.textContent).toBe("A:7");
  });

  it("rejects mounting a hydrate-only module before touching the DOM and refuses to hydrate a root twice", () => {
    const hydrateOnly = {
      hydrateOnly: true as const,
      templateHtml: "<p></p>",
      hydrate: () => () => undefined,
    };
    const root = document.createElement("div");
    root.innerHTML = "<b>keep</b>";

    expect(() => mount(root, hydrateOnly as never, {})).toThrow(/hydrate-only/);
    expect(root.innerHTML).toBe("<b>keep</b>");

    root.innerHTML = "<p></p>";
    const first = hydrate(root, hydrateOnly, {});
    expect(first.ok).toBe(true);
    const second = hydrate(root, hydrateOnly, {});
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.message).toContain("already hydrated");
    if (first.ok) first.value.dispose();
    const third = hydrate(root, hydrateOnly, {});
    expect(third.ok).toBe(true);
    if (third.ok) third.value.dispose();
  });

  it("runs mount and hydrate cleanups once when the enclosing owner is disposed", () => {
    let mountCleanups = 0;
    let hydrateCleanups = 0;
    const module: ClientTemplateModule<Record<string, unknown>> = {
      templateHtml: "<p></p>",
      bind: () => () => mountCleanups++,
      hydrate: () => () => hydrateCleanups++,
    };
    const mountRoot = document.createElement("div");
    const hydrateRoot = document.createElement("div");
    hydrateRoot.innerHTML = "<p></p>";
    let mounted: ReturnType<typeof mount> | undefined;
    let hydrated: ReturnType<typeof mount> | undefined;
    const stop = createRoot((dispose) => {
      mounted = mount(mountRoot, module, {});
      const result = hydrate(hydrateRoot, module, {});
      if (!result.ok) throw new Error(result.error.message);
      hydrated = result.value;
      return dispose;
    });

    stop();

    expect(mountCleanups).toBe(1);
    expect(hydrateCleanups).toBe(1);
    expect(mounted?.disposed()).toBe(true);
    expect(hydrated?.disposed()).toBe(true);
    mounted?.dispose();
    hydrated?.dispose();
    expect(mountCleanups).toBe(1);
    expect(hydrateCleanups).toBe(1);
  });

  it("creates each declared store once per owner and keeps instances, shadowing, and branches independent", () => {
    const compiled = compileTemplate(
      `<main><store label={seed()}/><p>{label}</p><if test={show}><section><store local={seed()}/><span>{local}</span><input bind:value={local}></section></if><component name="Card" title={label}><article><store local={title}/><b>{local}</b></article></component></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const scopeFor = (name: string, counter: { reads: number }) => {
      const show = createSignal(false);
      const scope = {
        seed: () => {
          counter.reads += 1;
          return name;
        },
        show,
        label: "shadowed by the top-level store",
      };
      return { scope, show };
    };
    const first = { reads: 0 };
    const second = { reads: 0 };
    const firstScope = scopeFor("first", first);
    const secondScope = scopeFor("second", second);
    const firstRoot = document.createElement("div");
    const secondRoot = document.createElement("div");
    document.body.append(firstRoot, secondRoot);

    let stopParent: (() => void) | undefined;
    let firstHandle: ReturnType<typeof mount> | undefined;
    createRoot((dispose) => {
      firstHandle = mount(firstRoot, module, firstScope.scope);
      stopParent = dispose;
    });
    const secondHandle = mount(secondRoot, module, secondScope.scope);

    // Top-level store: initial expression evaluated once per instance and the
    // hidden branch has not initialised its store yet. The component-owned
    // store is created once with its own value.
    expect(first.reads).toBe(1);
    expect(second.reads).toBe(1);
    expect(firstRoot.querySelector("p")?.textContent).toBe("first");
    expect(secondRoot.querySelector("p")?.textContent).toBe("second");
    expect(firstRoot.querySelector("b")?.textContent).toBe("first");
    expect(firstRoot.querySelector("span")).toBeNull();

    firstScope.show.set(true);
    expect(first.reads).toBe(2);
    expect(second.reads).toBe(1);
    const input = firstRoot.querySelector("input");
    if (!(input instanceof HTMLInputElement)) throw new Error("Missing branch input.");
    input.value = "edited";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(firstRoot.querySelector("span")?.textContent).toBe("edited");
    // Shadowing: the branch-local store does not leak into the component's
    // store of the same name, nor into the other instance.
    expect(firstRoot.querySelector("b")?.textContent).toBe("first");
    expect(secondRoot.querySelector("span")).toBeNull();

    firstScope.show.set(false);
    expect(firstRoot.querySelector("span")).toBeNull();
    firstScope.show.set(true);
    // Re-entering the branch creates a fresh store from the initial expression.
    expect(first.reads).toBe(3);
    expect(firstRoot.querySelector("span")?.textContent).toBe("first");

    stopParent?.();
    expect(firstHandle?.disposed()).toBe(true);
    expect(() => firstHandle?.dispose()).not.toThrow();
    firstScope.show.set(false);
    expect(first.reads).toBe(3);
    secondHandle.dispose();
  });

  it("schedules compiler-generated row hydration boundaries and replays one interaction", async () => {
    const compiled = compileTemplate(
      `<main><ul><for each={rows} key={row.id}><li><button hydrate:id={row.id} hydrate:interaction="click" on:click={select}>{row.label}</button></li></for></ul></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value));
    const root = document.createElement("div");
    const select = vi.fn();
    const scope = { rows: [{ id: "a", label: "A" }], select };
    root.innerHTML = renderServerTemplate(compiled.value, scope);
    const button = root.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) throw new Error("Missing row button.");

    const result = hydrate(root, module, scope);
    expect(result.ok).toBe(true);
    button.click();
    await Promise.resolve();

    expect(select).toHaveBeenCalledTimes(1);
    if (result.ok) result.value.dispose();
  });

  it("compares static class tokens while allowing compiler-declared class tokens", () => {
    const compiled = compileTemplate(`<p class="btn" class:active={active}>Hello</p>`);
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module: ClientTemplateModule = {
      templateHtml: compiled.value.client.templateHtml,
      hydrationDynamicAttributes: [{ path: [], name: "class", kind: "token" }],
      bind: () => undefined,
    };
    const root = document.createElement("main");
    root.innerHTML = `<p class="btn active">Hello</p>`;

    const hydrated = hydrate(root, module, { active: true });
    expect(hydrated.ok).toBe(true);
    if (hydrated.ok) hydrated.value.dispose();

    root.innerHTML = `<p class="wrong active">Hello</p>`;
    expect(hydrate(root, module, { active: true }).ok).toBe(false);
  });

  it("rejects unsafe children even when the expected element has no children", () => {
    const root = document.createElement("main");
    root.innerHTML = `<div><script>alert(1)</script></div>`;
    const before = root.outerHTML;

    const result = hydrate(root, { templateHtml: `<div></div>`, bind: () => undefined });

    expect(result.ok).toBe(false);
    expect(root.outerHTML).toBe(before);
  });

  it("mounts independent instances and disposes each one once", () => {
    const first = document.createElement("main");
    const second = document.createElement("main");
    const disposed: string[] = [];
    const module: ClientTemplateModule<{ name: string }> = {
      templateHtml: `<p></p>`,
      bind: (root, scope) => {
        root.textContent = scope.name;
        return () => disposed.push(scope.name);
      },
    };

    const firstHandle = mount(first, module, { name: "first" });
    const secondHandle = mount(second, module, { name: "second" });
    firstHandle.dispose();
    firstHandle.dispose();

    expect(first.textContent).toBe("first");
    expect(second.textContent).toBe("second");
    expect(disposed).toEqual(["first"]);
    secondHandle.dispose();
    expect(disposed).toEqual(["first", "second"]);
  });

  it("rolls back the original DOM when bind initialization fails", () => {
    const root = document.createElement("main");
    root.innerHTML = `<p>original</p>`;
    const original = root.firstChild;
    const module: ClientTemplateModule = {
      templateHtml: `<p>next</p>`,
      bind: () => {
        throw new Error("bind failed");
      },
    };

    expect(() => mount(root, module)).toThrow("bind failed");
    expect(root.firstChild).toBe(original);
    expect(root.textContent).toBe("original");
  });

  it("hydrates existing marked DOM and reports marker mismatch without replacing it", () => {
    const root = document.createElement("main");
    root.innerHTML = `<!--tachyon-hydrate:panel:start--><section>SSR</section><!--tachyon-hydrate:panel:end-->`;
    const before = root.innerHTML;
    const module: ClientTemplateModule = {
      templateHtml: `<section>client</section>`,
      hydrationBoundaries: [{ id: "panel", idKind: "static" }],
      bind: (element) => {
        element.setAttribute("data-bound", "yes");
      },
    };

    const hydrated = hydrate(root, module);
    expect(hydrated.ok).toBe(true);
    expect(root.innerHTML).toContain(`data-bound="yes"`);
    expect(root.innerHTML).not.toBe(before);
    if (hydrated.ok) hydrated.value.dispose();

    const broken = hydrate(root, { ...module, hydrationBoundaries: [{ id: "missing", idKind: "static" }] });
    expect(broken.ok).toBe(false);
    expect(root.innerHTML).toContain(`data-bound="yes"`);
  });

  it("accepts a legacy bind that does not return a cleanup", () => {
    const root = document.createElement("main");
    const handle = mount(root, { templateHtml: `<p>legacy</p>`, bind: () => undefined });

    expect(() => handle.dispose()).not.toThrow();
    expect(() => handle.dispose()).not.toThrow();
  });

  it("cleans resources created before a mount bind failure", () => {
    const root = document.createElement("main");
    const source = createSignal(0);
    let runs = 0;
    const module: ClientTemplateModule = {
      templateHtml: `<p>next</p>`,
      bind: () => {
        effect(() => {
          source();
          runs++;
        });
        throw new Error("bind failed after setup");
      },
    };

    expect(() => mount(root, module)).toThrow("bind failed after setup");
    source.set(1);

    expect(runs).toBe(1);
  });

  it("cleans resources created before a hydrate bind failure", () => {
    const root = document.createElement("main");
    root.innerHTML = `<p>SSR</p>`;
    const source = createSignal(0);
    let runs = 0;
    const module: ClientTemplateModule = {
      templateHtml: `<p>client</p>`,
      bind: () => {
        effect(() => {
          source();
          runs++;
        });
        throw new Error("hydrate failed after setup");
      },
    };

    const result = hydrate(root, module);
    source.set(1);

    expect(result.ok).toBe(false);
    expect(runs).toBe(1);
  });
});
