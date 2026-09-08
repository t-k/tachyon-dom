import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { mountConditional } from "../src/runtime/conditional";
import { mountConditionalCore, prepareConditionalCore, preparedNodeAt } from "../src/runtime/conditional-core";
import { createRoot, createSignal, effect } from "../src/runtime/signal";
import { registerOwnedSubtree } from "../src/runtime/subtree";

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

  // The compatibility entry is the one that still interprets expression strings and applies them through the
  // setters this runtime imports. Splitting the generated entry off left that half reachable only from here, so
  // every kind it has to drive is exercised through a hand-written descriptor.
  it("drives every binding kind from a hand-written descriptor", () => {
    document.body.innerHTML = `<section><!----></section>`;
    const root = document.querySelector("section");
    if (!(root instanceof HTMLElement)) throw new Error("Missing root.");
    const scope = {
      on: true,
      title: "Panel",
      width: "12px",
      draft: "typed",
      panel: {} as { node?: Element },
      rows: [{ id: "a", label: "A" }],
    };

    const descriptor = {
      signature: "every-kind",
      templateHtml: `<div><input><ul><!--tachyon-list--></ul></div>`,
      bindings: [
        { kind: "class" as const, path: [], className: "on", expression: "on" },
        { kind: "attr" as const, path: [], name: "title", expression: "title" },
        { kind: "style" as const, path: [], name: "width", expression: "width" },
        { kind: "ref" as const, path: [], expression: "panel.node" },
        { kind: "model" as const, path: [0], property: "value" as const, expression: "draft" },
        {
          kind: "list" as const,
          path: [1],
          each: "rows",
          key: "row.id",
          itemName: "row",
          templateHtml: `<li> </li>`,
          bindings: [{ kind: "text" as const, path: [0], expression: "row.label" }],
        },
      ],
    };
    mountConditional(root, [0], true, scope, descriptor);

    const panel = root.querySelector("div");
    const input = root.querySelector("input");
    if (!(panel instanceof HTMLElement) || !(input instanceof HTMLInputElement)) throw new Error("Missing nodes.");
    expect(panel.classList.contains("on")).toBe(true);
    expect(panel.getAttribute("title")).toBe("Panel");
    expect(panel.style.width).toBe("12px");
    expect(scope.panel.node).toBe(panel);
    expect(input.value).toBe("typed");
    expect(root.querySelector("li")?.textContent).toBe("A");

    // The control writes back through the same path string it reads.
    input.value = "edited";
    input.dispatchEvent(new Event("input"));
    expect(scope.draft).toBe("edited");

    // And a re-mount pushes a value changed elsewhere back onto the control.
    scope.draft = "reset";
    mountConditional(root, [0], true, scope, descriptor);
    expect(input.value).toBe("reset");

    mountConditional(root, [0], false, scope, { signature: "every-kind", templateHtml: `<div></div>`, bindings: [] });
    expect(scope.panel.node).toBeUndefined();
  });

  // A hand-written descriptor may carry the compiler's container reader instead of a path string, and the
  // compatibility entry has to prefer it exactly the way the generated one does.
  it("writes a hand-written ref through a container reader when it carries one", () => {
    document.body.innerHTML = `<section><!----></section>`;
    const root = document.querySelector("section");
    if (!(root instanceof HTMLElement)) throw new Error("Missing root.");
    const scope = { refs: {} as { panel?: Element }, other: {} as { panel?: Element } };
    const options = {
      signature: "reader-ref",
      templateHtml: `<div></div>`,
      bindings: [
        {
          kind: "ref" as const,
          path: [],
          expression: "other.panel",
          owner: (current: Record<string, unknown>) => current.refs,
          property: "panel",
        },
      ],
    };

    mountConditional(root, [0], true, scope, options);
    expect(scope.refs.panel).toBe(root.querySelector("div"));
    expect(scope.other.panel).toBeUndefined();

    mountConditional(root, [0], false, scope, options);
    expect(scope.refs.panel).toBeUndefined();

    // Half a reader is not a reader: only a descriptor carrying both falls out of the path string.
    for (const half of [
      { owner: (current: Record<string, unknown>) => current.refs },
      { property: "panel" },
    ]) {
      const partial = {
        signature: `half-${Object.keys(half)[0]}`,
        templateHtml: `<div></div>`,
        bindings: [{ kind: "ref" as const, path: [], expression: "other.panel", ...half }],
      };
      mountConditional(root, [0], true, scope, partial);
      expect(scope.other.panel).toBe(root.querySelector("div"));
      expect(scope.refs.panel).toBeUndefined();
      mountConditional(root, [0], false, scope, partial);
      expect(scope.other.panel).toBeUndefined();
    }
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

describe("mountConditionalCore", () => {
  it("shows, hides, and shows a generated text and event branch without duplicate listeners", () => {
    document.body.innerHTML = `<main><!----></main>`;
    const root = document.querySelector("main");
    if (!(root instanceof HTMLElement)) throw new Error("Missing root.");
    const calls: string[] = [];
    const scope = { label: "first", save: () => calls.push("save") };
    const options = {
      signature: "core-event-text",
      templateHtml: `<button> </button>`,
      bindings: [
        { kind: "event" as const, path: [], eventName: "click", handler: "save" },
        { kind: "text" as const, path: [0], expression: "label" },
      ],
    };

    mountConditionalCore(root, [0], true, scope, options);
    const firstButton = root.querySelector("button");
    firstButton?.click();
    scope.label = "second";
    mountConditionalCore(root, [0], true, scope, options);
    expect(root.querySelector("button")?.textContent).toBe("second");
    registerOwnedSubtree(firstButton as HTMLButtonElement, () => {
      throw new Error("core cleanup failed");
    });
    expect(() => mountConditionalCore(root, [0], false, scope, options)).toThrow("core cleanup failed");
    expect(root.querySelector("button")).toBeNull();
    expect(() => mountConditionalCore(root, [0], false, scope, options)).not.toThrow();
    root.querySelector("button")?.click();
    mountConditionalCore(root, [0], true, scope, options);
    root.querySelector("button")?.click();

    expect(calls).toEqual(["save", "save"]);
  });

  // Direct callers skip prepareConditionalCore, so every later logical path has to be corrected by the regions
  // that earlier conditionals already occupy in the live DOM.
  it("resolves later logical paths after an earlier branch adopts several server nodes", () => {
    document.body.innerHTML = `<main><span>a</span><b>c</b><i>d</i><p>x</p></main>`;
    const root = document.querySelector("main");
    if (!(root instanceof HTMLElement)) throw new Error("Missing root.");
    const serverSpan = root.querySelector("span");
    const serverBold = root.querySelector("b");
    const serverItalic = root.querySelector("i");
    const serverParagraph = root.querySelector("p");
    const first = { signature: "first", templateHtml: `<span>a</span>`, bindings: [] };
    const second = { signature: "second", templateHtml: `<b>c</b><i>d</i>`, bindings: [] };

    mountConditionalCore(root, [0], true, {}, first);
    mountConditionalCore(root, [1], true, {}, second);

    expect(root.querySelector("span")).toBe(serverSpan);
    expect(root.querySelector("b")).toBe(serverBold);
    expect(root.querySelector("i")).toBe(serverItalic);
    expect(root.querySelector("p")).toBe(serverParagraph);
    expect(root.textContent).toBe("acdx");

    mountConditionalCore(root, [1], false, {}, second);
    expect(root.querySelector("b")).toBeNull();
    expect(root.querySelector("i")).toBeNull();
    expect(root.querySelector("span")).toBe(serverSpan);
    expect(root.querySelector("p")).toBe(serverParagraph);

    mountConditionalCore(root, [1], true, {}, second);
    expect(root.textContent).toBe("acdx");
    expect(root.querySelector("b")).not.toBe(serverBold);
  });

  it("resolves a later logical path once an earlier branch is hidden", () => {
    document.body.innerHTML = `<main><span>a</span><b>c</b><p>x</p></main>`;
    const root = document.querySelector("main");
    if (!(root instanceof HTMLElement)) throw new Error("Missing root.");
    const serverBold = root.querySelector("b");
    const first = { signature: "first", templateHtml: `<span>a</span>`, bindings: [] };
    const second = { signature: "second", templateHtml: `<b>c</b>`, bindings: [] };

    mountConditionalCore(root, [0], false, {}, first);
    expect(root.querySelector("span")).toBeNull();

    mountConditionalCore(root, [1], true, {}, second);

    expect(root.querySelector("b")).toBe(serverBold);
    expect(root.textContent).toBe("cx");
  });

  it("resolves a nested logical path inside an adopted server branch", () => {
    document.body.innerHTML = `<main><section><em>k</em><u>n</u></section></main>`;
    const root = document.querySelector("main");
    if (!(root instanceof HTMLElement)) throw new Error("Missing root.");
    const serverEmphasis = root.querySelector("em");
    const serverUnderline = root.querySelector("u");
    const outer = { signature: "outer", templateHtml: `<section><em>k</em><u>n</u></section>`, bindings: [] };
    const inner = { signature: "inner", templateHtml: `<em>k</em>`, bindings: [] };

    mountConditionalCore(root, [0], true, {}, outer);
    mountConditionalCore(root, [0, 0], true, {}, inner);

    expect(root.querySelector("em")).toBe(serverEmphasis);
    expect(root.querySelector("u")).toBe(serverUnderline);
    expect(root.textContent).toBe("kn");

    mountConditionalCore(root, [0, 0], false, {}, inner);
    expect(root.querySelector("em")).toBeNull();
    expect(root.querySelector("u")).toBe(serverUnderline);
  });

  it("keeps a later client placeholder for its own conditional", () => {
    document.body.innerHTML = `<main><!----><!----><p>tail</p></main>`;
    const root = document.querySelector("main");
    if (!(root instanceof HTMLElement)) throw new Error("Missing root.");
    const tail = root.querySelector("p");
    const first = { signature: "first", templateHtml: `<span>a</span>`, bindings: [] };
    const second = { signature: "second", templateHtml: `<b>c</b>`, bindings: [] };

    mountConditionalCore(root, [0], true, {}, first);
    mountConditionalCore(root, [1], true, {}, second);

    expect(root.textContent).toBe("actail");
    expect(root.querySelector("p")).toBe(tail);
    expect(root.querySelector("span")?.nextSibling?.nodeType).toBe(Node.COMMENT_NODE);

    mountConditionalCore(root, [0], false, {}, first);
    mountConditionalCore(root, [1], false, {}, second);
    expect(root.textContent).toBe("tail");
    mountConditionalCore(root, [1], true, {}, second);
    expect(root.textContent).toBe("ctail");
  });
});

describe("prepareConditionalCore", () => {
  const branch = `<span>a</span>`;
  const options = { signature: "prepared", templateHtml: branch, bindings: [] };
  const descriptors = [{ path: [0], visible: true, templateHtml: branch }];

  it("resolves later binding paths past an adopted server branch", () => {
    document.body.innerHTML = `<main><span>a</span><p>tail</p></main>`;
    const root = document.querySelector("main");
    if (!(root instanceof HTMLElement)) throw new Error("Missing root.");
    const tail = root.querySelector("p");

    prepareConditionalCore(root, descriptors);
    expect(preparedNodeAt(root, [1])).toBe(tail);

    mountConditionalCore(root, [0], true, {}, options);
    expect(preparedNodeAt(root, [1])).toBe(tail);

    mountConditionalCore(root, [0], false, {}, options);
    expect(preparedNodeAt(root, [1])).toBe(tail);
  });

  it("reuses the same anchor and DOM when a root is prepared twice", () => {
    document.body.innerHTML = `<main><span>a</span><p>tail</p></main>`;
    const root = document.querySelector("main");
    if (!(root instanceof HTMLElement)) throw new Error("Missing root.");
    const tail = root.querySelector("p");
    const serverSpan = root.querySelector("span");

    prepareConditionalCore(root, descriptors);
    const markupAfterFirstPrepare = root.innerHTML;
    prepareConditionalCore(root, descriptors);

    expect(root.innerHTML).toBe(markupAfterFirstPrepare);
    mountConditionalCore(root, [0], true, {}, options);
    expect(root.querySelector("span")).toBe(serverSpan);
    expect(preparedNodeAt(root, [1])).toBe(tail);
  });

  it("restores a hidden branch when the same root is prepared and mounted again", () => {
    document.body.innerHTML = `<main><span>a</span><p>tail</p></main>`;
    const root = document.querySelector("main");
    if (!(root instanceof HTMLElement)) throw new Error("Missing root.");
    const tail = root.querySelector("p");

    prepareConditionalCore(root, descriptors);
    mountConditionalCore(root, [0], true, {}, options);
    mountConditionalCore(root, [0], false, {}, options);
    expect(root.querySelector("span")).toBeNull();

    prepareConditionalCore(root, descriptors);
    mountConditionalCore(root, [0], true, {}, options);

    expect(root.querySelector("span")?.textContent).toBe("a");
    expect(root.querySelector("p")).toBe(tail);
    expect(root.textContent).toBe("atail");
    expect(preparedNodeAt(root, [1])).toBe(tail);
  });

  it("marks a descriptor invalid when its declared parent tag does not match", () => {
    document.body.innerHTML = `<main><span>a</span><p>tail</p></main>`;
    const root = document.querySelector("main");
    if (!(root instanceof HTMLElement)) throw new Error("Missing root.");
    const markup = root.innerHTML;

    prepareConditionalCore(root, [{ ...descriptors[0]!, parentTagName: "section" }]);

    expect(root.innerHTML).toBe(markup);
    expect(() => preparedNodeAt(root, [0])).toThrow(/Cannot resolve generated binding path/);
    mountConditionalCore(root, [0], true, {}, options);
    expect(root.innerHTML).toBe(markup);
  });

  it("resolves binding paths that pass through a mounted branch and skips hidden ones", () => {
    document.body.innerHTML = `<main><section><em>k</em><u>n</u></section><p>tail</p></main>`;
    const root = document.querySelector("main");
    if (!(root instanceof HTMLElement)) throw new Error("Missing root.");
    const serverSection = root.querySelector("section");
    const serverUnderline = root.querySelector("u");
    const tail = root.querySelector("p");
    const outer = { signature: "outer", templateHtml: `<section><em>k</em><u>n</u></section>`, bindings: [] };

    prepareConditionalCore(root, [{ path: [0], visible: true, templateHtml: outer.templateHtml }]);
    mountConditionalCore(root, [0], true, {}, outer);

    // A path that ends on a conditional slot resolves to the region's anchor; deeper paths step into the branch.
    expect(preparedNodeAt(root, [0]).nodeType).toBe(Node.COMMENT_NODE);
    expect(preparedNodeAt(root, [0, 0]).parentNode).toBe(serverSection);
    expect(preparedNodeAt(root, [0, 1])).toBe(serverUnderline);
    expect(preparedNodeAt(root, [1])).toBe(tail);

    mountConditionalCore(root, [0], false, {}, outer);

    expect(() => preparedNodeAt(root, [0, 1])).toThrow(/Missing generated binding node/);
    expect(preparedNodeAt(root, [1])).toBe(tail);
    // A conditional inside a hidden region has nowhere to mount, so it must be a no-op rather than a crash.
    expect(() =>
      mountConditionalCore(root, [0, 0], true, {}, { signature: "inner", templateHtml: `<em>k</em>`, bindings: [] }),
    ).not.toThrow();
    expect(root.textContent).toBe("tail");
  });

  it("orders nested descriptors by depth regardless of the order they are declared", () => {
    document.body.innerHTML = `<main><section><em>k</em></section><p>tail</p></main>`;
    const root = document.querySelector("main");
    if (!(root instanceof HTMLElement)) throw new Error("Missing root.");
    const serverSection = root.querySelector("section");
    const serverEmphasis = root.querySelector("em");
    const tail = root.querySelector("p");
    const outer = { signature: "outer", templateHtml: `<section><em>k</em></section>`, bindings: [] };
    const inner = { signature: "inner", templateHtml: `<em>k</em>`, bindings: [] };

    prepareConditionalCore(root, [
      { path: [0, 0], visible: true, templateHtml: inner.templateHtml },
      { path: [0], visible: true, templateHtml: outer.templateHtml },
    ]);
    mountConditionalCore(root, [0], true, {}, outer);
    mountConditionalCore(root, [0, 0], true, {}, inner);

    expect(root.querySelector("section")).toBe(serverSection);
    expect(root.querySelector("em")).toBe(serverEmphasis);
    expect(preparedNodeAt(root, [1])).toBe(tail);

    mountConditionalCore(root, [0, 0], false, {}, inner);
    expect(root.querySelector("em")).toBeNull();
    expect(root.querySelector("section")).toBe(serverSection);
    expect(preparedNodeAt(root, [1])).toBe(tail);
  });

  it("treats an empty path as the root's own slot in its parent", () => {
    document.body.innerHTML = `<div><section>content</section><p>tail</p></div>`;
    const host = document.querySelector("div");
    const root = document.querySelector("section");
    if (!(host instanceof HTMLElement) || !(root instanceof HTMLElement)) throw new Error("Missing root.");
    const tail = host.querySelector("p");
    const options = { signature: "root-slot", templateHtml: `<section>content</section>`, bindings: [] };

    mountConditionalCore(root, [], true, {}, options);
    expect(host.querySelector("section")).toBe(root);

    mountConditionalCore(root, [], false, {}, options);
    expect(host.querySelector("section")).toBeNull();
    expect(host.querySelector("p")).toBe(tail);

    mountConditionalCore(root, [], true, {}, options);
    expect(host.querySelector("section")?.textContent).toBe("content");
    expect(host.querySelector("p")).toBe(tail);
    expect(host.textContent).toBe("contenttail");
  });

  it("resolves a third-level conditional that follows a sibling conditional", () => {
    document.body.innerHTML = `<main><section><div><b>x</b><i>y</i></div></section></main>`;
    const root = document.querySelector("main");
    if (!(root instanceof HTMLElement)) throw new Error("Missing root.");
    const serverBold = root.querySelector("b");
    const serverItalic = root.querySelector("i");
    const first = { signature: "first", templateHtml: `<b>x</b>`, bindings: [] };
    const second = { signature: "second", templateHtml: `<i>y</i>`, bindings: [] };

    mountConditionalCore(root, [0, 0, 0], true, {}, first);
    mountConditionalCore(root, [0, 0, 1], true, {}, second);

    expect(root.querySelector("b")).toBe(serverBold);
    expect(root.querySelector("i")).toBe(serverItalic);
    expect(root.textContent).toBe("xy");

    mountConditionalCore(root, [0, 0, 0], false, {}, first);
    expect(root.querySelector("b")).toBeNull();
    expect(root.querySelector("i")).toBe(serverItalic);

    mountConditionalCore(root, [0, 0, 1], false, {}, second);
    expect(root.textContent).toBe("");
  });

  // The retention fix removes the root-keyed map of every initial node. Reintroducing one would make a hidden
  // branch reachable from a live root again, which jsdom cannot observe; see docs.local 067-evaluation.
  it("keeps no root-scoped snapshot of the initial nodes", async () => {
    const source = await readFile("src/runtime/conditional-core.ts", "utf8");

    expect([...source.matchAll(/const (\w+) = new WeakMap<Node,/g)].map((match) => match[1])).toEqual([
      "anchorsByRoot",
      "preparedPathPlans",
    ]);
    expect(source).not.toMatch(/initialSnapshots|snapshotNodes/);
  });
});
