import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal, effect, onCleanup } from "../src/runtime/signal";
import { createStore } from "../src/runtime/store";
import { mountKeyedList } from "../src/runtime/list";

// The runtime wraps rows in its region markers; these assertions are about the rows themselves.
const rowsHtml = (element: Element): string =>
  element.innerHTML.replaceAll("<!--tachyon-for-->", "").replaceAll("<!--/tachyon-for-->", "");
const stringify = JSON.stringify;
const nodeEnv = process.env.NODE_ENV;
const warn = console.warn;

afterEach(() => {
  JSON.stringify = stringify;
  process.env.NODE_ENV = nodeEnv;
  console.warn = warn;
});

describe("mountKeyedList", () => {
  // The compatibility entry is the one that still interprets expression strings and applies them through the
  // setters this runtime imports. Splitting the generated entry off left that half reachable only from here, so
  // every kind it has to drive is exercised through a hand-written descriptor.
  it("drives every row binding kind from a hand-written descriptor", () => {
    const root = document.createElement("ul");
    const clicks: string[] = [];
    const scope = { pick: (event: Event) => clicks.push((event.currentTarget as Element).tagName), open: true };
    const options = {
      signature: "every-row-kind",
      key: "item.id",
      itemName: "item",
      templateHtml: `<li><input><b><!----></b></li>`,
      bindings: [
        { kind: "class" as const, path: [], className: "on", expression: "item.on" },
        { kind: "attr" as const, path: [], name: "title", expression: "item.title" },
        { kind: "style" as const, path: [], name: "width", expression: "item.width" },
        { kind: "ref" as const, path: [], expression: "item.node" },
        { kind: "event" as const, path: [], eventName: "click", handler: "pick" },
        { kind: "model" as const, path: [0], property: "value" as const, expression: "item.draft" },
        {
          kind: "if" as const,
          path: [1, 0],
          test: "open",
          templateHtml: `<em> </em>`,
          bindings: [{ kind: "text" as const, path: [0], expression: "item.title" }],
        },
      ],
      scope,
    };
    const item = { id: "a", on: true, title: "Row", width: "8px", draft: "typed", node: undefined as unknown };

    mountKeyedList(root, [], [item], options);
    const row = root.querySelector("li");
    const input = root.querySelector("input");
    if (!(row instanceof HTMLElement) || !(input instanceof HTMLInputElement)) throw new Error("Missing nodes.");

    expect(row.classList.contains("on")).toBe(true);
    expect(row.getAttribute("title")).toBe("Row");
    expect(row.style.width).toBe("8px");
    expect(item.node).toBe(row);
    expect(input.value).toBe("typed");
    expect(root.querySelector("em")?.textContent).toBe("Row");

    row.click();
    expect(clicks).toEqual(["LI"]);

    // The control writes back through the same path string it reads, and a later update pushes a value
    // changed elsewhere back onto it.
    input.value = "edited";
    input.dispatchEvent(new Event("input"));
    expect(item.draft).toBe("edited");
    item.draft = "reset";
    mountKeyedList(root, [], [item], { ...options });
    expect(input.value).toBe("reset");

    mountKeyedList(root, [], [], { ...options });
    expect(item.node).toBeUndefined();
  });

  // A hand-written control may carry a reader, a writer, both, or neither. Each combination decides a different
  // branch of the compatibility writer, so each one writes back through what it actually carries.
  it("writes a hand-written row control back through whatever it carries", () => {
    const written: string[] = [];
    const rowFor = (model: Record<string, unknown>) => ({
      signature: `row-model-${Object.keys(model).sort().join("-")}`,
      key: "item.id",
      itemName: "item",
      templateHtml: `<li><input></li>`,
      bindings: [{ kind: "model" as const, path: [0], property: "value" as const, expression: "item.draft", ...model }],
    });
    const drive = (model: Record<string, unknown>, item: { id: string; draft: string }) => {
      const root = document.createElement("ul");
      mountKeyedList(root, [], [item], rowFor(model));
      const input = root.querySelector("input");
      if (!(input instanceof HTMLInputElement)) throw new Error("Missing control.");
      expect(input.value).toBe(item.draft);
      input.value = "edited";
      input.dispatchEvent(new Event("input"));
      return item.draft;
    };

    expect(drive({}, { id: "a", draft: "typed" })).toBe("edited");
    expect(
      drive(
        { read: (scope: Record<string, unknown>) => (scope.item as { draft: string }).draft },
        { id: "a", draft: "typed" },
      ),
    ).toBe("edited");
    // An explicit writer owns the write outright, so the path string is never walked.
    const item = { id: "a", draft: "typed" };
    expect(
      drive(
        {
          write: (_scope: Record<string, unknown>, value: unknown) => {
            written.push(String(value));
          },
        },
        item,
      ),
    ).toBe("typed");
    expect(written).toEqual(["edited"]);
  });

  // A hand-written descriptor may carry the compiler's container reader instead of a path string, and this
  // entry has to prefer it the way the generated one does - but only when it carries both halves.
  it("writes a hand-written row ref through a container reader when it carries one", () => {
    const root = document.createElement("ul");
    const refs: { node?: Element } = {};
    const item = { id: "a", node: undefined as unknown };
    const descriptorFor = (ref: Record<string, unknown>) => ({
      signature: `row-ref-${Object.keys(ref).join("-")}`,
      key: "item.id",
      itemName: "item",
      templateHtml: `<li></li>`,
      bindings: [{ kind: "ref" as const, path: [], expression: "item.node", ...ref }],
      scope: { refs },
    });

    const both = descriptorFor({ owner: (rowScope: Record<string, unknown>) => rowScope.refs, property: "node" });
    mountKeyedList(root, [], [item], both);
    expect(refs.node).toBe(root.querySelector("li"));
    expect(item.node).toBeUndefined();
    mountKeyedList(root, [], [], both);
    expect(refs.node).toBeUndefined();

    // Half a reader is not a reader.
    for (const half of [{ owner: (rowScope: Record<string, unknown>) => rowScope.refs }, { property: "node" }]) {
      const partial = descriptorFor(half);
      mountKeyedList(root, [], [item], partial);
      expect(item.node).toBe(root.querySelector("li"));
      expect(refs.node).toBeUndefined();
      mountKeyedList(root, [], [], partial);
      expect(item.node).toBeUndefined();
    }
  });

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

  // The parent scope is compared once per update, not once per row, so a list of R rows reads S parent keys
  // O(S) times instead of O(R x S).
  it("reads the parent scope once per update instead of once per row", () => {
    const root = document.createElement("ul");
    let reads = 0;
    const scope: Record<string, unknown> = {};
    Object.defineProperty(scope, "shared", {
      enumerable: true,
      configurable: true,
      get: () => {
        reads++;
        return "S";
      },
    });
    const options = {
      key: "item.id",
      itemName: "item",
      templateHtml: `<li><span> </span></li>`,
      bindings: [
        {
          kind: "text" as const,
          path: [0, 0],
          expression: "shared",
          read: (rowScope: Record<string, unknown>) => rowScope.shared,
        },
      ],
      scope,
    };
    const rows = Array.from({ length: 20 }, (_, index) => ({ id: `row-${index}` }));

    mountKeyedList(root, [], rows, options);
    reads = 0;
    mountKeyedList(root, [], rows, options);

    expect(reads).toBeLessThanOrEqual(2);
    expect(root.querySelectorAll("li").length).toBe(20);
    expect(root.textContent).toBe("S".repeat(20));
  });

  // The compiler bounds the parent keys a list's rows can read, so unrelated parent state is never read, copied,
  // or able to make rows look changed.
  it("ignores parent keys outside the compiler's bounded set", () => {
    const root = document.createElement("ul");
    const reads: string[] = [];
    const scope: Record<string, unknown> = { shared: "S" };
    Object.defineProperty(scope, "unrelated", {
      enumerable: true,
      configurable: true,
      get: () => {
        reads.push("unrelated");
        return "U";
      },
    });
    const options = () => ({
      key: "item.id",
      itemName: "item",
      parentScopeKeys: ["shared"],
      templateHtml: `<li><span> </span></li>`,
      bindings: [
        {
          kind: "text" as const,
          path: [0, 0],
          expression: "shared",
          read: (rowScope: Record<string, unknown>) => rowScope.shared,
        },
      ],
      updatePolicy: "reference" as const,
      scope,
    });
    const rows = [{ id: "a" }, { id: "b" }];

    mountKeyedList(root, [], rows, options());
    expect(root.textContent).toBe("SS");
    expect(reads).toEqual([]);

    const revisions = () => Array.from(root.querySelectorAll("li"), (row) => row.textContent);
    scope.shared = "S2";
    mountKeyedList(root, [], rows, options());
    expect(revisions()).toEqual(["S2", "S2"]);
    expect(reads).toEqual([]);
  });

  // A reactive list re-runs whenever the outer effect's dependencies change. Reading only the bounded parent keys
  // means an unrelated store field never becomes one of those dependencies.
  it("does not re-run a reactive list when unrelated parent store fields change", () => {
    const runRows = (parentScopeKeys?: readonly string[]) => {
      const root = document.createElement("ul");
      const scope = createStore({ shared: "S", form: "F" });
      let listRuns = 0;
      const dispose = createRoot((disposeRoot) => {
        effect(() => {
          listRuns++;
          mountKeyedList(root, [], [{ id: "a" }], {
            key: "item.id",
            itemName: "item",
            templateHtml: `<li><span> </span></li>`,
            bindings: [
              {
                kind: "text" as const,
                path: [0, 0],
                expression: "shared",
                read: (rowScope: Record<string, unknown>) => rowScope.shared,
              },
            ],
            scope,
            ...(parentScopeKeys ? { parentScopeKeys } : {}),
          });
        });
        return disposeRoot;
      });
      const afterMount = listRuns;
      scope.form = "F2";
      const afterUnrelated = listRuns;
      scope.shared = "S2";
      const afterRelated = listRuns;
      const text = root.textContent;
      dispose();
      return { afterMount, afterUnrelated, afterRelated, text };
    };

    expect(runRows(["shared"])).toEqual({ afterMount: 1, afterUnrelated: 1, afterRelated: 2, text: "S2" });
    expect(runRows()).toEqual({ afterMount: 1, afterUnrelated: 2, afterRelated: 3, text: "S2" });
  });

  // The default policy re-reads a row on every update, so a component prop reading the same item object's
  // internals has to be recomputed even though the item reference did not change.
  it("recomputes component props when a kept item's internals change", () => {
    const root = document.createElement("ul");
    const item = { id: 1, label: "before" };
    const options = {
      key: "item.id",
      itemName: "item",
      templateHtml: `<li> </li>`,
      bindings: [{ kind: "text" as const, path: [0], expression: "label" }],
      components: [{ path: [], name: "Row", props: [{ name: "label", expression: "item.label" }], stores: [] }],
    };

    mountKeyedList(root, [], [item], options);
    const firstRow = root.firstChild;
    expect(root.textContent).toBe("before");

    item.label = "after";
    mountKeyedList(root, [], [item], options);

    expect(root.textContent).toBe("after");
    expect(root.firstChild).toBe(firstRow);
  });

  it("keeps a reference-policy row untouched when nothing it owns changed", () => {
    const root = document.createElement("ul");
    const item = { id: 1, label: "same" };
    let propReads = 0;
    const options = {
      key: "item.id",
      itemName: "item",
      updatePolicy: "reference" as const,
      templateHtml: `<li> </li>`,
      bindings: [{ kind: "text" as const, path: [0], expression: "label" }],
      components: [
        {
          path: [],
          name: "Row",
          props: [
            {
              name: "label",
              expression: "item.label",
              read: (scope: Record<string, unknown>) => {
                propReads++;
                return (scope.item as { label: string }).label;
              },
            },
          ],
          stores: [],
        },
      ],
    };

    mountKeyedList(root, [], [item], options);
    const afterMount = propReads;
    mountKeyedList(root, [], [item], options);

    expect(root.textContent).toBe("same");
    expect(propReads).toBe(afterMount + 1);
  });

  it("keeps tracking every parent key when the compiler cannot bound them", () => {
    const root = document.createElement("ul");
    const scope: Record<string, unknown> = { shared: "S" };
    const options = () => ({
      key: "item.id",
      itemName: "item",
      templateHtml: `<li><span> </span></li>`,
      bindings: [
        {
          kind: "text" as const,
          path: [0, 0],
          expression: "shared",
          read: (rowScope: Record<string, unknown>) => rowScope.shared,
        },
      ],
      scope,
    });
    const rows = [{ id: "a" }];

    mountKeyedList(root, [], rows, options());
    scope.shared = "S2";
    mountKeyedList(root, [], rows, options());

    expect(root.textContent).toBe("S2");
  });

  it("applies parent scope changes to every row and clears removed parent keys", () => {
    const root = document.createElement("ul");
    const options = (scope: Record<string, unknown>) => ({
      key: "item.id",
      itemName: "item",
      templateHtml: `<li><span> </span><b> </b></li>`,
      bindings: [
        {
          kind: "text" as const,
          path: [0, 0],
          expression: "shared",
          read: (rowScope: Record<string, unknown>) => rowScope.shared,
        },
        {
          kind: "text" as const,
          path: [1, 0],
          expression: "extra",
          read: (rowScope: Record<string, unknown>) => rowScope.extra,
        },
      ],
      scope,
    });
    const rows = [{ id: "a" }, { id: "b" }];

    mountKeyedList(root, [], rows, options({ shared: "S1", extra: "E1" }));
    expect(root.textContent).toBe("S1E1S1E1");

    mountKeyedList(root, [], rows, options({ shared: "S2", extra: "E1" }));
    expect(root.textContent).toBe("S2E1S2E1");

    mountKeyedList(root, [], rows, options({ shared: "S2" }));
    expect(root.textContent).toBe("S2S2");

    mountKeyedList(root, [], [...rows, { id: "c" }], options({ shared: "S3", extra: "E3" }));
    expect(root.textContent).toBe("S3E3S3E3S3E3");
  });

  it("keeps row-local names shadowing parent keys of the same name", () => {
    const root = document.createElement("ul");
    const options = (scope: Record<string, unknown>) => ({
      key: "item.id",
      itemName: "item",
      indexName: "position",
      templateHtml: `<li><span> </span></li>`,
      bindings: [
        {
          kind: "text" as const,
          path: [0, 0],
          expression: "label",
          read: (rowScope: Record<string, unknown>) => rowScope.label,
        },
      ],
      stores: [
        {
          name: "label",
          initial: "item.id",
          read: (rowScope: Record<string, unknown>) => (rowScope.item as { id: string }).id,
        },
      ],
      scope,
    });
    const rows = [{ id: "a" }, { id: "b" }];

    mountKeyedList(root, [], rows, options({ label: "parent", position: "parent-position" }));
    expect(root.textContent).toBe("ab");

    mountKeyedList(root, [], rows, options({ label: "changed", position: "changed" }));
    expect(root.textContent).toBe("ab");
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
    expect(insertBefore).not.toHaveBeenCalled();
    mountKeyedList(root, [], [...rows, { id: "c" }], options);

    // Only the new row is inserted, and it goes straight before the region's end marker: no retained row moves.
    expect(insertBefore).toHaveBeenCalledTimes(1);
    expect(insertBefore.mock.calls[0]?.[0]).toBe(root.children[2]);
    expect(insertBefore.mock.calls[0]?.[1]).toBe(root.lastChild);
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

  it("evaluates literal row store initializers when no generated reader is supplied", () => {
    const root = document.createElement("ul");
    const options = {
      key: "item.id",
      itemName: "item",
      templateHtml: `<li> </li>`,
      stores: [{ name: "count", initial: "0" }],
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

    expect(rowsHtml(root)).toBe(`<li><span>One</span></li><li class="danger"><span>Two</span></li>`);
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
    expect(rowsHtml(root)).toBe(`<li><span>Three updated</span></li><li><span>One updated</span></li>`);
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
    expect(rowsHtml(root)).toBe(`<li><span>One</span></li><li><span>Two</span></li>`);

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
    expect(rowsHtml(root)).toBe(`<li><span>Two updated</span></li><li><span>One updated</span></li>`);
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
    expect(rowsHtml(root)).toBe(`<li><span>Two</span></li><li><span>One</span></li>`);
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
    expect(rowsHtml(root)).toBe(`<li class="row">One</li><li class="row">Two</li><li class="footer">Footer</li>`);
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
    expect(rowsHtml(root)).toBe(
      `<li class="row">Two updated</li><li class="row">One updated</li><li class="footer">Footer</li>`,
    );
    mountKeyedList(root, [], [], options);
    expect(rowsHtml(root)).toBe(`<li class="footer">Footer</li>`);
  });

  it("defers row bindings until interaction hydration and disposes them with the keyed row", () => {
    document.body.innerHTML =
      `<ul id="items"><!--tachyon-hydrate:a:start--><li><button>Server A</button></li><!--tachyon-hydrate:a:end-->` +
      `<!--tachyon-hydrate:b:start--><li><button>Server B</button></li><!--tachyon-hydrate:b:end--></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) throw new Error("Missing test root.");
    const calls: string[] = [];
    const options = {
      signature: "row-interaction-hydration",
      key: "item.id",
      itemName: "item",
      templateHtml: `<li><button> </button></li>`,
      bindings: [
        { kind: "text" as const, path: [0, 0], expression: "item.label" },
        {
          kind: "event" as const,
          path: [0],
          eventName: "click",
          handler: "item.onClick",
          read: (scope: Record<string, unknown>) => (scope.item as { onClick: () => void }).onClick,
        },
      ],
      hydrationBoundaries: [
        {
          path: [],
          id: "item.id",
          idKind: "expression" as const,
          strategy: "interaction" as const,
          interaction: "click",
        },
      ],
    };
    const first = { id: "a", label: "A", onClick: () => calls.push("a") };
    const second = { id: "b", label: "B", onClick: () => calls.push("b") };

    mountKeyedList(root, [], [first, second], options);
    const firstButton = root.querySelector("button");
    if (!(firstButton instanceof HTMLButtonElement)) throw new Error("Missing first button.");
    expect(firstButton.textContent).toBe("Server A");

    firstButton.click();

    expect(firstButton.textContent).toBe("A");
    expect(calls).toEqual(["a"]);

    mountKeyedList(root, [], [second, first], options);
    const reorderedButton = root.querySelectorAll("button")[1];
    if (!(reorderedButton instanceof HTMLButtonElement)) throw new Error("Missing reordered button.");
    reorderedButton.click();
    expect(calls).toEqual(["a", "a"]);

    mountKeyedList(root, [], [second], options);
    reorderedButton.click();
    expect(calls).toEqual(["a", "a"]);
  });

  it("lets the innermost row boundary own a nested event binding so it fires once", () => {
    document.body.innerHTML = `<ul id="items"><!--tachyon-hydrate:a:start--><li><p>Server A</p><!--tachyon-hydrate:a-inner:start--><span><button>Go</button></span><!--tachyon-hydrate:a-inner:end--></li><!--tachyon-hydrate:a:end--></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) throw new Error("Missing test root.");
    const calls: string[] = [];
    const options = {
      signature: "row-nested-hydration",
      key: "item.id",
      itemName: "item",
      templateHtml: `<li><p> </p><span><button>Go</button></span></li>`,
      bindings: [
        { kind: "text" as const, path: [0, 0], expression: "item.label" },
        {
          kind: "event" as const,
          path: [1, 0],
          eventName: "click",
          handler: "item.onClick",
          read: (scope: Record<string, unknown>) => (scope.item as { onClick: () => void }).onClick,
        },
      ],
      hydrationBoundaries: [
        // A boundary without a path covers the whole row; the inner one is declared first on purpose.
        {
          path: [1],
          id: "item.innerId",
          idKind: "expression" as const,
          strategy: "interaction" as const,
          interaction: "focusin",
        },
        { id: "item.id", idKind: "expression" as const, strategy: "load" as const },
      ],
    };
    const item = { id: "a", innerId: "a-inner", label: "A", onClick: () => calls.push("a") };

    mountKeyedList(root, [], [item], options);
    const button = root.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) throw new Error("Missing button.");
    // The outer boundary hydrated on load and owns the text, not the button inside the inner boundary.
    expect(root.querySelector("p")?.textContent).toBe("A");
    button.click();
    expect(calls).toEqual([]);

    button.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    button.click();
    expect(calls).toEqual(["a"]);
    button.click();
    expect(calls).toEqual(["a", "a"]);

    mountKeyedList(root, [], [], options);
    button.click();
    expect(calls).toEqual(["a", "a"]);
  });

  it("assigns three nested row boundaries exclusively across several adopted rows", () => {
    const row = (id: string, label: string) =>
      `<!--tachyon-hydrate:${id}:start--><li><p>${label}</p><!--tachyon-hydrate:${id}-mid:start--><div><button>Mid</button><!--tachyon-hydrate:${id}-inner:start--><span><button>Inner</button></span><!--tachyon-hydrate:${id}-inner:end--></div><!--tachyon-hydrate:${id}-mid:end--></li><!--tachyon-hydrate:${id}:end-->`;
    document.body.innerHTML = `<ul id="items">${row("a", "Server A")}${row("b", "Server B")}</ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) throw new Error("Missing test root.");
    const calls: string[] = [];
    const handler = (name: string) => ({
      kind: "event" as const,
      eventName: "click",
      handler: `item.${name}`,
      read: (scope: Record<string, unknown>) => (scope.item as Record<string, () => void>)[name],
    });
    const options = {
      signature: "row-three-level-hydration",
      key: "item.id",
      itemName: "item",
      templateHtml: `<li><p> </p><div><button>Mid</button><span><button>Inner</button></span></div></li>`,
      bindings: [
        { kind: "text" as const, path: [0, 0], expression: "item.label" },
        { ...handler("onMid"), path: [1, 0] },
        { ...handler("onInner"), path: [1, 1, 0] },
      ],
      hydrationBoundaries: [
        {
          path: [1, 1],
          id: "item.innerId",
          idKind: "expression" as const,
          strategy: "interaction" as const,
          interaction: "focusin",
        },
        { id: "item.id", idKind: "expression" as const, strategy: "load" as const },
        {
          path: [1],
          id: "item.midId",
          idKind: "expression" as const,
          strategy: "interaction" as const,
          interaction: "mouseover",
        },
      ],
    };
    const item = (id: string) => ({
      id,
      midId: `${id}-mid`,
      innerId: `${id}-inner`,
      label: id.toUpperCase(),
      onMid: () => calls.push(`${id}-mid`),
      onInner: () => calls.push(`${id}-inner`),
    });

    mountKeyedList(root, [], [item("a"), item("b")], options);
    const buttons = Array.from(root.querySelectorAll("button"));
    expect(buttons).toHaveLength(4);
    expect(Array.from(root.querySelectorAll("p"), (p) => p.textContent)).toEqual(["A", "B"]);
    for (const button of buttons) button.click();
    expect(calls).toEqual([]);

    // Hydrating the middle boundary of the second row binds only its own button.
    buttons[2]!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    buttons[2]!.click();
    buttons[3]!.click();
    expect(calls).toEqual(["b-mid"]);

    // Hydrating the innermost boundary binds the inner button exactly once, even after the middle one hydrated.
    buttons[3]!.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    buttons[3]!.click();
    expect(calls).toEqual(["b-mid", "b-inner"]);

    buttons[1]!.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    buttons[1]!.click();
    buttons[0]!.click();
    expect(calls).toEqual(["b-mid", "b-inner", "a-inner"]);

    mountKeyedList(root, [], [], options);
    for (const button of buttons) button.click();
    expect(calls).toEqual(["b-mid", "b-inner", "a-inner"]);
  });

  it("binds hydration-marked rows eagerly when the row is created on the client without SSR markers", () => {
    document.body.innerHTML = `<ul id="items"></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) throw new Error("Missing test root.");
    const calls: string[] = [];
    const options = {
      signature: "row-interaction-hydration-client-created",
      key: "item.id",
      itemName: "item",
      templateHtml: `<li><button> </button></li>`,
      bindings: [
        { kind: "text" as const, path: [0, 0], expression: "item.label" },
        {
          kind: "event" as const,
          path: [0],
          eventName: "click",
          handler: "item.onClick",
          read: (scope: Record<string, unknown>) => (scope.item as { onClick: () => void }).onClick,
        },
      ],
      hydrationBoundaries: [
        {
          path: [],
          id: "item.id",
          idKind: "expression" as const,
          strategy: "interaction" as const,
          interaction: "click",
        },
      ],
    };
    const first = { id: "a", label: "A", onClick: () => calls.push("a") };

    mountKeyedList(root, [], [first], options);
    const button = root.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) throw new Error("Missing button.");
    expect(button.textContent).toBe("A");

    button.click();
    expect(calls).toEqual(["a"]);

    const second = { id: "b", label: "B", onClick: () => calls.push("b") };
    mountKeyedList(root, [], [first, second], options);
    const appended = root.querySelectorAll("button")[1];
    if (!(appended instanceof HTMLButtonElement)) throw new Error("Missing appended button.");
    expect(appended.textContent).toBe("B");
    appended.click();
    expect(calls).toEqual(["a", "b"]);

    mountKeyedList(root, [], [], options);
    appended.click();
    button.click();
    expect(calls).toEqual(["a", "b"]);
    expect(rowsHtml(root)).toBe("");
  });

  it("rejects adopted SSR rows whose hydration markers are duplicated even when row keys are unique", () => {
    document.body.innerHTML =
      `<ul id="items"><!--tachyon-hydrate:same:start--><li><button>Server A</button></li><!--tachyon-hydrate:same:end-->` +
      `<!--tachyon-hydrate:same:start--><li><button>Server B</button></li><!--tachyon-hydrate:same:end--></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) throw new Error("Missing test root.");
    const calls: string[] = [];
    const options = {
      signature: "row-duplicate-hydration-id",
      key: "item.id",
      itemName: "item",
      templateHtml: `<li><button> </button></li>`,
      bindings: [
        { kind: "text" as const, path: [0, 0], expression: "item.label" },
        {
          kind: "event" as const,
          path: [0],
          eventName: "click",
          handler: "item.onClick",
          read: (scope: Record<string, unknown>) => (scope.item as { onClick: () => void }).onClick,
        },
      ],
      hydrationBoundaries: [
        {
          path: [],
          id: "item.hydrationId",
          idKind: "expression" as const,
          strategy: "interaction" as const,
          interaction: "click",
        },
      ],
    };
    const rows = [
      { id: "a", hydrationId: "same", label: "A", onClick: () => calls.push("a") },
      { id: "b", hydrationId: "same", label: "B", onClick: () => calls.push("b") },
    ];

    expect(() => mountKeyedList(root, [], rows, options)).toThrow(/Duplicate hydrate boundary markers for same/);
    for (const button of Array.from(root.querySelectorAll("button"))) button.click();
    expect(calls).toEqual([]);
  });

  it("binds row bindings outside every boundary eagerly while the boundary's own bindings stay deferred", () => {
    document.body.innerHTML = `<ul id="items"><li><span>Server A</span><!--tachyon-hydrate:a:start--><button>Go</button><!--tachyon-hydrate:a:end--></li></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) throw new Error("Missing test root.");
    const calls: string[] = [];
    const options = {
      signature: "row-partial-boundary-eager-outside",
      key: "item.id",
      itemName: "item",
      templateHtml: `<li><span> </span><button>Go</button></li>`,
      bindings: [
        { kind: "text" as const, path: [0, 0], expression: "item.label" },
        {
          kind: "event" as const,
          path: [1],
          eventName: "click",
          handler: "item.onClick",
          read: (scope: Record<string, unknown>) => (scope.item as { onClick: () => void }).onClick,
        },
      ],
      hydrationBoundaries: [
        {
          path: [1],
          id: "item.id",
          idKind: "expression" as const,
          strategy: "interaction" as const,
          interaction: "focusin",
        },
      ],
    };
    mountKeyedList(root, [], [{ id: "a", label: "A", onClick: () => calls.push("a") }], options);
    const button = root.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) throw new Error("Missing button.");
    // The text sits outside the boundary, so it is bound as soon as the row is adopted.
    expect(root.querySelector("span")?.textContent).toBe("A");
    button.click();
    expect(calls).toEqual([]);
    button.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    button.click();
    expect(calls).toEqual(["a"]);
    mountKeyedList(root, [], [], options);
  });

  it("keeps adopted server nodes in place when an eager binding fails after the preflight", () => {
    document.body.innerHTML = `<ul id="items"><li><span>Server A</span><!--tachyon-hydrate:a:start--><button>Go</button><!--tachyon-hydrate:a:end--></li></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) throw new Error("Missing test root.");
    const before = root.innerHTML;
    const options = {
      signature: "row-eager-binding-failure",
      key: "item.id",
      itemName: "item",
      templateHtml: `<li><span> </span><button>Go</button></li>`,
      bindings: [
        {
          kind: "text" as const,
          path: [0, 0],
          expression: "item.label",
          read: () => {
            throw new Error("label failed");
          },
        },
      ],
      hydrationBoundaries: [
        {
          path: [1],
          id: "item.id",
          idKind: "expression" as const,
          strategy: "interaction" as const,
          interaction: "focusin",
        },
      ],
    };
    expect(() => mountKeyedList(root, [], [{ id: "a", label: "A" }], options)).toThrow(/label failed/);
    expect(rowsHtml(root)).toBe(before);
  });

  it("preflights every adopted SSR row before binding and preserves the existing DOM on failure", () => {
    document.body.innerHTML =
      `<ul id="items"><!--tachyon-hydrate:a:start--><li><span>Server A</span><button>Server A</button></li><!--tachyon-hydrate:a:end-->` +
      `<li><span>Server B</span><button>Server B</button></li></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) throw new Error("Missing test root.");
    const before = root.innerHTML;
    let reads = 0;
    const options = {
      signature: "row-preflight-before-binding",
      key: "item.id",
      itemName: "item",
      templateHtml: `<li><span> </span><button> </button></li>`,
      bindings: [
        {
          kind: "text" as const,
          path: [0, 0],
          expression: "item.label",
          read: () => {
            reads++;
            return "bound";
          },
        },
      ],
      hydrationBoundaries: [
        { path: [1], id: "item.id", idKind: "expression" as const, strategy: "interaction" as const },
      ],
    };

    expect(() =>
      mountKeyedList(
        root,
        [],
        [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        options,
      ),
    ).toThrow(/could not be adopted/);
    expect(reads).toBe(0);
    expect(rowsHtml(root)).toBe(before);
  });

  it("keeps SSR-adopted and client-created hydration rows separate through reorder, removal, and re-append", () => {
    document.body.innerHTML = `<ul id="items"><!--tachyon-hydrate:a:start--><li><button>Server A</button></li><!--tachyon-hydrate:a:end--></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) throw new Error("Missing test root.");
    const calls: string[] = [];
    const options = {
      signature: "row-mixed-adoption",
      key: "item.id",
      itemName: "item",
      templateHtml: `<li><button> </button></li>`,
      bindings: [
        { kind: "text" as const, path: [0, 0], expression: "item.label" },
        {
          kind: "event" as const,
          path: [0],
          eventName: "click",
          handler: "item.onClick",
          read: (scope: Record<string, unknown>) => (scope.item as { onClick: () => void }).onClick,
        },
      ],
      hydrationBoundaries: [
        {
          path: [],
          id: "item.id",
          idKind: "expression" as const,
          strategy: "interaction" as const,
          interaction: "click",
        },
      ],
    };
    const a = { id: "a", label: "A", onClick: () => calls.push("a") };
    const b = { id: "b", label: "B", onClick: () => calls.push("b") };

    mountKeyedList(root, [], [a], options);
    mountKeyedList(root, [], [a, b], options);
    const buttons = () => Array.from(root.querySelectorAll("button")) as HTMLButtonElement[];
    expect(buttons().map((button) => button.textContent)).toEqual(["Server A", "B"]);

    buttons()[1]?.click();
    expect(calls).toEqual(["b"]);
    buttons()[0]?.click();
    expect(calls).toEqual(["b", "a"]);
    expect(buttons()[0]?.textContent).toBe("A");

    mountKeyedList(root, [], [b, a], options);
    expect(buttons().map((button) => button.textContent)).toEqual(["B", "A"]);
    buttons()[0]?.click();
    buttons()[1]?.click();
    expect(calls).toEqual(["b", "a", "b", "a"]);

    const removed = buttons()[1] as HTMLButtonElement;
    mountKeyedList(root, [], [b], options);
    removed.click();
    expect(calls).toEqual(["b", "a", "b", "a"]);

    const a2 = { id: "a", label: "A2", onClick: () => calls.push("a2") };
    mountKeyedList(root, [], [b, a2], options);
    buttons()[1]?.click();
    expect(calls).toEqual(["b", "a", "b", "a", "a2"]);
    mountKeyedList(root, [], [], options);
    expect(rowsHtml(root)).toBe("");
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

    expect(rowsHtml(root)).toBe(`<li class="row">One</li><li class="footer">Footer</li>`);
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
    expect(rowsHtml(root)).toBe(`<h2>Two updated</h2><p>Second updated</p><h2>One updated</h2><p>First updated</p>`);
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

    expect(rowsHtml(root)).toBe(`<h2>One</h2><section><ul><li>Two</li></ul><!----><em>visible</em></section>`);
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
    expect(rowsHtml(root)).toBe("");
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

    expect(rowsHtml(root)).toBe(`<li><span>Guest Ada</span></li>`);
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
    expect(rowsHtml(root)).toBe(`<li><span>One</span></li>`);
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
    expect(rowsHtml(root)).toBe(`<li><span>One updated</span></li>`);
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

    expect(rowsHtml(root)).toBe(
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
    expect(rowsHtml(root)).toBe(
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

    expect(rowsHtml(root)).toBe(
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
    expect(rowsHtml(root)).toBe(`<ul id="groups"></ul>`);
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
