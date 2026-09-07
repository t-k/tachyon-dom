// The reconciliation core both keyed list runtimes share. It used to exist twice, reachable only through a
// full list mount; now it is one module with its own regressions.
import { describe, expect, it } from "vitest";
import {
  canAppendWithoutMoving,
  dynamicElementsFor,
  longestIncreasingSubsequencePositions,
  moveBefore,
  parentScopeNames,
  parentScopeValuesFor,
  positionRecords,
  readItemPath,
  readPath,
  replaceDynamicRegion,
  scopedItemFromSnapshot,
  syncParentScope,
  type ParentScopeSnapshot,
} from "../src/runtime/list-core";

const rowsIn = (container: Element): string[] => Array.from(container.children).map((child) => child.id);

const listOf = (keys: readonly string[]): { container: Element; records: Map<PropertyKey, { key: PropertyKey; nodes: Node[] }> } => {
  const container = document.createElement("ul");
  const records = new Map<PropertyKey, { key: PropertyKey; nodes: Node[] }>();
  for (const key of keys) {
    const element = document.createElement("li");
    element.id = key;
    container.append(element);
    records.set(key, { key, nodes: [element] });
  }
  return { container, records };
};

describe("keyed list core", () => {
  describe("path readers", () => {
    it("walks a dotted path and stops at anything that cannot be walked", () => {
      expect(readPath({ a: { b: { c: 1 } } }, "a.b.c")).toBe(1);
      expect(readPath({ a: null }, "a.b")).toBeUndefined();
      expect(readPath({ a: 5 }, "a.b")).toBeUndefined();
      expect(readPath({ a: "text" }, "a.length")).toBeUndefined();
      expect(readPath({ a: { b: 2 } }, "a")).toEqual({ b: 2 });
      expect(readPath({}, "missing")).toBeUndefined();
    });

    it("reads the item itself, a path under it, and nothing else", () => {
      const item = { label: "L", nested: { deep: "D" } };

      expect(readItemPath(item, "item", "item")).toBe(item);
      expect(readItemPath(item, "item.label", "item")).toBe("L");
      expect(readItemPath(item, "item.nested.deep", "item")).toBe("D");
      expect(readItemPath(item, "other.label", "item")).toBeUndefined();
      // A name that only shares a prefix is not the item name.
      expect(readItemPath(item, "items.label", "item")).toBeUndefined();
      // A parent path whose head happens to be as long as the item name still must not resolve against the
      // item: without the prefix check, "data.label" under item name "row" would read the item's own label.
      expect(readItemPath(item, "data.label", "row")).toBeUndefined();
    });
  });

  describe("parent scope", () => {
    it("names every key when the compiler proved none, and only the proven ones otherwise", () => {
      const scope = { a: 1, b: 2 };

      expect(parentScopeNames(scope, undefined)).toEqual(["a", "b"]);
      expect(parentScopeNames(scope, ["b"])).toEqual(["b"]);
      expect(parentScopeNames(undefined, ["b"])).toEqual([]);
      expect([...parentScopeValuesFor(scope, ["b"])]).toEqual([["b", 2]]);
      expect([...parentScopeValuesFor(undefined, undefined)]).toEqual([]);
    });

    it("keeps the previous snapshot only while the scope it describes is unchanged", () => {
      const scope: Record<string, unknown> = { a: 1, b: 2 };
      const state: { parentScope: ParentScopeSnapshot } = {
        parentScope: { scope: undefined, values: new Map() },
      };

      const first = syncParentScope(state, scope, undefined);
      expect([...first.values]).toEqual([
        ["a", 1],
        ["b", 2],
      ]);
      // Nothing changed, so every row shares the snapshot it already had.
      expect(syncParentScope(state, scope, undefined)).toBe(first);

      scope.b = 3;
      const changed = syncParentScope(state, scope, undefined);
      expect(changed).not.toBe(first);
      expect(changed.values.get("b")).toBe(3);

      // A key the compiler did not prove is not compared at all.
      scope.a = 99;
      const bounded = syncParentScope(state, scope, ["b"]);
      expect(syncParentScope(state, scope, ["b"])).toBe(bounded);
      expect([...bounded.values]).toEqual([["b", 3]]);

      // A different scope object is a different snapshot even with equal values.
      expect(syncParentScope(state, { ...scope }, ["b"])).not.toBe(bounded);
    });

    it("adds a key that appears and drops one that disappears", () => {
      const state: { parentScope: ParentScopeSnapshot } = {
        parentScope: { scope: undefined, values: new Map() },
      };
      const scope: Record<string, unknown> = { a: 1 };

      const first = syncParentScope(state, scope, undefined);
      scope.b = 2;
      const grown = syncParentScope(state, scope, undefined);
      expect(grown).not.toBe(first);
      expect([...grown.values.keys()]).toEqual(["a", "b"]);

      delete scope.a;
      const shrunk = syncParentScope(state, scope, undefined);
      expect([...shrunk.values.keys()]).toEqual(["b"]);
    });

    it("builds a row scope from the snapshot, the item, and the index", () => {
      const parent = new Map<string, unknown>([["outer", "O"]]);

      expect(scopedItemFromSnapshot("item", { id: 1 }, "index", 3, parent)).toEqual({
        outer: "O",
        item: { id: 1 },
        index: 3,
      });
      expect(scopedItemFromSnapshot("item", { id: 1 }, undefined, 3, parent)).toEqual({
        outer: "O",
        item: { id: 1 },
      });
    });
  });

  describe("ordering", () => {
    it("keeps the longest increasing run and skips the positions marked as new", () => {
      // The positions come back from the last anchor to the first, so they are sorted before comparing.
      expect([...longestIncreasingSubsequencePositions([0, 1, 2, 3])].sort()).toEqual([0, 1, 2, 3]);
      expect([...longestIncreasingSubsequencePositions([3, 2, 1, 0])]).toEqual([3]);
      expect([...longestIncreasingSubsequencePositions([0, 3, 1, 2])].sort()).toEqual([0, 2, 3]);
      // A negative marks a row that has no previous position, so it never anchors the others.
      expect([...longestIncreasingSubsequencePositions([-1, -1])]).toEqual([]);
      expect([...longestIncreasingSubsequencePositions([2, -1, 5])].sort()).toEqual([0, 2]);
      expect([...longestIncreasingSubsequencePositions([])]).toEqual([]);
    });

    it("moves only the rows whose order changed", () => {
      const { container, records } = listOf(["a", "b", "c", "d"]);
      const ordered = ["d", "a", "b", "c"].map((key) => records.get(key) as { key: PropertyKey; nodes: Node[] });

      positionRecords(container, ordered, records, null);

      expect(rowsIn(container)).toEqual(["d", "a", "b", "c"]);
    });

    it("moves only the middle when the order shares a prefix and a suffix", () => {
      const { container, records } = listOf(["a", "b", "c", "d", "e"]);
      const ordered = ["a", "d", "c", "b", "e"].map((key) => records.get(key) as { key: PropertyKey; nodes: Node[] });

      positionRecords(container, ordered, records, null);

      expect(rowsIn(container)).toEqual(["a", "d", "c", "b", "e"]);
    });

    it("places a row inserted into the middle without disturbing the rows around it", () => {
      const { container, records } = listOf(["a", "b", "c"]);
      const added = document.createElement("li");
      added.id = "x";
      container.append(added);
      const ordered = [
        records.get("a") as { key: PropertyKey; nodes: Node[] },
        { key: "x", nodes: [added as Node] },
        records.get("b") as { key: PropertyKey; nodes: Node[] },
        records.get("c") as { key: PropertyKey; nodes: Node[] },
      ];

      positionRecords(container, ordered, records, null);

      expect(rowsIn(container)).toEqual(["a", "x", "b", "c"]);
    });

    it("positions a shorter and a longer order against the same previous rows", () => {
      const { container, records } = listOf(["a", "b", "c", "d"]);
      const shorter = ["d", "a"].map((key) => records.get(key) as { key: PropertyKey; nodes: Node[] });

      positionRecords(container, shorter, records, null);
      expect(rowsIn(container).slice(0, 2)).toEqual(["d", "a"]);

      const grown = listOf(["a", "b"]);
      const extra = document.createElement("li");
      extra.id = "z";
      grown.container.append(extra);
      positionRecords(
        grown.container,
        [
          { key: "z", nodes: [extra as Node] },
          grown.records.get("a") as { key: PropertyKey; nodes: Node[] },
          grown.records.get("b") as { key: PropertyKey; nodes: Node[] },
        ],
        grown.records,
        null,
      );
      expect(rowsIn(grown.container)).toEqual(["z", "a", "b"]);
    });

    it("moves every node of a multi-node row together", () => {
      const container = document.createElement("ul");
      const rowOf = (key: string, ids: readonly string[]) => {
        const nodes = ids.map((id) => {
          const element = document.createElement("li");
          element.id = id;
          container.append(element);
          return element as Node;
        });
        return { key, nodes };
      };
      const first = rowOf("a", ["a1", "a2"]);
      const second = rowOf("b", ["b1", "b2"]);
      const previous = new Map<PropertyKey, { key: PropertyKey; nodes: Node[] }>([
        ["a", first],
        ["b", second],
      ]);

      positionRecords(container, [second, first], previous, null);

      expect(rowsIn(container)).toEqual(["b1", "b2", "a1", "a2"]);
    });

    // The promise of the prefix, suffix, and longest-increasing-subsequence work is that a reorder touches the
    // fewest rows it can. Only counting the moves can hold it to that.
    it("moves the fewest rows a reorder needs", () => {
      const movesFor = (previousKeys: readonly string[], nextKeys: readonly string[]): number => {
        const { container, records } = listOf(previousKeys);
        let moves = 0;
        const insertBefore = container.insertBefore.bind(container);
        container.insertBefore = <T extends Node>(node: T, before: Node | null): T => {
          moves += 1;
          return insertBefore(node, before) as T;
        };
        positionRecords(
          container,
          nextKeys.map((key) => records.get(key) as { key: PropertyKey; nodes: Node[] }),
          records,
          null,
        );
        expect(rowsIn(container)).toEqual([...nextKeys]);
        return moves;
      };

      expect(movesFor(["a", "b", "c", "d"], ["d", "a", "b", "c"])).toBe(1);
      expect(movesFor(["a", "b", "c", "d", "e"], ["a", "d", "c", "b", "e"])).toBe(2);
      expect(movesFor(["a", "b", "c"], ["a", "b", "c"])).toBe(0);
      expect(movesFor(["a", "b", "c"], ["c", "b", "a"])).toBe(2);
    });

    it("leaves an unchanged order untouched and stops before the trailing static nodes", () => {
      const { container, records } = listOf(["a", "b"]);
      const trailer = document.createElement("li");
      trailer.id = "static";
      container.append(trailer);
      const ordered = [...records.values()];

      positionRecords(container, ordered, records, trailer);
      expect(rowsIn(container)).toEqual(["a", "b", "static"]);

      // A row appended after the anchor is pulled back in front of it.
      const added = document.createElement("li");
      added.id = "c";
      container.append(added);
      const next = [...ordered, { key: "c", nodes: [added] }];
      positionRecords(container, next, records, trailer);
      expect(rowsIn(container)).toEqual(["a", "b", "c", "static"]);
    });

    it("falls back to insertBefore when the native move rejects the node", () => {
      const container = document.createElement("ul");
      const node = document.createElement("li");
      const rejected: unknown[] = [];
      Object.assign(container, {
        moveBefore: (moved: Node) => {
          rejected.push(moved);
          throw new DOMException("no", "HierarchyRequestError");
        },
      });

      moveBefore(container, node, null);

      expect(rejected).toEqual([node]);
      expect(container.firstChild).toBe(node);
    });

    it("uses the native move when the container has one, and rethrows anything else it throws", () => {
      const moved: Array<[Node, Node | null]> = [];
      const container = document.createElement("ul");
      const node = document.createElement("li");
      Object.assign(container, { moveBefore: (child: Node, before: Node | null) => void moved.push([child, before]) });

      moveBefore(container, node, null);
      expect(moved).toEqual([[node, null]]);
      // The node is not inserted, because the native move claimed it.
      expect(container.firstChild).toBeNull();

      const failing = document.createElement("ul");
      Object.assign(failing, {
        moveBefore: () => {
          throw new TypeError("unrelated");
        },
      });
      expect(() => moveBefore(failing, node, null)).toThrow("unrelated");

      // Only the hierarchy rejection is a signal to fall back; any other DOM error is the caller's problem.
      const otherDomError = document.createElement("ul");
      Object.assign(otherDomError, {
        moveBefore: () => {
          throw new DOMException("gone", "NotFoundError");
        },
      });
      expect(() => moveBefore(otherDomError, node, null)).toThrow("gone");
    });

    it("appends without moving only while every retained row keeps its order", () => {
      const previous = new Map<PropertyKey, unknown>([
        ["a", 1],
        ["b", 1],
      ]);
      const rows = (keys: readonly string[]) => keys.map((key) => ({ key, nodes: [] as Node[] }));
      const next = (keys: readonly string[]) => new Map<PropertyKey, unknown>(keys.map((key) => [key, 1]));

      expect(canAppendWithoutMoving(next(["a", "b", "c"]), rows(["a", "b", "c"]), previous)).toBe(true);
      expect(canAppendWithoutMoving(next(["a", "b"]), rows(["a", "b"]), previous)).toBe(true);
      // Dropping a row leaves the rest in order, so the remaining ones still do not have to move.
      expect(canAppendWithoutMoving(next(["a"]), rows(["a"]), previous)).toBe(true);
      // A retained row that changed order, and a new row in front of the retained ones, both need positioning.
      expect(canAppendWithoutMoving(next(["b", "a"]), rows(["b", "a"]), previous)).toBe(false);
      expect(canAppendWithoutMoving(next(["c", "a", "b"]), rows(["c", "a", "b"]), previous)).toBe(false);
    });
  });

  describe("regions", () => {
    it("selects the elements between the static ones, clamping a region that does not fit", () => {
      const { container } = listOf(["a", "b", "c", "d"]);

      expect(dynamicElementsFor(container, undefined).map((element) => element.id)).toEqual(["a", "b", "c", "d"]);
      expect(dynamicElementsFor(container, { before: 1, after: 1 }).map((element) => element.id)).toEqual(["b", "c"]);
      expect(dynamicElementsFor(container, { before: 9, after: 0 })).toEqual([]);
      expect(dynamicElementsFor(container, { before: 0, after: 9 })).toEqual([]);
      expect(dynamicElementsFor(container, { before: -1, after: -1 }).map((element) => element.id)).toEqual([
        "a",
        "b",
        "c",
        "d",
      ]);
    });

    it("replaces the dynamic slice and keeps the static nodes on both sides", () => {
      const { container } = listOf(["head", "a", "b", "tail"]);
      const first = container.children[3] as ChildNode;
      const replacement = ["x", "y"].map((id) => {
        const element = document.createElement("li");
        element.id = id;
        return element;
      });

      replaceDynamicRegion(container, { before: 1, after: 1 }, replacement, first);

      expect(rowsIn(container)).toEqual(["head", "x", "y", "tail"]);
    });

    it("appends to the end when nothing follows the region", () => {
      const { container } = listOf(["head", "a"]);
      const replacement = [document.createElement("li")];
      replacement[0]!.id = "x";

      replaceDynamicRegion(container, { before: 1, after: 0 }, replacement, undefined);

      expect(rowsIn(container)).toEqual(["head", "x"]);
    });
  });
});
