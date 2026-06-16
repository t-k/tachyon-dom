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

const bindBenchmarkRow = (row: BenchmarkTableRow): void => {
  idText(row).nodeValue = String(nextId++);
  labelText(row).nodeValue = labelPool[(Math.random() * labelPool.length) | 0] as string;
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

  let selected = -1;
  const rowPool: BenchmarkTableRow[] = [];
  const liveRows = () => tbody.rows;
  const takeRow = (): BenchmarkTableRow => rowPool.pop() ?? (baseRow.cloneNode(true) as BenchmarkTableRow);
  const releaseRows = (): void => {
    while (tbody.lastElementChild) {
      const row = tbody.lastElementChild as BenchmarkTableRow;
      row.className = "";
      rowPool.push(row);
      tbody.removeChild(row);
    }
  };
  const appendRows = (count: number): void => {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < count; index++) {
      const row = takeRow();
      bindBenchmarkRow(row);
      fragment.appendChild(row);
    }
    tbody.appendChild(fragment);
  };
  const clear = (): void => {
    selected = -1;
    releaseRows();
  };
  const replace = (count: number): void => {
    const parent = tbody.parentNode;
    const nextSibling = tbody.nextSibling;
    clear();
    if (parent) {
      tbody.remove();
    }
    appendRows(count);
    parent?.insertBefore(tbody, nextSibling);
  };
  const renderer: BenchmarkTableApp = {
    replace,
    append: appendRows,
    updateEvery: (step) => {
      const rows = liveRows();
      for (let index = 0; index < rows.length; index += step) {
        labelText(rows[index] as BenchmarkTableRow).nodeValue += " !!!";
      }
    },
    selectIndex: (index) => {
      const rows = liveRows();
      if (index < 0 || index >= rows.length || selected === index) {
        return;
      }
      if (selected > -1) {
        (rows[selected] as HTMLTableRowElement).className = "";
      }
      selected = index;
      (rows[index] as HTMLTableRowElement).className = "danger";
    },
    removeIndex: (index) => {
      const row = liveRows()[index];
      if (!row) {
        return;
      }
      row.className = "";
      rowPool.push(row as BenchmarkTableRow);
      row.remove();
      if (selected === index) {
        selected = -1;
      } else if (selected > index) {
        selected--;
      }
    },
    swap: (a, b) => {
      const rows = liveRows();
      const rowA = rows[a];
      const rowB = rows[b];
      if (!rowA || !rowB) {
        return;
      }
      const nextA = rowA.nextSibling;
      const nextB = rowB.nextSibling;
      if (nextA === rowB) {
        tbody.insertBefore(rowB, rowA);
      } else {
        tbody.insertBefore(rowB, nextA);
        tbody.insertBefore(rowA, nextB);
      }
      if (selected === a) {
        selected = b;
      } else if (selected === b) {
        selected = a;
      }
    },
    clear,
    length: () => liveRows().length,
    selectedIndex: () => selected,
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
