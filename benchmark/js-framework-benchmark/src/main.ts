import { createChunkedRowList } from "../../../src/runtime/chunked-row-list";
import { textAt } from "../../../src/runtime/text";
import { messages } from "./i18n";

type BenchmarkTableRow = HTMLTableRowElement & {
  $id?: Text;
  $label?: Text;
};

type BenchmarkItem = string;

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

const idText = (row: BenchmarkTableRow): Text => (row.$id ??= textAt(row, [0, 0]));

const labelText = (row: BenchmarkTableRow): Text => (row.$label ??= textAt(row, [1, 0, 0]));

const createBenchmarkItem = (): BenchmarkItem => labelPool[(Math.random() * labelPool.length) | 0] as string;

const bindBenchmarkRow = (row: HTMLTableRowElement, item: BenchmarkItem): void => {
  const benchmarkRow = row as BenchmarkTableRow;
  idText(benchmarkRow).nodeValue = String(nextId++);
  labelText(benchmarkRow).nodeValue = item;
};

const updateBenchmarkRow = (row: HTMLTableRowElement, item: BenchmarkItem): void => {
  labelText(row as BenchmarkTableRow).nodeValue = item;
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

  const listResult = createChunkedRowList<BenchmarkItem>({
    table,
    tbody,
    rowTemplate,
    bindRow: bindBenchmarkRow,
    updateRow: updateBenchmarkRow,
  });
  if (!listResult.ok) {
    throw new Error(
      listResult.error.type === "empty-template"
        ? "Benchmark row template must contain a table row."
        : `Benchmark row template must contain a table row, got ${listResult.error.nodeName}.`,
    );
  }
  const list = listResult.value;
  const renderer: BenchmarkTableApp = {
    replace: (count) => list.replaceGenerated(count, createBenchmarkItem),
    append: (count) => list.appendGenerated(count, createBenchmarkItem),
    updateEvery: (step) => {
      list.mapEvery(step, (item) => `${item} !!!`);
    },
    selectIndex: list.selectIndex,
    removeIndex: list.removeIndex,
    swap: list.swap,
    clear: list.clear,
    length: list.length,
    selectedIndex: list.selectedIndex,
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
