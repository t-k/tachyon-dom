import { messages } from "./i18n";

type BenchmarkTableRow = HTMLTableRowElement & {
  $id?: Text;
  $label?: Text;
};

export type BenchmarkTableApp = {
  replace: (count: number) => void;
  append: (count: number) => void;
  updateEvery: (step: number) => void;
  selectIndex: (index: number) => void;
  removeIndex: (index: number) => void;
  swap: (a: number, b: number) => void;
  clear: () => void;
  length: () => number;
  selectedIndex: () => number;
};

const adjectives = [
  "pretty",
  "large",
  "big",
  "small",
  "tall",
  "short",
  "long",
  "handsome",
  "plain",
  "quaint",
  "clean",
  "elegant",
  "easy",
  "angry",
  "crazy",
  "helpful",
  "mushy",
  "odd",
  "unsightly",
  "adorable",
  "important",
  "inexpensive",
  "cheap",
  "expensive",
  "fancy",
];

const colours = ["red", "yellow", "blue", "green", "pink", "brown", "purple", "brown", "white", "black", "orange"];
const nouns = [
  "table",
  "chair",
  "house",
  "bbq",
  "desk",
  "car",
  "pony",
  "cookie",
  "sandwich",
  "burger",
  "pizza",
  "mouse",
  "keyboard",
];

const labelPool: string[] = [];
for (const adjective of adjectives) {
  for (const colour of colours) {
    for (const noun of nouns) {
      labelPool.push(`${adjective} ${colour} ${noun}`);
    }
  }
}

let nextId = 1;

const idText = (row: BenchmarkTableRow): Text => (row.$id ??= row.firstChild?.firstChild as Text);

const labelText = (row: BenchmarkTableRow): Text =>
  (row.$label ??= row.firstChild?.nextSibling?.firstChild?.firstChild as Text);

const bindBenchmarkRow = (row: BenchmarkTableRow): Text => {
  idText(row).nodeValue = String(nextId++);
  const label = labelText(row);
  label.nodeValue = labelPool[(Math.random() * labelPool.length) | 0] as string;
  return label;
};

const indexFromEvent = (event: Event, renderer: BenchmarkTableApp): number => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return -1;
  }
  const row = target.closest("tr");
  if (!(row instanceof HTMLTableRowElement)) {
    return -1;
  }
  const index = row.sectionRowIndex;
  return index >= 0 && index < renderer.length() ? index : -1;
};

export const createBenchmarkTableApp = (root: Document | HTMLElement = document): BenchmarkTableApp => {
  const table = root.querySelector("table");
  const tbody = root.querySelector("#tbody");
  const rowTemplate = root.querySelector<HTMLTemplateElement>("#row-template");
  if (
    !(table instanceof HTMLTableElement) ||
    !(tbody instanceof HTMLTableSectionElement) ||
    !(rowTemplate instanceof HTMLTemplateElement)
  ) {
    throw new Error("Benchmark DOM is missing table, tbody, or row template.");
  }

  const baseRow = rowTemplate.content.firstElementChild;
  if (!(baseRow instanceof HTMLTableRowElement)) {
    throw new Error("Benchmark row template must contain a table row.");
  }

  let selectedRow: BenchmarkTableRow | undefined;
  const rows: BenchmarkTableRow[] = [];
  const labelNodes: Text[] = [];
  const rowPool: BenchmarkTableRow[] = [];
  const takeRow = (): BenchmarkTableRow => rowPool.pop() ?? (baseRow.cloneNode(true) as BenchmarkTableRow);
  const releaseRows = (): void => {
    while (rows.length > 0) {
      const row = rows.pop() as BenchmarkTableRow;
      row.className = "";
      labelNodes.pop();
      rowPool.push(row);
      tbody.removeChild(row);
    }
  };
  const appendRows = (count: number): void => {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < count; index++) {
      const row = takeRow();
      const label = bindBenchmarkRow(row);
      rows.push(row);
      labelNodes.push(label);
      fragment.appendChild(row);
    }
    tbody.appendChild(fragment);
  };
  const clear = (): void => {
    selectedRow = undefined;
    rows.length = 0;
    labelNodes.length = 0;
    rowPool.length = 0;
    tbody.textContent = "";
  };
  const replace = (count: number): void => {
    const parent = tbody.parentNode;
    const nextSibling = tbody.nextSibling;
    if (parent) {
      tbody.remove();
    }
    selectedRow = undefined;
    releaseRows();
    appendRows(count);
    parent?.insertBefore(tbody, nextSibling);
  };
  const renderer: BenchmarkTableApp = {
    replace,
    append: appendRows,
    updateEvery: (step) => {
      for (let index = 0; index < labelNodes.length; index += step) {
        (labelNodes[index] as Text).nodeValue += " !!!";
      }
    },
    selectIndex: (index) => {
      if (index < 0 || index >= rows.length) {
        return;
      }
      const row = rows[index] as BenchmarkTableRow;
      if (selectedRow === row) {
        return;
      }
      if (selectedRow) {
        selectedRow.className = "";
      }
      selectedRow = row;
      row.className = "danger";
    },
    removeIndex: (index) => {
      const row = rows[index];
      if (!row) {
        return;
      }
      rows.splice(index, 1);
      labelNodes.splice(index, 1);
      row.remove();
      if (selectedRow === row) {
        selectedRow = undefined;
      }
    },
    swap: (a, b) => {
      const rowA = rows[a];
      const rowB = rows[b];
      if (!rowA || !rowB) {
        return;
      }
      const nextA = rowA.nextSibling;
      const nextB = rowB.nextSibling;
      rows[a] = rowB;
      rows[b] = rowA;
      const labelA = labelNodes[a] as Text;
      labelNodes[a] = labelNodes[b] as Text;
      labelNodes[b] = labelA;
      if (nextA === rowB) {
        tbody.insertBefore(rowB, rowA);
      } else {
        tbody.insertBefore(rowB, rowA);
        tbody.insertBefore(rowA, nextB);
      }
    },
    clear,
    length: () => rows.length,
    selectedIndex: () => (selectedRow ? rows.indexOf(selectedRow) : -1),
  };

  root.querySelector("#run")?.addEventListener("click", () => renderer.replace(1000));
  root.querySelector("#runlots")?.addEventListener("click", () => renderer.replace(10000));
  root.querySelector("#add")?.addEventListener("click", () => renderer.append(1000));
  root.querySelector("#update")?.addEventListener("click", () => renderer.updateEvery(10));
  root.querySelector("#clear")?.addEventListener("click", () => renderer.clear());
  root.querySelector("#swaprows")?.addEventListener("click", () => renderer.swap(1, 998));
  tbody.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const index = indexFromEvent(event, renderer);
    if (index < 0) {
      return;
    }
    const cell = target.closest("td");
    const row = cell?.parentElement;
    if (!cell || !row) {
      return;
    }
    if (row.children[1] === cell) {
      renderer.selectIndex(index);
    } else if (row.children[2] === cell) {
      renderer.removeIndex(index);
    }
  });

  return renderer;
};

const hydrateLabels = (root: Document): void => {
  root.querySelector("#title")!.textContent = messages.title;
  root.querySelector("#run")!.textContent = messages.createRows;
  root.querySelector("#runlots")!.textContent = messages.createManyRows;
  root.querySelector("#add")!.textContent = messages.appendRows;
  root.querySelector("#update")!.textContent = messages.updateEveryTenthRow;
  root.querySelector("#clear")!.textContent = messages.clear;
  root.querySelector("#swaprows")!.textContent = messages.swapRows;
};

if (typeof document !== "undefined" && document.getElementById("main")) {
  hydrateLabels(document);
  createBenchmarkTableApp(document);
}
