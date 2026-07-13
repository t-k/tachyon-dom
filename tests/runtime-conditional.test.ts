import { describe, expect, it, vi } from "vitest";
import { mountConditional } from "../src/runtime/conditional";

describe("mountConditional", () => {
  it("mounts, updates, and unmounts conditional content at a comment anchor", () => {
    document.body.innerHTML = `<section><!----></section>`;
    const root = document.querySelector("section");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing root.");
    }
    const scope = {
      count: 1,
      increment: vi.fn(),
    };

    mountConditional(root, [0], true, scope, {
      templateHtml: `<button> </button>`,
      bindings: [
        { kind: "event", path: [], eventName: "click", handler: "increment" },
        { kind: "text", path: [0], expression: "count" },
      ],
    });

    const button = root.querySelector("button");
    expect(button?.textContent).toBe("1");
    button?.click();
    expect(scope.increment).toHaveBeenCalledTimes(1);

    scope.count = 2;
    mountConditional(root, [0], true, scope, {
      templateHtml: `<button> </button>`,
      bindings: [
        { kind: "event", path: [], eventName: "click", handler: "increment" },
        { kind: "text", path: [0], expression: "count" },
      ],
    });
    expect(root.querySelector("button")?.textContent).toBe("2");

    mountConditional(root, [0], false, scope, {
      templateHtml: `<button> </button>`,
      bindings: [
        { kind: "event", path: [], eventName: "click", handler: "increment" },
        { kind: "text", path: [0], expression: "count" },
      ],
    });
    expect(root.querySelector("button")).toBeNull();
  });

  it("remounts conditional content after hide and show with the same signature", () => {
    document.body.innerHTML = `<section><!----></section>`;
    const root = document.querySelector("section");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing root.");
    }
    const options = {
      templateHtml: `<span> </span>`,
      bindings: [{ kind: "text" as const, path: [0], expression: "message" }],
    };

    mountConditional(root, [0], true, { message: "Hello" }, options);
    mountConditional(root, [0], false, { message: "Hidden" }, options);
    mountConditional(root, [0], true, { message: "Again" }, options);

    expect(root.querySelector("span")?.textContent).toBe("Again");
  });

  it("uses precomputed signatures and compiled binding accessors", () => {
    document.body.innerHTML = `<section><!----></section>`;
    const root = document.querySelector("section");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing root.");
    }
    const stringify = vi.spyOn(JSON, "stringify");
    const scope = { message: "Hello" };
    const options = {
      signature: "static-conditional",
      templateHtml: `<span> </span>`,
      bindings: [
        {
          kind: "text" as const,
          path: [0],
          expression: "unused.path.that.would.not.resolve",
          read: (localScope: Record<string, unknown>) => localScope.message,
        },
      ],
    };

    mountConditional(root, [0], true, scope, options);
    scope.message = "Again";
    mountConditional(root, [0], true, scope, options);

    expect(root.querySelector("span")?.textContent).toBe("Again");
    expect(stringify).not.toHaveBeenCalled();
    stringify.mockRestore();
  });

  it("keeps event handlers current when a visible conditional is reused", () => {
    document.body.innerHTML = `<section><!----></section>`;
    const root = document.querySelector("section");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing root.");
    }
    const calls: string[] = [];
    const options = {
      signature: "conditional-with-event",
      templateHtml: `<button>Save</button>`,
      bindings: [
        {
          kind: "event" as const,
          path: [],
          eventName: "click",
          handler: "onSave",
          read: (localScope: Record<string, unknown>) => localScope.onSave,
        },
      ],
    };

    mountConditional(root, [0], true, { onSave: () => calls.push("old") }, options);
    mountConditional(root, [0], true, { onSave: () => calls.push("new") }, options);

    root.querySelector("button")?.click();

    expect(calls).toEqual(["new"]);
  });

  it("resolves bindings from every root in multi-root conditional content", () => {
    document.body.innerHTML = `<main><!----></main>`;
    const root = document.querySelector("main");
    if (!(root instanceof HTMLElement)) throw new Error("Missing root.");

    mountConditional(root, [0], true, { message: "Ready", nested: true }, {
      templateHtml: `<h2>Heading</h2><section><span> </span><!----></section>`,
      bindings: [
        { kind: "text", path: [1, 0, 0], expression: "message" },
        { kind: "if", path: [1, 1], test: "nested", templateHtml: `<em>nested</em>`, bindings: [] },
      ],
    });

    expect(root.innerHTML).toBe(
      `<!----><h2>Heading</h2><section><span>Ready</span><!----><em>nested</em></section>`,
    );
  });
});
