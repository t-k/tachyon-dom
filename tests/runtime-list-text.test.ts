import { afterEach, describe, expect, it } from "vitest";
import { cleanupTextKeyedList, mountGeneratedTextKeyedList, mountTextKeyedList } from "../src/runtime/list-text";
import { createSignal, effect, onCleanup } from "../src/runtime/signal";

const warn = console.warn;

afterEach(() => {
  console.warn = warn;
});

describe("mountTextKeyedList", () => {
  it("reconciles compiler-generated rows through the mandatory reader contract", () => {
    const root = document.createElement("ul");
    const options = {
      signature: "generated-reader-contract",
      key: "row.id",
      keyReadItem: (item: unknown) => (item as { id: string }).id,
      itemName: "row",
      scope: {},
      templateHtml: `<li><span> </span></li>`,
      bindings: [
        {
          kind: "text" as const,
          path: [0, 0],
          expression: "row.label",
          read: (scope: Record<string, unknown>) => (scope.row as { label: string }).label,
        },
      ],
    };

    mountGeneratedTextKeyedList(root, [], [{ id: "a", label: "A" }], options);
    const row = root.firstElementChild;
    mountGeneratedTextKeyedList(
      root,
      [],
      [
        { id: "a", label: "B" },
        { id: "b", label: "C" },
      ],
      options,
    );

    expect(root.textContent).toBe("BC");
    expect(root.firstElementChild).toBe(row);
  });

  it("cleans the previous generated descriptor when its signature changes", () => {
    const root = document.createElement("ul");
    const oldLabel = createSignal("Old");
    let oldReads = 0;
    const oldOptions = {
      signature: "generated-descriptor-old",
      key: "row.id",
      keyReadItem: (item: unknown) => (item as { id: string }).id,
      itemName: "row",
      templateHtml: `<li><span> </span></li>`,
      bindings: [
        {
          kind: "text" as const,
          path: [0, 0],
          expression: "row.label()",
          read: (scope: Record<string, unknown>) => {
            oldReads++;
            return (scope.row as { label: () => string }).label();
          },
        },
      ],
    };

    mountGeneratedTextKeyedList(root, [], [{ id: "old", label: oldLabel }], oldOptions);
    const oldRow = root.firstElementChild;
    const readsBeforeSignatureChange = oldReads;

    const newLabel = createSignal("New");
    const newOptions = {
      signature: "generated-descriptor-new",
      key: "row.id",
      keyReadItem: (item: unknown) => (item as { id: string }).id,
      itemName: "row",
      templateHtml: `<li><span>static</span><strong> </strong></li>`,
      bindings: [
        {
          kind: "text" as const,
          path: [1, 0],
          expression: "row.label()",
          read: (scope: Record<string, unknown>) => (scope.row as { label: () => string }).label(),
        },
      ],
    };

    expect(oldOptions.signature).not.toBe(newOptions.signature);
    expect(oldOptions.templateHtml).not.toBe(newOptions.templateHtml);
    expect(oldOptions.bindings[0]?.path).not.toEqual(newOptions.bindings[0]?.path);
    mountGeneratedTextKeyedList(root, [], [{ id: "new", label: newLabel }], newOptions);

    expect(oldRow?.isConnected).toBe(false);
    expect(root.innerHTML).toBe(`<li><span>static</span><strong>New</strong></li>`);
    oldLabel.set("Ignored");
    expect(oldReads).toBe(readsBeforeSignatureChange);
    newLabel.set("Updated");
    expect(root.textContent).toBe("staticUpdated");
    cleanupTextKeyedList(root, []);
  });

  it("exposes an explicit row index while reusing keyed records", () => {
    document.body.innerHTML = `<ul id="items"></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) throw new Error("Missing test root.");
    const options = {
      key: "entry.id",
      itemName: "entry",
      indexName: "position",
      templateHtml: `<li><span> </span></li>`,
      bindings: [
        {
          kind: "text" as const,
          path: [0, 0],
          expression: "position",
          read: (scope: Record<string, unknown>) => scope.position,
        },
      ],
    };

    mountTextKeyedList(root, [], [{ id: "a" }, { id: "b" }], options);
    mountTextKeyedList(root, [], [{ id: "b" }, { id: "a" }], options);

    expect(root.textContent).toBe("01");
  });

  it("refreshes a reference-policy row when the same source scope mutates", () => {
    const root = document.createElement("ul");
    const scope = { label: "A" };
    const options = {
      key: "item.id",
      itemName: "item",
      updatePolicy: "reference" as const,
      scope,
      templateHtml: `<li> </li>`,
      bindings: [{ kind: "text" as const, path: [0], expression: "label" }],
    };

    mountTextKeyedList(root, [], [{ id: "a" }], options);
    scope.label = "B";
    mountTextKeyedList(root, [], [{ id: "a" }], options);

    expect(root.textContent).toBe("B");
  });

  it("continues removing every text row after one cleanup throws", () => {
    const root = document.createElement("ul");
    const cleaned: number[] = [];
    const options = {
      key: "row.id",
      keyReadItem: (item: unknown) => (item as { id: number }).id,
      itemName: "row",
      templateHtml: `<li> </li>`,
      bindings: [
        {
          kind: "text" as const,
          path: [0],
          expression: "row.id",
          read: (scope: Record<string, unknown>) => {
            const id = (scope.row as { id: number }).id;
            onCleanup(() => {
              cleaned.push(id);
              if (id === 1) throw new Error("text row cleanup failed");
            });
            return id;
          },
        },
      ],
    };

    mountTextKeyedList(root, [], [{ id: 1 }, { id: 2 }], options);

    expect(() => mountTextKeyedList(root, [], undefined, options)).toThrow("text row cleanup failed");
    expect(cleaned).toEqual([1, 2]);
    expect(root.childElementCount).toBe(0);
  });

  it("commits non-empty text row removal before rethrowing a falsy cleanup error", () => {
    const root = document.createElement("ul");
    const cleaned: number[] = [];
    const options = {
      key: "item.id",
      keyReadItem: (item: unknown) => (item as { id: number }).id,
      itemName: "item",
      templateHtml: `<li> </li>`,
      bindings: [
        {
          kind: "text" as const,
          path: [0],
          expression: "item.id",
          read: (scope: Record<string, unknown>) => {
            const id = (scope.item as { id: number }).id;
            onCleanup(() => {
              if (id === 1) {
                cleaned.push(id);
                throw undefined;
              }
            });
            return id;
          },
        },
      ],
    };

    mountTextKeyedList(root, [], [{ id: 1 }, { id: 2 }], options);

    let didThrow = false;
    let thrown: unknown;
    try {
      mountTextKeyedList(root, [], [{ id: 2 }], options);
    } catch (error) {
      didThrow = true;
      thrown = error;
    }

    expect(didThrow).toBe(true);
    expect(thrown).toBeUndefined();
    expect(root.textContent).toBe("2");
    expect(cleaned).toEqual([1]);
    mountTextKeyedList(root, [], [{ id: 2 }], options);
    expect(cleaned).toEqual([1]);
    mountTextKeyedList(root, [], undefined, options);
    expect(cleaned).toEqual([1]);
  });

  it("reuses, moves, updates, inserts, and removes keyed rows", () => {
    document.body.innerHTML = `<ul id="items"></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) throw new Error("Missing test root.");
    const options = {
      signature: "text-list-reconciliation",
      key: "item.id",
      keyReadItem: (item: unknown) => (item as { id: number }).id,
      itemName: "item",
      templateHtml: `<li><span> </span></li>`,
      bindings: [
        {
          kind: "text" as const,
          path: [0, 0],
          expression: "item.label",
          read: (scope: Record<string, unknown>) => (scope.item as { label: string }).label,
        },
      ],
    };

    mountTextKeyedList(
      root,
      [],
      [
        { id: 1, label: "One" },
        { id: 2, label: "Two" },
        { id: 3, label: "Three" },
      ],
      options,
    );
    const first = root.children[0];
    const second = root.children[1];
    const third = root.children[2];

    mountTextKeyedList(
      root,
      [],
      [
        { id: 3, label: "Three updated" },
        { id: 4, label: "Four" },
        { id: 1, label: "One updated" },
      ],
      options,
    );

    expect(root.children[0]).toBe(third);
    expect(root.children[2]).toBe(first);
    expect(second?.isConnected).toBe(false);
    expect(root.innerHTML).toBe(
      `<li><span>Three updated</span></li><li><span>Four</span></li><li><span>One updated</span></li>`,
    );
  });

  it("adopts server rows and removes surplus markup on the first mount", () => {
    document.body.innerHTML = `<ul id="items"><li><span>Server one</span></li><li><span>Surplus</span></li></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) throw new Error("Missing test root.");
    const serverRow = root.firstElementChild;

    mountTextKeyedList(root, [], [{ id: 1, label: "Client one" }], {
      key: "item.id",
      itemName: "item",
      templateHtml: `<li><span> </span></li>`,
      bindings: [{ kind: "text", path: [0, 0], expression: "item.label" }],
    });

    expect(root.firstElementChild).toBe(serverRow);
    expect(root.innerHTML).toBe(`<li><span>Client one</span></li>`);
  });

  it("keeps a static sibling outside a hydrated text-row region", () => {
    document.body.innerHTML = `<ul id="items"><li class="row">Server one</li><li class="row">Server two</li><li class="footer">Footer</li></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) throw new Error("Missing test root.");
    const options = {
      key: "item.id",
      itemName: "item",
      region: { before: 0, after: 1 },
      templateHtml: `<li class="row"> </li>`,
      bindings: [{ kind: "text" as const, path: [0], expression: "item.label" }],
    };

    mountTextKeyedList(
      root,
      [],
      [
        { id: 1, label: "One" },
        { id: 2, label: "Two" },
      ],
      options,
    );
    expect(root.innerHTML).toBe(`<li class="row">One</li><li class="row">Two</li><li class="footer">Footer</li>`);
    mountTextKeyedList(root, [], [], options);
    expect(root.innerHTML).toBe(`<li class="footer">Footer</li>`);
  });

  it("skips duplicate keys when console.warn is unavailable", () => {
    document.body.innerHTML = `<ul id="items"></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) throw new Error("Missing test root.");
    console.warn = undefined as unknown as typeof console.warn;

    expect(() =>
      mountTextKeyedList(
        root,
        [],
        [
          { id: 1, label: "First" },
          { id: 1, label: "Duplicate" },
        ],
        {
          key: "item.id",
          itemName: "item",
          templateHtml: `<li> </li>`,
          bindings: [{ kind: "text", path: [0], expression: "item.label" }],
        },
      ),
    ).not.toThrow();
    expect(root.innerHTML).toBe(`<li>First</li>`);
  });

  it("disposes row effects with their reactive owner", () => {
    document.body.innerHTML = `<ul id="items"></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) throw new Error("Missing test root.");
    const rows = createSignal([{ id: 1, label: "One" }]);
    const shared = createSignal(0);
    let reads = 0;
    const dispose = effect(() =>
      mountTextKeyedList(root, [], rows(), {
        signature: "owned-text-list",
        key: "item.id",
        itemName: "item",
        templateHtml: `<li> </li>`,
        bindings: [
          {
            kind: "text",
            path: [0],
            expression: "item.label",
            read: (scope) => {
              shared();
              reads++;
              return (scope.item as { label: string }).label;
            },
          },
        ],
      }),
    );
    const beforeDispose = reads;

    dispose();
    document.body.replaceChildren();
    expect(() => cleanupTextKeyedList(root, [])).not.toThrow();
    expect(() => cleanupTextKeyedList(root, [])).not.toThrow();
    shared.set(1);

    expect(reads).toBe(beforeDispose);
    expect(root.childElementCount).toBe(0);
  });

  it("adopts and reorders rows with multiple root nodes", () => {
    document.body.innerHTML = `<section id="items"><p>One</p><hr><p>Two</p><hr></section>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) throw new Error("Missing test root.");
    const firstParagraph = root.children[0];
    const secondParagraph = root.children[2];
    const options = {
      signature: "multi-root-text-list",
      key: "item.id",
      itemName: "item",
      templateHtml: `<p> </p><hr>`,
      bindings: [{ kind: "text" as const, path: [0, 0], expression: "item.label" }],
    };

    mountTextKeyedList(
      root,
      [],
      [
        { id: 1, label: "One adopted" },
        { id: 2, label: "Two adopted" },
      ],
      options,
    );
    mountTextKeyedList(
      root,
      [],
      [
        { id: 2, label: "Two moved" },
        { id: 1, label: "One moved" },
      ],
      options,
    );

    expect(root.children[0]).toBe(secondParagraph);
    expect(root.children[2]).toBe(firstParagraph);
    expect(root.innerHTML).toBe(`<p>Two moved</p><hr><p>One moved</p><hr>`);
  });

  it("rejects an SSR row whose text path resolves to an element", () => {
    document.body.innerHTML = `<ul id="items"><li><span>Wrong node</span></li></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) throw new Error("Missing test root.");

    expect(() =>
      mountTextKeyedList(root, [], [{ id: 1, label: "One" }], {
        key: "item.id",
        itemName: "item",
        templateHtml: `<li><span></span></li>`,
        bindings: [{ kind: "text", path: [0], expression: "item.label" }],
      }),
    ).toThrow("instead of a Text node");
  });
});
