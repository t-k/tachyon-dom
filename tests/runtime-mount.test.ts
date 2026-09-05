import { describe, expect, it } from "vitest";
import { compileTemplate, generateClientModule } from "../src/compiler";
import { hydrate, mount, type ClientTemplateModule } from "../src/runtime/mount";
import { createRoot, createSignal, effect } from "../src/runtime/signal";
import { setText, textAt } from "../src/runtime/text";

const evaluateGeneratedClientModule = (code: string): ClientTemplateModule<{ name: string }> => {
  const executable = code
    .replace(/^import .*$/gm, "")
    .replace(/^export default /m, "return ")
    .replace(/^export const /gm, "const ");
  return new Function(
    "__tachyonCreateRoot",
    "__tachyonSetText",
    "__tachyonTextAt",
    `${executable}; return { templateHtml, hydrationBoundaries, bind };`,
  )(createRoot, setText, textAt) as ClientTemplateModule<{ name: string }>;
};

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
