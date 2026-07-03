import { afterEach, describe, expect, it } from "vitest";
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

  it("clears all rows and selection", () => {
    const { tbody, list } = setup();
    list.replace(items(5));
    list.selectAt(0);
    list.clear();
    expect(list.length()).toBe(0);
    expect(list.selectedIndex()).toBe(-1);
    expect(tbody.rows.length).toBe(0);
  });
});
