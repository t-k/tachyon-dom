import { describe, expect, it } from "vitest";
import { createChunkedRowList, textAt } from "../src/index";

type Row = {
  id: number;
  label: string;
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
  if (renderer.isErr()) {
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
  });
});
