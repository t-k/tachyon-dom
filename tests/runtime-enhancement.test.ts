import { describe, expect, it } from "vitest";
import { createEnhancementRegistry } from "../src/runtime/enhancement";

describe("progressive enhancement registry", () => {
  it("registers multiple enhancements and initializes each matching element once", () => {
    document.body.innerHTML = `<div id="target" data-td-enhance="alpha beta"></div>`;
    const target = document.querySelector("#target");
    if (!(target instanceof HTMLElement)) {
      throw new Error("Missing target.");
    }
    const calls: string[] = [];
    const registry = createEnhancementRegistry();
    registry.register("alpha", (root) => {
      calls.push(`alpha:${root.id}`);
      root.setAttribute("data-alpha", "ready");
    });
    registry.register("beta", (root) => {
      calls.push(`beta:${root.id}`);
      root.setAttribute("data-beta", "ready");
    });

    expect(registry.enhance(document)).toBe(2);
    expect(registry.enhance(document)).toBe(0);

    expect(calls).toEqual(["alpha:target", "beta:target"]);
    expect(target.dataset.alpha).toBe("ready");
    expect(target.dataset.beta).toBe("ready");
  });

  it("cleans up initialized enhancements for replaced markup", () => {
    document.body.innerHTML = `<section id="root"><div id="target" data-td-enhance="alpha"></div></section>`;
    const root = document.querySelector("#root");
    const target = document.querySelector("#target");
    if (!(root instanceof HTMLElement) || !(target instanceof HTMLElement)) {
      throw new Error("Missing target.");
    }
    const calls: string[] = [];
    const registry = createEnhancementRegistry();
    registry.register("alpha", (element) => {
      calls.push(`init:${element.id}`);
      return () => calls.push(`cleanup:${element.id}`);
    });

    expect(registry.enhance(root)).toBe(1);
    expect(registry.cleanup(root)).toBe(1);
    expect(registry.enhance(root)).toBe(1);

    expect(calls).toEqual(["init:target", "cleanup:target", "init:target"]);
  });
});
