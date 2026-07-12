import { afterEach, describe, expect, it, vi } from "vitest";
import { createKeyedRows } from "../src/index";

type Item = { id: number; label: string };

const setup = (chunks = 50) => {
  document.body.innerHTML = `<table><tbody id="tbody"></tbody></table>`;
  const tbody = document.querySelector("#tbody") as HTMLTableSectionElement;
  const list = createKeyedRows<Item>({
    tbody,
    row: "<tr><td> </td><td><a> </a></td></tr>",
    bind: (row, item) => {
      (row.firstChild!.firstChild as Text).data = String(item.id);
      (row.children[1]!.firstChild!.firstChild as Text).data = item.label;
    },
    selectedClass: "sel",
    chunks,
  });
  return { tbody, list };
};

const items = (count: number, offset = 0): Item[] =>
  Array.from({ length: count }, (_, index) => ({ id: index + 1 + offset, label: `row ${index + 1 + offset}` }));

const ids = (tbody: HTMLTableSectionElement): string[] =>
  Array.from(tbody.rows, (row) => row.cells[0]?.textContent ?? "");

const labels = (tbody: HTMLTableSectionElement): string[] =>
  Array.from(tbody.rows, (row) => row.cells[1]?.textContent ?? "");

describe("createKeyedRows", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("throws when the row markup has no <tr> root", () => {
    document.body.innerHTML = `<table><tbody id="tbody"></tbody></table>`;
    const tbody = document.querySelector("#tbody") as HTMLTableSectionElement;
    expect(() => createKeyedRows<Item>({ tbody, row: "<div></div>", bind: () => {} })).toThrow();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    "rejects invalid chunk count %s before construction can mutate the DOM",
    (chunks) => {
      document.body.innerHTML = `<table><tbody id="tbody"><tr><td>existing</td></tr></tbody></table>`;
      const tbody = document.querySelector("#tbody") as HTMLTableSectionElement;
      const before = tbody.innerHTML;

      expect(() =>
        createKeyedRows<Item>({ tbody, row: "<tr><td></td></tr>", bind: () => undefined, chunks }),
      ).toThrow(new TypeError("keyed-rows: `chunks` must be a positive finite integer."));
      expect(tbody.innerHTML).toBe(before);
    },
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    "rejects invalid generated-row count %s before replaceEach or appendEach mutates the DOM",
    (count) => {
      const { tbody, list } = setup();
      list.replace(items(2));
      const before = tbody.innerHTML;
      const make = () => ({ id: 3, label: "new" });

      expect(() => list.replaceEach(count, make)).toThrow(
        new TypeError("keyed-rows: `count` must be a positive finite integer."),
      );
      expect(tbody.innerHTML).toBe(before);
      expect(() => list.appendEach(count, make)).toThrow(
        new TypeError("keyed-rows: `count` must be a positive finite integer."),
      );
      expect(tbody.innerHTML).toBe(before);
    },
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    "rejects invalid update stride %s before DOM mutation",
    (stride) => {
    const { tbody, list } = setup();
    list.replace(items(2));
    const before = tbody.innerHTML;
      expect(() => list.update(stride, () => tbody.replaceChildren())).toThrow(
        new TypeError("keyed-rows: `stride` must be a positive finite integer."),
      );
    expect(tbody.innerHTML).toBe(before);
    },
  );

  it("replaces and appends rows from arrays", () => {
    const { tbody, list } = setup();
    list.replace(items(3));
    expect(list.length()).toBe(3);
    expect(ids(tbody)).toEqual(["1", "2", "3"]);

    list.append(items(2, 3));
    expect(list.length()).toBe(5);
    expect(ids(tbody)).toEqual(["1", "2", "3", "4", "5"]);

    list.replace(items(2, 10));
    expect(ids(tbody)).toEqual(["11", "12"]);
  });

  it("produces rows lazily with replaceEach/appendEach and a global index", () => {
    const { tbody, list } = setup();
    list.replaceEach(4, (index) => ({ id: index, label: `g${index}` }));
    expect(ids(tbody)).toEqual(["0", "1", "2", "3"]);
    list.appendEach(2, (index) => ({ id: index, label: `g${index}` }));
    expect(ids(tbody)).toEqual(["0", "1", "2", "3", "4", "5"]);
  });

  it("builds correct rows when the count does not divide evenly into chunks", () => {
    const { tbody, list } = setup(3);
    list.replace(items(7));
    expect(list.length()).toBe(7);
    expect(ids(tbody)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(labels(tbody)[6]).toBe("row 7");
  });

  it("updates every stride-th row", () => {
    const { tbody, list } = setup();
    list.replace(items(10));
    list.update(3, (row) => {
      const text = row.children[1]!.firstChild!.firstChild as Text;
      text.data = `${text.data}!`;
    });
    expect(labels(tbody)).toEqual([
      "row 1!",
      "row 2",
      "row 3",
      "row 4!",
      "row 5",
      "row 6",
      "row 7!",
      "row 8",
      "row 9",
      "row 10!",
    ]);
  });

  it("passes ascending global indices for a non-divisible stride", () => {
    const { list } = setup();
    list.replace(items(11));
    const indices: number[] = [];
    list.update(3, (_row, index) => indices.push(index));
    expect(indices).toEqual([0, 3, 6, 9]);
  });

  it("swaps rows while preserving element identity (adjacent and distant)", () => {
    const { tbody, list } = setup();
    list.replace(items(5));
    const original = Array.from(tbody.rows);

    list.swap(1, 3);
    expect(ids(tbody)).toEqual(["1", "4", "3", "2", "5"]);
    expect(tbody.rows[1]).toBe(original[3]);
    expect(tbody.rows[3]).toBe(original[1]);

    list.swap(2, 3); // adjacent
    expect(ids(tbody)).toEqual(["1", "4", "2", "3", "5"]);
  });

  it("preserves focused form state across reverse swaps and ignores invalid swaps", () => {
    const { tbody, list } = setup();
    list.replace(items(5));
    const input = document.createElement("input");
    input.value = "retained";
    tbody.rows[3]!.cells[1]!.append(input);
    input.focus();

    list.swap(3, 1);
    expect(tbody.rows[1]?.contains(input)).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("retained");
    const before = ids(tbody);
    list.swap(1, 1);
    list.swap(-1, 3);
    list.swap(1, 99);
    expect(ids(tbody)).toEqual(before);
  });

  it("uses one native move for a reverse-adjacent swap without manual focus restoration", () => {
    const { tbody, list } = setup();
    list.replace(items(4));
    const input = document.createElement("input");
    tbody.rows[2]!.cells[1]!.append(input);
    input.focus();
    const focus = vi.spyOn(input, "focus");
    const insertBefore = tbody.insertBefore.bind(tbody);
    const moves: Array<[Node, Node | null]> = [];
    (tbody as HTMLTableSectionElement & { moveBefore: (node: Node, before: Node | null) => void }).moveBefore = (
      node,
      before,
    ) => {
      moves.push([node, before]);
      insertBefore(node, before);
    };

    list.swap(2, 1);

    expect(ids(tbody)).toEqual(["1", "3", "2", "4"]);
    expect(moves).toHaveLength(1);
    expect(focus).not.toHaveBeenCalled();
  });

  it("falls back to insertBefore and restores focus when native move rejects the hierarchy", () => {
    const { tbody, list } = setup();
    list.replace(items(4));
    const input = document.createElement("input");
    tbody.rows[2]!.cells[1]!.append(input);
    input.focus();
    const focus = vi.spyOn(input, "focus");
    (tbody as HTMLTableSectionElement & { moveBefore: (node: Node, before: Node | null) => void }).moveBefore = () => {
      throw new DOMException("unsupported", "HierarchyRequestError");
    };

    list.swap(2, 1);

    expect(ids(tbody)).toEqual(["1", "3", "2", "4"]);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("removes by index and by element, clearing selection when needed", () => {
    const { tbody, list } = setup();
    list.replace(items(5));
    list.selectAt(2);
    expect(list.selectedIndex()).toBe(2);

    list.removeAt(0);
    expect(ids(tbody)).toEqual(["2", "3", "4", "5"]);
    expect(list.selectedIndex()).toBe(1); // selected row shifted left

    const selectedRow = list.rowAt(1)!;
    list.removeRow(selectedRow);
    expect(list.length()).toBe(3);
    expect(list.selectedIndex()).toBe(-1); // selection dropped with its row
  });

  it("tracks selection through reorders and applies the selected class", () => {
    const { tbody, list } = setup();
    list.replace(items(5));
    list.selectAt(1);
    expect(tbody.rows[1]?.className).toBe("sel");
    expect(list.selectedIndex()).toBe(1);

    list.swap(1, 4);
    expect(list.selectedIndex()).toBe(4);
    expect(tbody.rows[4]?.className).toBe("sel");

    list.selectRow(null);
    expect(list.selectedIndex()).toBe(-1);
    expect(tbody.querySelector(".sel")).toBeNull();
  });

  it("preserves non-selection classes when selecting and clearing rows", () => {
    const { tbody, list } = setup();
    list.replace(items(2));
    tbody.rows[0]?.classList.add("row-base", "priority");
    tbody.rows[1]?.classList.add("row-base");

    list.selectAt(0);
    expect(tbody.rows[0]?.className).toBe("row-base priority sel");
    list.selectAt(1);

    expect(tbody.rows[0]?.className).toBe("row-base priority");
    expect(tbody.rows[1]?.className).toBe("row-base sel");
    list.selectRow(null);
    expect(tbody.rows[1]?.className).toBe("row-base");
  });

  it("does not mutate classes when selecting the same row twice", async () => {
    const { tbody, list } = setup();
    list.replace(items(2));
    list.selectAt(0);
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((mutations) => records.push(...mutations));
    observer.observe(tbody.rows[0]!, { attributes: true, attributeFilter: ["class"] });
    list.selectAt(0);
    await Promise.resolve();
    observer.disconnect();
    expect(records).toHaveLength(0);
  });

  it("clears all rows and selection", () => {
    const { tbody, list } = setup();
    list.replace(items(5));
    list.selectAt(0);
    list.clear();
    expect(list.length()).toBe(0);
    expect(list.selectedIndex()).toBe(-1);
    expect(tbody.rows.length).toBe(0);
  });

  it("preserves tbody identity and supports reuse after clear", () => {
    const { tbody, list } = setup();
    const parent = tbody.parentNode;
    list.replace(items(5));
    list.selectAt(2);
    const selected = tbody.rows[2]!;
    list.clear();
    parent?.append(tbody);
    tbody.append(selected);
    expect(list.selectedIndex()).toBe(-1);
    selected.remove();
    list.append(items(2));
    expect(tbody.parentNode).toBe(parent);
    expect(ids(tbody)).toEqual(["1", "2"]);
  });

  it.each([1, 49, 50, 51, 101])("replaces and appends exact chunk-boundary count %s", (count) => {
    const { tbody, list } = setup(50);
    list.replaceEach(count, (index) => ({ id: index + 1, label: `row ${index + 1}` }));
    expect(tbody.rows).toHaveLength(count);
    list.appendEach(3, (index) => ({ id: index + 1, label: `row ${index + 1}` }));
    expect(ids(tbody).slice(-3)).toEqual([String(count + 1), String(count + 2), String(count + 3)]);
  });
});
