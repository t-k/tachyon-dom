import { describe, expect, it, vi } from "vitest";
import { mountConditional } from "../src/runtime/conditional";
import { createRoot, createSignal, effect } from "../src/runtime/signal";

describe("mountConditional", () => {
  it("clears and replaces refs when conditional content is unmounted", () => {
    document.body.innerHTML = `<section><!----></section>`;
    const root = document.querySelector("section");
    if (!(root instanceof HTMLElement)) throw new Error("Missing root.");
    const scope = { refs: {} as { panel?: Element } };
    const options = {
      templateHtml: `<div></div>`,
      bindings: [{ kind: "ref" as const, path: [], expression: "refs.panel" }],
    };

    mountConditional(root, [0], true, scope, options);
    const first = scope.refs.panel;
    expect(first).toBe(root.querySelector("div"));
    mountConditional(root, [0], false, scope, options);
    expect(scope.refs.panel).toBeUndefined();

    mountConditional(root, [0], true, scope, options);
    expect(scope.refs.panel).toBe(root.querySelector("div"));
    expect(scope.refs.panel).not.toBe(first);
  });

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

  it("owns conditional-local stores and component props without copying them from the parent", () => {
    document.body.innerHTML = `<section><!----></section>`;
    const root = document.querySelector("section");
    if (!(root instanceof HTMLElement)) throw new Error("Missing root.");
    const scope = { initial: 3, count: 99, title: "Parent" };
    const options = {
      templateHtml: `<article><span> </span><strong> </strong></article>`,
      stores: [{ name: "count", initial: "initial" }],
      components: [
        {
          path: [],
          name: "Panel",
          props: [{ name: "title", expression: "title" }],
          stores: [],
        },
      ],
      bindings: [
        { kind: "text" as const, path: [0, 0], expression: "count" },
        { kind: "text" as const, path: [1, 0], expression: "title" },
      ],
    };

    mountConditional(root, [0], true, scope, options);
    scope.count = 7;
    scope.title = "Changed";
    mountConditional(root, [0], true, scope, options);

    expect(root.textContent).toBe("3Parent");
  });

  it("defers conditional boundary bindings, replays interaction, and disposes them on hide", async () => {
    document.body.innerHTML = `<section><!----></section>`;
    const root = document.querySelector("section");
    if (!(root instanceof HTMLElement)) throw new Error("Missing root.");
    const calls: string[] = [];
    const scope = { save: () => calls.push("save") };
    const options = {
      templateHtml: `<!--tachyon-hydrate:panel:start--><button>Save</button><!--tachyon-hydrate:panel:end-->`,
      hydrationBoundaries: [{ id: "panel", idKind: "static" as const, path: [] }],
      bindings: [{ kind: "event" as const, path: [1], eventName: "click", handler: "save" }],
    };

    mountConditional(root, [0], true, scope, options);
    const button = root.querySelector("button");
    button?.click();
    await Promise.resolve();

    expect(calls).toEqual(["save"]);
    mountConditional(root, [0], false, scope, options);
    button?.click();
    expect(calls).toEqual(["save"]);
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

  it("cleans old DOM and listeners when a visible signature changes", () => {
    document.body.innerHTML = `<section><!----></section>`;
    const root = document.querySelector("section");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing root.");
    }
    const oldHandler = vi.fn();

    mountConditional(
      root,
      [0],
      true,
      { oldHandler },
      {
        signature: "old",
        templateHtml: `<button>Old</button>`,
        bindings: [{ kind: "event", path: [], eventName: "click", handler: "oldHandler" }],
      },
    );
    const oldButton = root.querySelector("button");
    mountConditional(
      root,
      [0],
      true,
      {},
      {
        signature: "new",
        templateHtml: `<span>New</span>`,
        bindings: [],
      },
    );
    oldButton?.click();

    expect(root.innerHTML).toBe(`<!----><span>New</span>`);
    expect(oldButton?.isConnected).toBe(false);
    expect(oldHandler).not.toHaveBeenCalled();
  });

  it("resolves bindings from every root in multi-root conditional content", () => {
    document.body.innerHTML = `<main><!----></main>`;
    const root = document.querySelector("main");
    if (!(root instanceof HTMLElement)) throw new Error("Missing root.");

    mountConditional(
      root,
      [0],
      true,
      { message: "Ready", nested: true },
      {
        templateHtml: `<h2>Heading</h2><section><span> </span><!----></section>`,
        bindings: [
          { kind: "text", path: [1, 0, 0], expression: "message" },
          { kind: "if", path: [1, 1], test: "nested", templateHtml: `<em>nested</em>`, bindings: [] },
        ],
      },
    );

    expect(root.innerHTML).toBe(`<!----><h2>Heading</h2><section><span>Ready</span><!----><em>nested</em></section>`);
  });

  it("disposes nested list effects on hide and rebuilds one live list on show", () => {
    document.body.innerHTML = `<section><!----></section>`;
    const root = document.querySelector("section");
    if (!(root instanceof HTMLElement)) throw new Error("Missing root.");
    const label = createSignal("A");
    let reads = 0;
    const scope = { rows: [{ id: 1, label }] };
    const options = {
      signature: "conditional-with-owned-list",
      templateHtml: `<ul></ul>`,
      bindings: [
        {
          kind: "list" as const,
          signature: "owned-list",
          path: [],
          each: "rows",
          key: "row.id",
          itemName: "row",
          templateHtml: `<li> </li>`,
          bindings: [
            {
              kind: "text" as const,
              path: [0],
              expression: "row.label()",
              read: (localScope: Record<string, unknown>) => {
                reads += 1;
                return (localScope.row as { label: () => string }).label();
              },
            },
          ],
        },
      ],
    };

    mountConditional(root, [0], true, scope, options);
    reads = 0;
    mountConditional(root, [0], false, scope, options);
    label.set("B");
    expect(reads).toBe(0);

    for (let iteration = 0; iteration < 5; iteration += 1) {
      mountConditional(root, [0], true, scope, options);
      mountConditional(root, [0], false, scope, options);
    }
    mountConditional(root, [0], true, scope, options);
    expect(root.querySelector("li")?.textContent).toBe("B");
    reads = 0;
    label.set("C");
    expect(reads).toBe(1);
    expect(root.querySelector("li")?.textContent).toBe("C");
  });

  it("disposes effects through alternating conditional and list ownership levels", () => {
    document.body.innerHTML = `<main><!----></main>`;
    const root = document.querySelector("main");
    if (!(root instanceof HTMLElement)) throw new Error("Missing root.");
    const label = createSignal("deep");
    let deepestReads = 0;
    const scope = {
      groups: [{ id: 1, visible: true, children: [{ id: 2, label }] }],
    };
    const options = {
      signature: "deep-conditional-owner",
      templateHtml: `<section><ul></ul></section>`,
      bindings: [
        {
          kind: "list" as const,
          signature: "deep-group-list",
          path: [0],
          each: "groups",
          key: "group.id",
          itemName: "group",
          templateHtml: `<li><!----></li>`,
          bindings: [
            {
              kind: "if" as const,
              signature: "deep-row-conditional",
              path: [0],
              test: "group.visible",
              templateHtml: `<div><ul></ul></div>`,
              bindings: [
                {
                  kind: "list" as const,
                  signature: "deep-child-list",
                  path: [0],
                  each: "group.children",
                  key: "child.id",
                  itemName: "child",
                  templateHtml: `<li> </li>`,
                  bindings: [
                    {
                      kind: "text" as const,
                      path: [0],
                      expression: "child.label()",
                      read: (localScope: Record<string, unknown>) => {
                        deepestReads += 1;
                        return (localScope.child as { label: () => string }).label();
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    mountConditional(root, [0], true, scope, options);
    expect(root.querySelector("div li")?.textContent).toBe("deep");
    deepestReads = 0;
    mountConditional(root, [0], false, scope, options);
    label.set("detached");

    expect(deepestReads).toBe(0);
    expect(root.querySelector("section")).toBeNull();
  });

  it("removes delayed conditional content when its outer root is disposed", () => {
    document.body.innerHTML = `<main><!----></main>`;
    const root = document.querySelector("main");
    if (!(root instanceof HTMLElement)) throw new Error("Missing root.");
    const visible = createSignal(false);
    const scope = {};
    const dispose = createRoot((disposeRoot) => {
      effect(() => {
        mountConditional(root, [0], visible(), scope, {
          signature: "delayed-owner",
          templateHtml: `<div>ready</div>`,
          bindings: [],
        });
      });
      return disposeRoot;
    });

    visible.set(true);
    expect(root.querySelector("div")).not.toBeNull();
    dispose();

    expect(root.innerHTML).toBe(`<!---->`);
  });
});
