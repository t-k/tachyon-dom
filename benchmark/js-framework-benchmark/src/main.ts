import { createChunkedRowList, type ChunkedRowList } from "../../../src/index";
import { messages } from "./i18n";

export type BenchmarkRow = {
  id: number;
  label: string;
};

type BenchmarkTableRow = HTMLTableRowElement & {
  $id?: Text;
  $label?: Text;
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

export const buildData = (count: number): BenchmarkRow[] => {
  const rows: BenchmarkRow[] = [];
  rows.length = count;
  const poolSize = labelPool.length;
  for (let i = 0; i < count; i++) {
    rows[i] = {
      id: nextId++,
      label: labelPool[(Math.random() * poolSize) | 0] as string,
    };
  }
  return rows;
};

const idText = (row: BenchmarkTableRow): Text => (row.$id ??= row.firstChild?.firstChild as Text);

const labelText = (row: BenchmarkTableRow): Text =>
  (row.$label ??= row.firstChild?.nextSibling?.firstChild?.firstChild as Text);

const bindBenchmarkRow = (row: HTMLTableRowElement, item: BenchmarkRow): void => {
  const benchmarkRow = row as BenchmarkTableRow;
  idText(benchmarkRow).nodeValue = String(item.id);
  labelText(benchmarkRow).nodeValue = item.label;
};

const updateBenchmarkRow = (row: HTMLTableRowElement, item: BenchmarkRow): void => {
  labelText(row as BenchmarkTableRow).nodeValue = item.label;
};

const indexFromEvent = (event: Event, renderer: ChunkedRowList<BenchmarkRow>): number => {
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

export const createBenchmarkTableApp = (root: Document | HTMLElement = document): ChunkedRowList<BenchmarkRow> => {
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

  const rendererResult = createChunkedRowList<BenchmarkRow>({
    table,
    tbody,
    rowTemplate,
    bindRow: bindBenchmarkRow,
    updateRow: updateBenchmarkRow,
    chunkSize: 50,
  });
  if (!rendererResult.ok) {
    throw new Error(`Invalid row template: ${rendererResult.error.type}`);
  }
  const renderer = rendererResult.value;

  root.querySelector("#run")?.addEventListener("click", () => renderer.replace(buildData(1000)));
  root.querySelector("#runlots")?.addEventListener("click", () => renderer.replace(buildData(10000)));
  root.querySelector("#add")?.addEventListener("click", () => renderer.append(buildData(1000)));
  root.querySelector("#update")?.addEventListener("click", () => {
    renderer.updateEvery(10, (row) => {
      row.label += " !!!";
    });
  });
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
