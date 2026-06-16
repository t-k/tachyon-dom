import { describe, expect, it } from "vitest";
import { mountKeyedList } from "../src/runtime/list";

describe("mountKeyedList", () => {
  it("mounts rows with direct text and class bindings", () => {
    document.body.innerHTML = `<ul id="items"></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing test root.");
    }

    mountKeyedList(
      root,
      [],
      [
        { id: 1, label: "One", selected: false },
        { id: 2, label: "Two", selected: true },
      ],
      {
        key: "item.id",
        itemName: "item",
        templateHtml: `<li><span> </span></li>`,
        bindings: [
          { kind: "class", path: [], className: "danger", expression: "item.selected" },
          { kind: "text", path: [0, 0], expression: "item.label" },
        ],
      },
    );

    expect(root.innerHTML).toBe(`<li><span>One</span></li><li class="danger"><span>Two</span></li>`);
  });

  it("reuses, moves, updates, and removes keyed rows", () => {
    document.body.innerHTML = `<ul id="items"></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing test root.");
    }
    const options = {
      key: "item.id",
      itemName: "item",
      templateHtml: `<li><span> </span></li>`,
      bindings: [{ kind: "text" as const, path: [0, 0], expression: "item.label" }],
    };

    mountKeyedList(
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

    mountKeyedList(
      root,
      [],
      [
        { id: 3, label: "Three updated" },
        { id: 1, label: "One updated" },
      ],
      options,
    );

    expect(root.children.length).toBe(2);
    expect(root.children[0]).toBe(third);
    expect(root.children[1]).toBe(first);
    expect(second?.isConnected).toBe(false);
    expect(root.innerHTML).toBe(`<li><span>Three updated</span></li><li><span>One updated</span></li>`);
  });

  it("adopts matching SSR rows on the first mount before applying keyed updates", () => {
    document.body.innerHTML = `<ul id="items"><li><span>One</span></li><li><span>Two</span></li></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing test root.");
    }
    const first = root.children[0];
    const second = root.children[1];
    const options = {
      key: "item.id",
      itemName: "item",
      templateHtml: `<li><span> </span></li>`,
      bindings: [{ kind: "text" as const, path: [0, 0], expression: "item.label" }],
    };

    mountKeyedList(
      root,
      [],
      [
        { id: 1, label: "One" },
        { id: 2, label: "Two" },
      ],
      options,
    );

    expect(root.children[0]).toBe(first);
    expect(root.children[1]).toBe(second);
    expect(root.innerHTML).toBe(`<li><span>One</span></li><li><span>Two</span></li>`);

    mountKeyedList(
      root,
      [],
      [
        { id: 2, label: "Two updated" },
        { id: 1, label: "One updated" },
      ],
      options,
    );

    expect(root.children[0]).toBe(second);
    expect(root.children[1]).toBe(first);
    expect(root.innerHTML).toBe(`<li><span>Two updated</span></li><li><span>One updated</span></li>`);
  });

  it("falls back to insertBefore when moveBefore rejects the hierarchy", () => {
    document.body.innerHTML = `<ul id="items"></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing test root.");
    }
    let attemptedMoveBefore = false;
    (root as HTMLElement & { moveBefore: (node: Node, child: Node | null) => void }).moveBefore = () => {
      attemptedMoveBefore = true;
      throw new DOMException("Invalid hierarchy.", "HierarchyRequestError");
    };
    const options = {
      key: "item.id",
      itemName: "item",
      templateHtml: `<li><span> </span></li>`,
      bindings: [{ kind: "text" as const, path: [0, 0], expression: "item.label" }],
    };

    mountKeyedList(
      root,
      [],
      [
        { id: 1, label: "One" },
        { id: 2, label: "Two" },
      ],
      options,
    );
    mountKeyedList(
      root,
      [],
      [
        { id: 2, label: "Two" },
        { id: 1, label: "One" },
      ],
      options,
    );

    expect(attemptedMoveBefore).toBe(true);
    expect(root.innerHTML).toBe(`<li><span>Two</span></li><li><span>One</span></li>`);
  });

  it("keeps event handlers current when keyed rows are reused", () => {
    document.body.innerHTML = `<ul id="items"></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing test root.");
    }
    const calls: string[] = [];
    const options = {
      key: "item.id",
      itemName: "item",
      templateHtml: `<li><button> </button></li>`,
      bindings: [
        { kind: "text" as const, path: [0, 0], expression: "item.label" },
        { kind: "event" as const, path: [0], eventName: "click", handler: "item.onClick" },
      ],
    };

    mountKeyedList(root, [], [{ id: 1, label: "One", onClick: () => calls.push("old") }], options);
    mountKeyedList(root, [], [{ id: 1, label: "One", onClick: () => calls.push("new") }], options);

    root.querySelector("button")?.click();

    expect(calls).toEqual(["new"]);
  });

  it("delegates row events through the list container", () => {
    document.body.innerHTML = `<ul id="items"></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing test root.");
    }
    const calls: string[] = [];
    const addListener = root.addEventListener.bind(root);
    const removeListener = root.removeEventListener.bind(root);
    let addCount = 0;
    let removeCount = 0;
    root.addEventListener = ((...args: Parameters<typeof root.addEventListener>) => {
      addCount++;
      return addListener(...args);
    }) as typeof root.addEventListener;
    root.removeEventListener = ((...args: Parameters<typeof root.removeEventListener>) => {
      removeCount++;
      return removeListener(...args);
    }) as typeof root.removeEventListener;
    const options = {
      key: "item.id",
      itemName: "item",
      templateHtml: `<li><button><span> </span></button></li>`,
      bindings: [
        { kind: "text" as const, path: [0, 0, 0], expression: "item.label" },
        { kind: "event" as const, path: [0], eventName: "click", handler: "item.onClick" },
      ],
    };

    mountKeyedList(
      root,
      [],
      Array.from({ length: 3 }, (_, index) => ({
        id: index + 1,
        label: String(index + 1),
        onClick: () => calls.push(String(index + 1)),
      })),
      options,
    );
    mountKeyedList(root, [], [{ id: 2, label: "2", onClick: () => calls.push("updated") }], options);

    root.querySelector("span")?.click();

    expect(addCount).toBe(1);
    expect(removeCount).toBe(0);
    expect(calls).toEqual(["updated"]);
  });
});
