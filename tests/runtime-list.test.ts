import { afterEach, describe, expect, it, vi } from "vitest";
import { mountKeyedList } from "../src/runtime/list";

const stringify = JSON.stringify;

afterEach(() => {
  JSON.stringify = stringify;
});

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

  it("does not leave orphaned rows after duplicate keys are removed", () => {
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
        { id: 1, label: "One A" },
        { id: 1, label: "One B" },
        { id: 2, label: "Two" },
      ],
      options,
    );
    mountKeyedList(
      root,
      [],
      [
        { id: 1, label: "One" },
        { id: 2, label: "Two" },
      ],
      options,
    );

    expect(root.children.length).toBe(2);
    expect(Array.from(root.children, (child) => child.textContent)).toEqual(["One", "Two"]);
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

  it("adopts SSR rows with whitespace text nodes without reordering against text nodes", () => {
    document.body.innerHTML = `<ul id="items">
      <li><span>One</span></li>
      <li><span>Two</span></li>
    </ul>`;
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
    expect(Array.from(root.children, (child) => child.textContent)).toEqual(["Two updated", "One updated"]);
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

  it("moves only out-of-order keyed rows for a far swap", () => {
    document.body.innerHTML = `<ul id="items"></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing test root.");
    }
    let moves = 0;
    (root as HTMLElement & { moveBefore: (node: Node, child: Node | null) => void }).moveBefore = (node, child) => {
      moves++;
      root.insertBefore(node, child);
    };
    const options = {
      key: "item.id",
      itemName: "item",
      templateHtml: `<li><span> </span></li>`,
      bindings: [{ kind: "text" as const, path: [0, 0], expression: "item.label" }],
    };
    const rows = Array.from({ length: 10 }, (_, id) => ({ id, label: String(id) }));

    mountKeyedList(root, [], rows, options);
    moves = 0;
    mountKeyedList(
      root,
      [],
      [rows[0], rows[8], ...rows.slice(2, 8), rows[1], rows[9]].filter((row): row is (typeof rows)[number] =>
        Boolean(row),
      ),
      options,
    );

    expect(moves).toBeLessThanOrEqual(2);
    expect(Array.from(root.children, (child) => child.textContent)).toEqual([
      "0",
      "8",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "1",
      "9",
    ]);
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

  it("skips unchanged row binding writes when keyed rows are reused", () => {
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

    mountKeyedList(root, [], [{ id: 1, label: "One" }], options);
    const text = root.querySelector("span")?.firstChild;
    if (!(text instanceof Text)) {
      throw new Error("Missing text node.");
    }
    const descriptor = Object.getOwnPropertyDescriptor(Node.prototype, "nodeValue");
    let writes = 0;
    Object.defineProperty(text, "nodeValue", {
      configurable: true,
      get: () => descriptor?.get?.call(text),
      set: (value) => {
        writes++;
        descriptor?.set?.call(text, value);
      },
    });

    mountKeyedList(root, [], [{ id: 1, label: "One" }], options);

    expect(writes).toBe(0);
  });

  it("allows row bindings to read handlers and values from the outer scope", () => {
    document.body.innerHTML = `<ul id="items"></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing test root.");
    }
    const removed: number[] = [];
    const outerScope = {
      prefix: "Row",
      remove: (id: number) => {
        removed.push(id);
      },
    };
    const options = {
      key: "row.id",
      itemName: "row",
      scope: outerScope,
      templateHtml: `<li><button title=""> </button></li>`,
      bindings: [
        {
          kind: "attr" as const,
          path: [0],
          name: "title",
          expression: "prefix",
          read: (scope: Record<string, unknown>) => scope.prefix,
        },
        {
          kind: "event" as const,
          path: [0],
          eventName: "click",
          handler: "remove(row.id)",
          read: (scope: Record<string, unknown>) => () =>
            (scope.remove as (id: number) => void)((scope.row as { id: number }).id),
        },
      ],
    };

    mountKeyedList(root, [], [{ id: 7 }], options);

    const button = root.querySelector("button");
    expect(button?.getAttribute("title")).toBe("Row");
    button?.click();
    expect(removed).toEqual([7]);
  });

  it("removes surplus SSR rows when the first client mount has fewer items", () => {
    document.body.innerHTML = `<ul id="items"><li><span>One</span></li><li><span>Two</span></li><li><span>Three</span></li></ul>`;
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

    mountKeyedList(root, [], [{ id: 1, label: "One" }], options);

    expect(Array.from(root.children, (child) => child.textContent)).toEqual(["One"]);
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

  it("mounts, updates, and reorders keyed items with multiple root nodes", () => {
    document.body.innerHTML = `<section id="items"></section>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing test root.");
    }
    const options = {
      key: "item.id",
      itemName: "item",
      templateHtml: `<h2> </h2><p> </p>`,
      bindings: [
        { kind: "text" as const, path: [0, 0], expression: "item.title" },
        { kind: "text" as const, path: [1, 0], expression: "item.body" },
      ],
    };

    mountKeyedList(
      root,
      [],
      [
        { id: 1, title: "One", body: "First" },
        { id: 2, title: "Two", body: "Second" },
      ],
      options,
    );
    const oneTitle = root.children[0];
    const oneBody = root.children[1];

    mountKeyedList(
      root,
      [],
      [
        { id: 2, title: "Two updated", body: "Second updated" },
        { id: 1, title: "One updated", body: "First updated" },
      ],
      options,
    );

    expect(root.children[2]).toBe(oneTitle);
    expect(root.children[3]).toBe(oneBody);
    expect(root.innerHTML).toBe(`<h2>Two updated</h2><p>Second updated</p><h2>One updated</h2><p>First updated</p>`);
  });

  it("uses compiled binding readers for expressions beyond dot paths", () => {
    document.body.innerHTML = `<ul id="items"></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing test root.");
    }
    const options = {
      signature: "compiled-list-readers",
      key: "item.ids[0]",
      keyRead: (scope: Record<string, unknown>) => (scope.item as { ids: number[] }).ids[0],
      itemName: "item",
      templateHtml: `<li><span> </span></li>`,
      bindings: [
        {
          kind: "text" as const,
          path: [0, 0],
          expression: "item.labels[0] ?? `Guest ${item.name}`",
          read: (scope: Record<string, unknown>) => {
            const item = scope.item as { labels: string[]; name: string };
            return item.labels[0] ?? `Guest ${item.name}`;
          },
        },
      ],
    };

    mountKeyedList(root, [], [{ ids: [1], labels: [], name: "Ada" }], options);

    expect(root.innerHTML).toBe(`<li><span>Guest Ada</span></li>`);
  });

  it("applies bindings once when creating a new keyed row", () => {
    document.body.innerHTML = `<ul id="items"></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing test root.");
    }
    let readCount = 0;
    const options = {
      key: "item.id",
      itemName: "item",
      templateHtml: `<li><span> </span></li>`,
      bindings: [
        {
          kind: "text" as const,
          path: [0, 0],
          expression: "item.label",
          read: (scope: Record<string, unknown>) => {
            readCount++;
            return (scope.item as { label: string }).label;
          },
        },
      ],
    };

    mountKeyedList(root, [], [{ id: 1, label: "One" }], options);

    expect(readCount).toBe(1);
    expect(root.innerHTML).toBe(`<li><span>One</span></li>`);
  });

  it("reuses a stable options signature without JSON serializing on each mount", () => {
    document.body.innerHTML = `<ul id="items"></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing test root.");
    }
    const json = vi.fn(stringify);
    JSON.stringify = json as typeof JSON.stringify;
    const options = {
      signature: "stable-list-options",
      key: "item.id",
      itemName: "item",
      templateHtml: `<li><span> </span></li>`,
      bindings: [{ kind: "text" as const, path: [0, 0], expression: "item.label" }],
    };

    mountKeyedList(root, [], [{ id: 1, label: "One" }], options);
    mountKeyedList(root, [], [{ id: 1, label: "One updated" }], options);

    expect(json).not.toHaveBeenCalled();
    expect(root.innerHTML).toBe(`<li><span>One updated</span></li>`);
  });

  it("mounts nested lists and conditionals inside keyed rows", () => {
    document.body.innerHTML = `<section><ul id="groups"></ul></section>`;
    const root = document.body.firstElementChild;
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing root.");
    }

    mountKeyedList(
      root,
      [0],
      [
        {
          id: "a",
          name: "Group A",
          visible: true,
          items: [
            { id: "a1", label: "A1" },
            { id: "a2", label: "A2" },
          ],
        },
        { id: "b", name: "Group B", visible: false, items: [{ id: "b1", label: "B1" }] },
      ],
      {
        key: "group.id",
        itemName: "group",
        templateHtml: `<li><span> </span><ul></ul><!----></li>`,
        bindings: [
          { kind: "text", path: [0, 0], expression: "group.name" },
          {
            kind: "list",
            path: [1],
            each: "group.items",
            itemName: "item",
            key: "item.id",
            templateHtml: `<li> </li>`,
            bindings: [{ kind: "text", path: [0], expression: "item.label" }],
          },
          {
            kind: "if",
            path: [2],
            test: "group.visible",
            templateHtml: `<em>visible</em>`,
            bindings: [],
          },
        ],
      },
    );

    expect(root.innerHTML).toBe(
      `<ul id="groups"><li><span>Group A</span><ul><li>A1</li><li>A2</li></ul><!----><em>visible</em></li><li><span>Group B</span><ul><li>B1</li></ul><!----></li></ul>`,
    );
  });

  it("keeps nested list and conditional DOM current without serializing signed bindings", () => {
    document.body.innerHTML = `<section><ul id="groups"></ul></section>`;
    const root = document.body.firstElementChild;
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing root.");
    }
    const items = [{ id: "a1", label: "A1" }];
    const json = vi.fn(stringify);
    JSON.stringify = json as typeof JSON.stringify;
    const options = {
      signature: "groups-with-nested-bindings",
      key: "group.id",
      itemName: "group",
      templateHtml: `<li><span> </span><ul></ul><!----></li>`,
      bindings: [
        { kind: "text" as const, path: [0, 0], expression: "group.name" },
        {
          kind: "list" as const,
          signature: "nested-items",
          path: [1],
          each: "group.items",
          read: (scope: Record<string, unknown>) => (scope.group as { items: typeof items }).items,
          itemName: "item",
          key: "item.id",
          templateHtml: `<li> </li>`,
          bindings: [
            {
              kind: "text" as const,
              path: [0],
              expression: "item.label",
              read: (scope: Record<string, unknown>) => (scope.item as { label: string }).label,
            },
          ],
        },
        {
          kind: "if" as const,
          signature: "nested-visible",
          path: [2],
          test: "group.visible",
          read: (scope: Record<string, unknown>) => (scope.group as { visible: boolean }).visible,
          templateHtml: `<em> </em>`,
          bindings: [
            {
              kind: "text" as const,
              path: [0],
              expression: "group.badge",
              read: (scope: Record<string, unknown>) => (scope.group as { badge: string }).badge,
            },
          ],
        },
      ],
    };

    mountKeyedList(root, [0], [{ id: "a", name: "Group A", visible: true, badge: "visible", items }], options);
    items[0] = { id: "a1", label: "A1 updated" };
    mountKeyedList(root, [0], [{ id: "a", name: "Group A updated", visible: true, badge: "visible", items }], options);

    expect(json).not.toHaveBeenCalled();
    expect(root.innerHTML).toBe(
      `<ul id="groups"><li><span>Group A updated</span><ul><li>A1 updated</li></ul><!----><em>visible</em></li></ul>`,
    );
  });
});
