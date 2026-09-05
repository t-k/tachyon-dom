import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal, effect, onCleanup } from "../src/runtime/signal";
import { mountKeyedList } from "../src/runtime/list";

const stringify = JSON.stringify;
const nodeEnv = process.env.NODE_ENV;
const warn = console.warn;

afterEach(() => {
  JSON.stringify = stringify;
  process.env.NODE_ENV = nodeEnv;
  console.warn = warn;
});

describe("mountKeyedList", () => {
  it("owns row component props and stores across reorder and removal", () => {
    const root = document.createElement("ul");
    const options = {
      key: "item.id",
      itemName: "item",
      templateHtml: `<li><input><span> </span><strong> </strong></li>`,
      bindings: [
        {
          kind: "text" as const,
          path: [1, 0],
          expression: "label",
          read: (scope: Record<string, unknown>) => scope.label,
        },
        {
          kind: "text" as const,
          path: [2, 0],
          expression: "count",
          read: (scope: Record<string, unknown>) => scope.count,
        },
        {
          kind: "model" as const,
          path: [0],
          property: "value" as const,
          expression: "count",
          read: (scope: Record<string, unknown>) => scope.count,
          write: (scope: Record<string, unknown>, value: unknown) => {
            scope.count = value;
          },
        },
      ],
      components: [
        {
          path: [],
          name: "Row",
          props: [{ name: "label", expression: "item.label" }],
          stores: [{ name: "count", initial: "item.count" }],
        },
      ],
      stores: [],
      hydrationBoundaries: [],
    };
    const first = { id: "a", label: "A", count: "1" };
    const second = { id: "b", label: "B", count: "2" };

    mountKeyedList(root, [], [first, second], options);
    const firstInput = root.querySelector("input");
    if (!firstInput) throw new Error("Missing first input.");
    firstInput.value = "changed";
    firstInput.dispatchEvent(new Event("input", { bubbles: true }));
    mountKeyedList(root, [], [second, first], options);

    expect(Array.from(root.querySelectorAll("li"), (row) => row.textContent)).toEqual(["B2", "Achanged"]);
    expect(root.querySelectorAll("li")[1]?.querySelector("input")).toBe(firstInput);

    mountKeyedList(root, [], [second], options);
    expect(root.textContent).toBe("B2");
  });

  it("skips DOM moves for stable order and appends only new rows", () => {
    const root = document.createElement("ul");
    const options = {
      key: "item.id",
      itemName: "item",
      templateHtml: `<li></li>`,
      bindings: [],
    };
    const rows = [{ id: "a" }, { id: "b" }];
    mountKeyedList(root, [], rows, options);
    const insertBefore = vi.spyOn(root, "insertBefore");

    mountKeyedList(root, [], rows, options);
    mountKeyedList(root, [], [...rows, { id: "c" }], options);

    expect(insertBefore).not.toHaveBeenCalled();
    expect(root.textContent).toBe("");
    insertBefore.mockRestore();
    mountKeyedList(root, [], [{ id: "c" }, { id: "b" }, { id: "a" }], options);
    expect(root.children.length).toBe(3);
  });

  it("supports an explicit immutable reference update policy", () => {
    const root = document.createElement("ul");
    let reads = 0;
    const options = {
      key: "item.id",
      itemName: "item",
      updatePolicy: "reference" as const,
      templateHtml: `<li> </li>`,
      bindings: [
        {
          kind: "text" as const,
          path: [0],
          expression: "item.label",
          read: (scope: Record<string, unknown>) => {
            reads++;
            return (scope.item as { label: string }).label;
          },
        },
      ],
    };
    const first = { id: "a", label: "A" };

    mountKeyedList(root, [], [first], options);
    mountKeyedList(root, [], [first, { id: "b", label: "B" }], options);

    expect(reads).toBe(2);
    expect(root.textContent).toBe("AB");
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

    mountKeyedList(root, [], [{ id: "a" }], options);
    scope.label = "B";
    mountKeyedList(root, [], [{ id: "a" }], options);

    expect(root.textContent).toBe("B");
  });

  it("keeps row-local stores shadowing the parent scope during reorder", () => {
    const root = document.createElement("ul");
    const options = {
      key: "item.id",
      itemName: "item",
      scope: { count: 99 },
      templateHtml: `<li> </li>`,
      stores: [{ name: "count", initial: "item.count" }],
      bindings: [{ kind: "text" as const, path: [0], expression: "count" }],
    };
    const first = { id: "a", count: 12 };
    const second = { id: "b", count: 21 };

    mountKeyedList(root, [], [first, second], options);
    mountKeyedList(root, [], [second, first], options);

    expect(Array.from(root.children, (row) => row.textContent)).toEqual(["21", "12"]);
  });

  it("uses generated readers for literal row store initializers", () => {
    const root = document.createElement("ul");
    const options = {
      key: "item.id",
      itemName: "item",
      templateHtml: `<li> </li>`,
      stores: [{ name: "count", initial: "0", read: () => 0 }],
      bindings: [{ kind: "text" as const, path: [0], expression: "count" }],
    };

    mountKeyedList(root, [], [{ id: "a" }], options);

    expect(root.textContent).toBe("0");
  });

  it("refreshes a reference-policy row when its index changes", () => {
    const root = document.createElement("ul");
    const options = {
      key: "item.id",
      itemName: "item",
      indexName: "position",
      updatePolicy: "reference" as const,
      templateHtml: `<li> </li>`,
      bindings: [
        {
          kind: "text" as const,
          path: [0],
          expression: "position",
          read: (scope: Record<string, unknown>) => scope.position,
        },
      ],
    };
    const first = { id: "a" };
    const second = { id: "b" };

    mountKeyedList(root, [], [first, second], options);
    mountKeyedList(root, [], [second, first], options);

    expect(root.textContent).toBe("01");
  });

  it("rolls back rows already created when a later row fails", () => {
    const root = document.createElement("ul");
    const source = createSignal(0);
    let liveRows = 0;
    const options = {
      key: "item.id",
      itemName: "item",
      templateHtml: `<li> </li>`,
      bindings: [
        {
          kind: "text" as const,
          path: [0],
          expression: "item.id",
          read: (scope: Record<string, unknown>) => {
            source();
            liveRows++;
            onCleanup(() => {
              liveRows--;
            });
            const id = (scope.item as { id: number }).id;
            if (id === 2) throw new Error("row failed");
            return id;
          },
        },
      ],
    };

    expect(() => mountKeyedList(root, [], [{ id: 1 }, { id: 2 }], options)).toThrow("row failed");
    expect(root.childElementCount).toBe(0);
    expect(liveRows).toBe(0);

    source.set(1);

    expect(liveRows).toBe(0);
  });

  it("rethrows falsy row cleanup errors", () => {
    const root = document.createElement("ul");
    const options = {
      key: "item.id",
      itemName: "item",
      templateHtml: `<li> </li>`,
      bindings: [
        {
          kind: "text" as const,
          path: [0],
          expression: "item.id",
          read: (scope: Record<string, unknown>) => {
            onCleanup(() => {
              throw undefined;
            });
            return (scope.item as { id: number }).id;
          },
        },
      ],
    };
    mountKeyedList(root, [], [{ id: 1 }], options);

    let didThrow = false;
    let thrown: unknown;
    try {
      mountKeyedList(root, [], undefined, options);
    } catch (error) {
      didThrow = true;
      thrown = error;
    }

    expect(didThrow).toBe(true);
    expect(thrown).toBeUndefined();
    expect(root.childElementCount).toBe(0);
  });

  it("commits non-empty row removal before rethrowing a falsy cleanup error", () => {
    const root = document.createElement("ul");
    const cleaned: number[] = [];
    const options = {
      key: "item.id",
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

    mountKeyedList(root, [], [{ id: 1 }, { id: 2 }], options);

    let didThrow = false;
    let thrown: unknown;
    try {
      mountKeyedList(root, [], [{ id: 2 }], options);
    } catch (error) {
      didThrow = true;
      thrown = error;
    }

    expect(didThrow).toBe(true);
    expect(thrown).toBeUndefined();
    expect(root.textContent).toBe("2");
    expect(cleaned).toEqual([1]);
    mountKeyedList(root, [], [{ id: 2 }], options);
    expect(cleaned).toEqual([1]);
    mountKeyedList(root, [], undefined, options);
    expect(cleaned).toEqual([1]);
  });

  it("rejects non-primitive and non-finite keys", () => {
    document.body.innerHTML = `<ul id="items"></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) throw new Error("Missing test root.");
    const options = {
      key: "item.id",
      itemName: "item",
      templateHtml: `<li> </li>`,
      bindings: [{ kind: "text" as const, path: [0], expression: "item.id" }],
    };

    for (const id of [null, undefined, {}, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => mountKeyedList(root, [], [{ id }], options)).toThrow("Invalid keyed list key");
    }
  });

  it("validates every key before creating any new row resources", () => {
    const root = document.createElement("ul");
    const source = createSignal(0);
    let rowReads = 0;
    const options = {
      key: "row.id",
      keyReadItem: (item: unknown) => {
        if ((item as { id: number }).id === 2) throw new Error("key failed");
        return (item as { id: number }).id;
      },
      itemName: "row",
      templateHtml: `<li> </li>`,
      bindings: [
        {
          kind: "text" as const,
          path: [0],
          expression: "row.id",
          read: (scope: Record<string, unknown>) => {
            onCleanup(() => undefined);
            rowReads++;
            source();
            return (scope.row as { id: number }).id;
          },
        },
      ],
    };

    expect(() => mountKeyedList(root, [], [{ id: 1 }, { id: 2 }], options)).toThrow("key failed");
    source.set(1);

    expect(rowReads).toBe(0);
    expect(root.childElementCount).toBe(0);
  });

  it("continues removing every row after one row cleanup throws", () => {
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
              if (id === 1) throw new Error("row cleanup failed");
            });
            return id;
          },
        },
      ],
    };

    mountKeyedList(root, [], [{ id: 1 }, { id: 2 }], options);

    expect(() => mountKeyedList(root, [], undefined, options)).toThrow("row cleanup failed");
    expect(cleaned).toEqual([1, 2]);
    expect(root.childElementCount).toBe(0);
  });

  it("clears a row ref when its keyed row is removed", () => {
    document.body.innerHTML = `<ul id="items"></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) throw new Error("Missing test root.");
    const item: { id: number; ref?: Element } = { id: 1 };
    const options = {
      key: "item.id",
      itemName: "item",
      templateHtml: `<li></li>`,
      bindings: [{ kind: "ref" as const, path: [], expression: "item.ref" }],
    };

    mountKeyedList(root, [], [item], options);
    expect(item.ref).toBe(root.querySelector("li"));
    mountKeyedList(root, [], [], options);

    expect(item.ref).toBeUndefined();
  });

  it("disposes bindings for rows appended after root creation", () => {
    document.body.innerHTML = `<ul id="items"></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) throw new Error("Missing test root.");
    const rows = createSignal([{ id: 1 }]);
    const shared = createSignal(0);
    const calls = new Map<number, number>();
    const options = {
      key: "item.id",
      itemName: "item",
      templateHtml: `<li> </li>`,
      bindings: [
        {
          kind: "text" as const,
          path: [0],
          expression: "item.id",
          read: (scope: Record<string, unknown>) => {
            shared();
            const id = (scope.item as { id: number }).id;
            calls.set(id, (calls.get(id) ?? 0) + 1);
            return id;
          },
        },
      ],
    };
    const dispose = createRoot((disposeRoot) => {
      effect(() => mountKeyedList(root, [], rows(), options));
      return disposeRoot;
    });

    rows.set([{ id: 1 }, { id: 2 }]);
    const beforeDispose = new Map(calls);
    dispose();
    shared.set(1);

    expect(calls).toEqual(beforeDispose);
  });

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

  it("warns in development when keyed list items contain duplicate keys", () => {
    process.env.NODE_ENV = "development";
    const warnings: string[] = [];
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    document.body.innerHTML = `<ul id="items"></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing test root.");
    }

    mountKeyedList(
      root,
      [],
      [
        { id: 1, label: "One A" },
        { id: 1, label: "One B" },
      ],
      {
        signature: "tests/runtime-list.td:list:0",
        key: "item.id",
        itemName: "item",
        templateHtml: `<li><span> </span></li>`,
        bindings: [{ kind: "text", path: [0, 0], expression: "item.label" }],
      },
    );

    expect(warnings).toEqual([
      `Duplicate key "1" in keyed <for> list tests/runtime-list.td:list:0. Later items with the same key were skipped.`,
    ]);
  });

  it("does not warn for duplicate keyed list items in production", () => {
    process.env.NODE_ENV = "production";
    const warnings: string[] = [];
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    document.body.innerHTML = `<ul id="items"></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing test root.");
    }

    mountKeyedList(
      root,
      [],
      [
        { id: 1, label: "One A" },
        { id: 1, label: "One B" },
      ],
      {
        signature: "tests/runtime-list.td:list:0",
        key: "item.id",
        itemName: "item",
        templateHtml: `<li><span> </span></li>`,
        bindings: [{ kind: "text", path: [0, 0], expression: "item.label" }],
      },
    );

    expect(warnings).toEqual([]);
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

  it("uses the row event target as currentTarget", () => {
    document.body.innerHTML = `<ul id="items"></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing test root.");
    }
    const currentTargets: Array<EventTarget | null> = [];
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
      [{ id: 1, label: "One", onClick: (event: Event) => currentTargets.push(event.currentTarget) }],
      options,
    );
    const button = root.querySelector("button");

    root.querySelector("span")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(currentTargets).toEqual([button]);
  });

  it("fires non-bubbling row events on nested targets", () => {
    document.body.innerHTML = `<ul id="items"></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing test root.");
    }
    const calls: string[] = [];
    const options = {
      key: "item.id",
      itemName: "item",
      templateHtml: `<li><input value="One"></li>`,
      bindings: [{ kind: "event" as const, path: [0], eventName: "focus", handler: "item.onFocus" }],
    };

    mountKeyedList(root, [], [{ id: 1, onFocus: () => calls.push("focus") }], options);

    root.querySelector("input")?.dispatchEvent(new FocusEvent("focus", { bubbles: false }));

    expect(calls).toEqual(["focus"]);
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

  it("updates reused row objects when their properties change in place", () => {
    document.body.innerHTML = `<ul id="items"></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing test root.");
    }
    const rows = Array.from({ length: 5 }, (_, index) => ({ id: index + 1, label: `Row ${index + 1}` }));
    const options = {
      signature: "row-scope-skip-unchanged-items",
      key: "item.id",
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

    mountKeyedList(root, [], rows, options);
    const nextRows = rows.slice();
    (nextRows[2] as { label: string }).label = "Row 3 updated";

    mountKeyedList(root, [], nextRows, options);

    expect(Array.from(root.children, (child) => child.textContent)).toEqual([
      "Row 1",
      "Row 2",
      "Row 3 updated",
      "Row 4",
      "Row 5",
    ]);
  });

  it("reruns only the changed row binding when a row signal changes", () => {
    document.body.innerHTML = `<ul id="items"></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing test root.");
    }
    const readIds: number[] = [];
    const rows = Array.from({ length: 5 }, (_, index) => ({
      id: index + 1,
      label: createSignal(`Row ${index + 1}`),
    }));
    const options = {
      signature: "row-scope-skip-unchanged-row-signals",
      key: "item.id",
      itemName: "item",
      templateHtml: `<li><span> </span></li>`,
      bindings: [
        {
          kind: "text" as const,
          path: [0, 0],
          expression: "item.label()",
          read: (scope: Record<string, unknown>) => {
            const item = scope.item as { id: number; label: () => string };
            readIds.push(item.id);
            return item.label();
          },
        },
      ],
    };

    const dispose = effect(() => mountKeyedList(root, [], rows, options));
    readIds.length = 0;
    rows[2]?.label.set("Row 3 updated");

    expect(readIds).toEqual([3]);
    expect(Array.from(root.children, (child) => child.textContent)).toEqual([
      "Row 1",
      "Row 2",
      "Row 3 updated",
      "Row 4",
      "Row 5",
    ]);

    dispose();
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

  it("updates compound row expressions when outer scope values change", () => {
    document.body.innerHTML = `<ul id="items"></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing test root.");
    }
    const rows = [
      { id: 1, label: "One" },
      { id: 2, label: "Two" },
    ];
    const outerScope = { activeId: 1 };
    const options = {
      signature: "row-compound-outer-scope",
      key: "item.id",
      itemName: "item",
      scope: outerScope,
      templateHtml: `<li><span> </span></li>`,
      bindings: [
        { kind: "text" as const, path: [0, 0], expression: "item.label" },
        {
          kind: "class" as const,
          path: [],
          className: "selected",
          expression: "item.id === activeId",
          read: (scope: Record<string, unknown>) =>
            (scope.item as { id: number }).id === (scope as { activeId: number }).activeId,
        },
      ],
    };

    mountKeyedList(root, [], rows, options);
    outerScope.activeId = 2;
    mountKeyedList(root, [], rows, options);

    expect(Array.from(root.children, (child) => child.className)).toEqual(["", "selected"]);
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

  it("keeps static siblings outside a hydrated row region", () => {
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
    const serverRows = Array.from(root.querySelectorAll("li.row"));

    mountKeyedList(
      root,
      [],
      [
        { id: 1, label: "One" },
        { id: 2, label: "Two" },
      ],
      options,
    );
    expect(root.innerHTML).toBe(`<li class="row">One</li><li class="row">Two</li><li class="footer">Footer</li>`);
    expect(root.children[0]).toBe(serverRows[0]);
    expect(root.children[1]).toBe(serverRows[1]);

    mountKeyedList(
      root,
      [],
      [
        { id: 2, label: "Two updated" },
        { id: 1, label: "One updated" },
      ],
      options,
    );
    expect(root.innerHTML).toBe(
      `<li class="row">Two updated</li><li class="row">One updated</li><li class="footer">Footer</li>`,
    );
    mountKeyedList(root, [], [], options);
    expect(root.innerHTML).toBe(`<li class="footer">Footer</li>`);
  });

  it("inserts newly mounted rows before a static trailing sibling", () => {
    document.body.innerHTML = `<ul id="items"><li class="footer">Footer</li></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) throw new Error("Missing test root.");

    mountKeyedList(root, [], [{ id: 1, label: "One" }], {
      key: "item.id",
      itemName: "item",
      region: { before: 0, after: 1 },
      templateHtml: `<li class="row"> </li>`,
      bindings: [{ kind: "text" as const, path: [0], expression: "item.label" }],
    });

    expect(root.innerHTML).toBe(`<li class="row">One</li><li class="footer">Footer</li>`);
  });

  it("binds row events without a container listener", () => {
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

    expect(addCount).toBe(0);
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

  it("mounts nested lists and conditionals in later roots of a multi-root row", () => {
    document.body.innerHTML = `<section id="items"></section>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) throw new Error("Missing test root.");
    const options = {
      key: "item.id",
      itemName: "item",
      templateHtml: `<h2> </h2><section><ul></ul><!----></section>`,
      bindings: [
        { kind: "text" as const, path: [0, 0], expression: "item.title" },
        {
          kind: "list" as const,
          path: [1, 0],
          each: "item.children",
          itemName: "child",
          key: "child.id",
          templateHtml: `<li> </li>`,
          bindings: [{ kind: "text" as const, path: [0], expression: "child.label" }],
        },
        { kind: "if" as const, path: [1, 1], test: "item.visible", templateHtml: `<em>visible</em>`, bindings: [] },
      ],
    };

    mountKeyedList(root, [], [{ id: 1, title: "One", visible: true, children: [{ id: 2, label: "Two" }] }], options);

    expect(root.innerHTML).toBe(`<h2>One</h2><section><ul><li>Two</li></ul><!----><em>visible</em></section>`);
  });

  it("owns formatted separators while adopting, reordering, and removing server rows", () => {
    document.body.innerHTML = `<ul id="items"> <li><span>A</span></li>  <li><span>B</span></li> </ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) throw new Error("Missing test root.");
    const options = {
      key: "item.id",
      itemName: "item",
      templateHtml: ` <li><span> </span></li> `,
      bindings: [{ kind: "text" as const, path: [1, 0, 0], expression: "item.label" }],
    };

    const existing = Array.from(root.querySelectorAll("li"));
    mountKeyedList(
      root,
      [],
      [
        { id: 1, label: "A" },
        { id: 2, label: "B" },
      ],
      options,
    );
    mountKeyedList(
      root,
      [],
      [
        { id: 2, label: "B updated" },
        { id: 1, label: "A updated" },
      ],
      options,
    );

    expect(root.querySelectorAll("li")[0]).toBe(existing[1]);
    expect(root.querySelectorAll("li")[1]).toBe(existing[0]);
    expect(root.textContent).toBe(" B updated  A updated ");
    mountKeyedList(root, [], [], options);
    expect(root.innerHTML).toBe("");
  });

  it("adopts every element in a formatted multi-root server row", () => {
    document.body.innerHTML = `<section id="items"> <h2>A</h2><p>A body</p>  <h2>B</h2><p>B body</p> </section>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) throw new Error("Missing test root.");
    const options = {
      key: "item.id",
      itemName: "item",
      templateHtml: ` <h2> </h2><p> </p> `,
      bindings: [
        { kind: "text" as const, path: [1, 0], expression: "item.title" },
        { kind: "text" as const, path: [2, 0], expression: "item.body" },
      ],
    };
    const existing = Array.from(root.children);

    mountKeyedList(
      root,
      [],
      [
        { id: 1, title: "A", body: "A body" },
        { id: 2, title: "B", body: "B body" },
      ],
      options,
    );
    mountKeyedList(
      root,
      [],
      [
        { id: 2, title: "B updated", body: "B body updated" },
        { id: 1, title: "A updated", body: "A body updated" },
      ],
      options,
    );

    expect(Array.from(root.children)).toEqual([existing[2], existing[3], existing[0], existing[1]]);
    expect(root.textContent).toBe(" B updatedB body updated  A updatedA body updated ");
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

  it("keeps keyed row bindings in a single row effect", async () => {
    const source = await readFile("src/runtime/list.ts", "utf8");

    expect(source).not.toContain("effect(() => applyRowBinding");
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
    let items = [{ id: "a1", label: "A1" }];
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
    items = [{ id: "a1", label: "A1 updated" }];
    mountKeyedList(root, [0], [{ id: "a", name: "Group A updated", visible: true, badge: "visible", items }], options);

    expect(json).not.toHaveBeenCalled();
    expect(root.innerHTML).toBe(
      `<ul id="groups"><li><span>Group A updated</span><ul><li>A1 updated</li></ul><!----><em>visible</em></li></ul>`,
    );
  });

  it("updates nested list and conditional children when references stay unchanged", () => {
    document.body.innerHTML = `<section><ul id="groups"></ul></section>`;
    const root = document.body.firstElementChild;
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing root.");
    }
    const item = { id: "a1", label: "A1" };
    const group = { id: "a", name: "Group A", visible: true, badge: "visible", items: [item] };
    const options = {
      signature: "groups-with-guarded-nested-bindings",
      key: "group.id",
      itemName: "group",
      templateHtml: `<li><span> </span><ul></ul><!----></li>`,
      bindings: [
        {
          kind: "text" as const,
          path: [0, 0],
          expression: "group.name",
          read: (scope: Record<string, unknown>) => (scope.group as { name: string }).name,
        },
        {
          kind: "list" as const,
          signature: "guarded-nested-items",
          path: [1],
          each: "group.items",
          read: (scope: Record<string, unknown>) => (scope.group as { items: typeof group.items }).items,
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
          signature: "guarded-nested-visible",
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

    mountKeyedList(root, [0], [group], options);
    item.label = "A1 updated";
    group.badge = "still visible";
    mountKeyedList(root, [0], [group], options);

    expect(root.innerHTML).toBe(
      `<ul id="groups"><li><span>Group A</span><ul><li>A1 updated</li></ul><!----><em>still visible</em></li></ul>`,
    );
  });

  it("cleans up nested row effects when a parent row is removed", () => {
    document.body.innerHTML = `<section><ul id="groups"></ul></section>`;
    const root = document.body.firstElementChild;
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing root.");
    }
    const label = createSignal("A1");
    let nestedReads = 0;
    const options = {
      signature: "groups-with-cleaned-nested-effects",
      key: "group.id",
      itemName: "group",
      templateHtml: `<li><ul></ul></li>`,
      bindings: [
        {
          kind: "list" as const,
          signature: "nested-items-cleanup",
          path: [0],
          each: "group.items",
          read: (scope: Record<string, unknown>) =>
            (scope.group as { items: Array<{ id: string; label: () => string }> }).items,
          itemName: "item",
          key: "item.id",
          templateHtml: `<li> </li>`,
          bindings: [
            {
              kind: "text" as const,
              path: [0],
              expression: "item.label()",
              read: (scope: Record<string, unknown>) => {
                nestedReads += 1;
                return (scope.item as { label: () => string }).label();
              },
            },
          ],
        },
      ],
    };

    mountKeyedList(root, [0], [{ id: "a", items: [{ id: "a1", label }] }], options);
    mountKeyedList(root, [0], [], options);
    nestedReads = 0;
    label.set("A1 updated");

    expect(nestedReads).toBe(0);
    expect(root.innerHTML).toBe(`<ul id="groups"></ul>`);
  });

  it("clears nested conditional refs and listeners when a keyed row is removed", () => {
    document.body.innerHTML = `<ul id="items"></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) throw new Error("Missing test root.");
    const onClick = vi.fn();
    const item: { id: number; visible: boolean; ref?: Element; onClick: () => void } = {
      id: 1,
      visible: true,
      onClick,
    };
    const options = {
      signature: "rows-with-owned-conditional",
      key: "item.id",
      itemName: "item",
      templateHtml: `<li><!----></li>`,
      bindings: [
        {
          kind: "if" as const,
          signature: "owned-conditional",
          path: [0],
          test: "item.visible",
          templateHtml: `<button>Remove</button>`,
          bindings: [
            { kind: "ref" as const, path: [], expression: "item.ref" },
            { kind: "event" as const, path: [], eventName: "click", handler: "item.onClick" },
          ],
        },
      ],
    };

    mountKeyedList(root, [], [item], options);
    const removedButton = item.ref;
    expect(removedButton).toBe(root.querySelector("button"));

    mountKeyedList(root, [], [], options);
    removedButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(item.ref).toBeUndefined();
    expect(onClick).not.toHaveBeenCalled();
    expect(root.childElementCount).toBe(0);

    item.visible = false;
    mountKeyedList(root, [], [item], options);
    expect(root.querySelector("button")).toBeNull();
    expect(() => mountKeyedList(root, [], [], options)).not.toThrow();
  });
});
