import { afterEach, describe, expect, it } from "vitest";
import { cleanupTextKeyedList, mountTextKeyedList } from "../src/runtime/list-text";
import { createSignal, effect } from "../src/runtime/signal";

const warn = console.warn;

afterEach(() => {
  console.warn = warn;
});

describe("mountTextKeyedList", () => {
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
