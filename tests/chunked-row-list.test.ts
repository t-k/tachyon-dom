import { describe, expect, it } from "vitest";
import { createChunkedRowList, textAt } from "../src/index";

type Row = {
  id: number;
  label: string;
};

type CachedRow = HTMLTableRowElement & {
  labelText?: Text;
};

const setup = () => {
  document.body.innerHTML = `
    <table><tbody id="tbody"></tbody></table>
    <template id="row-template">
      <tr><td> </td><td><a> </a></td><td><a><span></span></a></td><td></td></tr>
    </template>
  `;
  const table = document.querySelector("table");
  const tbody = document.querySelector("#tbody");
  const rowTemplate = document.querySelector<HTMLTemplateElement>("#row-template");
  if (
    !(table instanceof HTMLTableElement) ||
    !(tbody instanceof HTMLTableSectionElement) ||
    !(rowTemplate instanceof HTMLTemplateElement)
  ) {
    throw new Error("Test DOM setup failed.");
  }
  const renderer = createChunkedRowList<Row>({
    table,
    tbody,
    rowTemplate,
    chunkSize: 2,
    bindRow: (row, item) => {
      textAt(row, [0, 0]).nodeValue = String(item.id);
      textAt(row, [1, 0, 0]).nodeValue = item.label;
    },
    updateRow: (row, item) => {
      textAt(row, [1, 0, 0]).nodeValue = item.label;
    },
  });
  if (!renderer.ok) {
    throw new Error(renderer.error.type);
  }
  return { renderer: renderer.value, tbody };
};

const rows = (count: number): Row[] =>
  Array.from({ length: count }, (_, index) => ({ id: index + 1, label: `row ${index + 1}` }));

describe("createChunkedRowList", () => {
  it("replaces and appends rows with bound text slots", () => {
    const { renderer, tbody } = setup();
    renderer.replace(rows(3));
    expect(renderer.length()).toBe(3);
    expect(tbody.rows[0]?.cells[0]?.textContent).toBe("1");
    expect(tbody.rows[2]?.cells[1]?.textContent).toBe("row 3");

    renderer.append([{ id: 4, label: "row 4" }]);
    expect(renderer.length()).toBe(4);
    expect(tbody.rows[3]?.cells[1]?.textContent).toBe("row 4");
  });

  it("updates only stepped rows through the update slot", () => {
    const { renderer, tbody } = setup();
    renderer.replace(rows(5));
    renderer.updateEvery(2, (row) => {
      row.label += " !!!";
    });

    expect(tbody.rows[0]?.cells[1]?.textContent).toBe("row 1 !!!");
    expect(tbody.rows[1]?.cells[1]?.textContent).toBe("row 2");
    expect(tbody.rows[2]?.cells[1]?.textContent).toBe("row 3 !!!");
  });

  it("maps stepped rows for immutable item updates", () => {
    const { renderer, tbody } = setup();
    renderer.replace(rows(4));

    renderer.mapEvery(2, (row) => ({ ...row, label: `${row.label} mapped` }));

    expect(tbody.rows[0]?.cells[1]?.textContent).toBe("row 1 mapped");
    expect(tbody.rows[1]?.cells[1]?.textContent).toBe("row 2");
    expect(renderer.itemAt(2)?.label).toBe("row 3 mapped");
  });

  it("binds the live cloned row so row caches are reusable during updates", () => {
    const { tbody } = setup();
    const seenRows = new WeakSet<HTMLTableRowElement>();
    const cached = createChunkedRowList<Row>({
      table: tbody.closest("table") as HTMLTableElement,
      tbody,
      rowTemplate: document.querySelector<HTMLTemplateElement>("#row-template") as HTMLTemplateElement,
      chunkSize: 2,
      bindRow: (row, item) => {
        const cachedRow = row as CachedRow;
        cachedRow.labelText = textAt(row, [1, 0, 0]);
        cachedRow.labelText.nodeValue = item.label;
        seenRows.add(row);
      },
      updateRow: (row, item) => {
        expect(seenRows.has(row)).toBe(true);
        const cachedRow = row as CachedRow;
        expect(cachedRow.labelText).toBeInstanceOf(Text);
        (cachedRow.labelText as Text).nodeValue = item.label;
      },
    });
    if (!cached.ok) {
      throw new Error(cached.error.type);
    }

    cached.value.replace(rows(3));
    cached.value.updateEvery(1, (row) => {
      row.label += " updated";
    });

    expect(tbody.rows[0]?.cells[1]?.textContent).toBe("row 1 updated");
    expect(tbody.rows[2]?.cells[1]?.textContent).toBe("row 3 updated");
  });

  it("can generate replacement and appended rows without a caller-owned item array", () => {
    const { renderer, tbody } = setup();

    renderer.replaceGenerated(3, (index) => ({ id: index + 1, label: `generated ${index + 1}` }));
    renderer.appendGenerated(2, (index) => ({ id: index + 1, label: `generated ${index + 1}` }));

    expect(renderer.length()).toBe(5);
    expect(tbody.rows[0]?.cells[1]?.textContent).toBe("generated 1");
    expect(tbody.rows[3]?.cells[1]?.textContent).toBe("generated 4");
    expect(renderer.itemAt(4)?.label).toBe("generated 5");
  });

  it("selects, removes, swaps, and clears rows without rebuilding the table", () => {
    const { renderer, tbody } = setup();
    renderer.replace(rows(1000));

    renderer.selectIndex(1);
    expect(tbody.rows[1]?.className).toBe("danger");
    renderer.selectIndex(998);
    expect(tbody.rows[1]?.className).toBe("");
    expect(tbody.rows[998]?.className).toBe("danger");

    renderer.swap(1, 998);
    expect(tbody.rows[1]?.cells[0]?.textContent).toBe("999");
    expect(tbody.rows[998]?.cells[0]?.textContent).toBe("2");
    expect(renderer.selectedIndex()).toBe(1);

    renderer.removeIndex(1);
    expect(renderer.length()).toBe(999);
    expect(tbody.rows[1]?.cells[0]?.textContent).toBe("3");
    expect(renderer.selectedIndex()).toBe(-1);

    renderer.clear();
    expect(renderer.length()).toBe(0);
    expect(tbody.rows.length).toBe(0);

    renderer.append([{ id: 1000, label: "row 1000" }]);
    expect(renderer.length()).toBe(1);
    expect(tbody.rows[0]?.cells[1]?.textContent).toBe("row 1000");
  });
});
