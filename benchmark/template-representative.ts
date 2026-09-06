import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { JSDOM } from "jsdom";
import { createKeyedRows } from "../src/runtime/keyed-rows.js";
import { collectBenchmarkProvenance, collectDependencyVersions, type BenchmarkEnvelope } from "./provenance.js";
import {
  createGeneratedTemplateDriver,
  loadRepresentativeGeneratedModules,
  REPRESENTATIVE_TEMPLATE_SOURCES,
  type GeneratedModuleLoadTiming,
  type GeneratedTemplateDriver,
  type GeneratedTemplateItem,
  type LoadedRepresentativeModules,
} from "./generated-template-driver.js";

/**
 * Contract version 3 splits the workload into two comparison groups:
 *
 * - common data operations run on every path and must produce the same nested
 *   DOM, node identity, and live input values;
 * - interactive operations dispatch real DOM events against real handlers and
 *   compare the keyed-rows path (hand-written handlers) with the mixed
 *   template. The text template has no model or event bindings, so it is out
 *   of scope for that group instead of being emulated with manual state writes.
 */
export const TEMPLATE_REPRESENTATIVE_CONTRACT_VERSION = 3;
export const TEMPLATE_REPRESENTATIVE_PATHS = ["keyed-rows", "text-template", "mixed-template"] as const;
export const TEMPLATE_REPRESENTATIVE_INTERACTIVE_PATHS = ["keyed-rows", "mixed-template"] as const;
export const TEMPLATE_REPRESENTATIVE_OPERATIONS = [
  "create",
  "append",
  "partial-update",
  "swap",
  "remove",
  "child-reorder",
  "child-empty",
  "mount-dispose",
] as const;
export const TEMPLATE_REPRESENTATIVE_INTERACTIVE_OPERATIONS = ["input", "click", "selected-toggle"] as const;
/** Paths whose rows write the label into the live `input.value`; the text template has no value binding. */
export const TEMPLATE_REPRESENTATIVE_LIVE_INPUT_PATHS = ["keyed-rows", "mixed-template"] as const;

type PathName = (typeof TEMPLATE_REPRESENTATIVE_PATHS)[number];
type InteractivePathName = (typeof TEMPLATE_REPRESENTATIVE_INTERACTIVE_PATHS)[number];
type OperationName = (typeof TEMPLATE_REPRESENTATIVE_OPERATIONS)[number];
type InteractiveOperationName = (typeof TEMPLATE_REPRESENTATIVE_INTERACTIVE_OPERATIONS)[number];

export type RepresentativeItem = GeneratedTemplateItem;

/** State observed after an operation that innerHTML alone cannot show. */
export type RepresentativeOperationOracle = {
  domHash: string;
  rowCount: number;
  childCounts: number[];
  liveInputValues: string[];
  /** Row and child identities preserved across the operation, keyed by row id / child id. */
  preservedRowIdentities: number;
  preservedChildIdentities: number;
};

export type RepresentativeInteractiveOracle = {
  domHash: string;
  inputValue: string;
  modelLabel: string;
  clickCount: number;
  selectedClassStates: boolean[];
  handlerRunsAfterDispose: number;
};

export type RepresentativeSample = {
  sampleIndex: number;
  durationMs: number;
  heapDeltaBytes: number;
  allocatedBytes: null;
  gcMs: number | null;
  retainedHeapBytes: number | null;
  operationDurationsMs: Record<OperationName, number>;
  operationOracles: Record<OperationName, RepresentativeOperationOracle>;
  operationDomHtml: Record<OperationName, string>;
  finalDomHash: string;
  finalRowCount: number;
};

export type RepresentativeInteractiveSample = {
  sampleIndex: number;
  durationMs: number;
  operationDurationsMs: Record<InteractiveOperationName, number>;
  operationOracles: Record<InteractiveOperationName, RepresentativeInteractiveOracle>;
};

export type RepresentativePathMeasurement = {
  samples: RepresentativeSample[];
  medianDurationMs: number;
  medianHeapDeltaBytes: number;
  medianGcMs: number | null;
  medianRetainedHeapBytes: number | null;
};

export type RepresentativeInteractiveMeasurement = {
  samples: RepresentativeInteractiveSample[];
  medianDurationMs: number;
};

export type RepresentativeWorkload = {
  contractVersion: typeof TEMPLATE_REPRESENTATIVE_CONTRACT_VERSION;
  paths: readonly PathName[];
  operations: readonly OperationName[];
  interactivePaths: readonly InteractivePathName[];
  interactiveOperations: readonly InteractiveOperationName[];
  interactiveOutOfScope: Record<string, string>;
  liveInputPaths: readonly PathName[];
  itemCount: number;
  appendCount: number;
  childCount: number;
  warmup: number;
  iterations: number;
  buildMode: "generated-client-source";
  generatedTemplateSources: Readonly<Record<"text-template" | "mixed-template", string>>;
  memoryMeasurement: "heap-delta-only";
  timingScope: "warm-dom-operations-excluding-oracles";
};

export type RepresentativeMeasurements = {
  cold: Record<"text-template" | "mixed-template", GeneratedModuleLoadTiming>;
  paths: Record<PathName, RepresentativePathMeasurement>;
  interactive: Record<InteractivePathName, RepresentativeInteractiveMeasurement>;
  oracle: Record<OperationName, RepresentativeOperationOracle>;
  interactiveOracle: Record<InteractiveOperationName, RepresentativeInteractiveOracle>;
};

export type RepresentativeBenchmark = BenchmarkEnvelope<RepresentativeWorkload, RepresentativeMeasurements>;

type ListDriver = GeneratedTemplateDriver;

const rowHtml = `<tr class="row"><td> </td><td><input value=""><span> </span></td><td> </td><td><ul></ul></td></tr>`;

const tagsFor = (rowId: number, count: number): RepresentativeItem["tags"] =>
  Array.from({ length: count }, (_, index) => ({ id: rowId * 100 + index, name: `tag ${rowId}.${index}` }));

const itemsFor = (count: number, childCount: number, start = 0, onClick: () => void = () => undefined) =>
  Array.from({ length: count }, (_, index) => ({
    id: start + index,
    label: `Row ${start + index}`,
    selected: false,
    tags: tagsFor(start + index, childCount),
    onClick,
  }));

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] as number;
};

const installDom = (dom: JSDOM): (() => void) => {
  const names = [
    "window",
    "document",
    "Node",
    "Element",
    "HTMLElement",
    "HTMLTemplateElement",
    "HTMLTableElement",
    "HTMLTableRowElement",
    "HTMLTableSectionElement",
    "HTMLInputElement",
    "HTMLSpanElement",
    "HTMLSelectElement",
    "HTMLTextAreaElement",
    "Comment",
    "Text",
    "NodeFilter",
    "DOMException",
    "Event",
    "MouseEvent",
    "KeyboardEvent",
  ] as const;
  const target = globalThis as unknown as Record<string, unknown>;
  const previous = new Map<string, { present: boolean; value: unknown }>();
  for (const name of names) {
    previous.set(name, { present: Object.hasOwn(target, name), value: target[name] });
    target[name] = (dom.window as unknown as Record<string, unknown>)[name];
  }
  return () => {
    for (const name of names) {
      const value = previous.get(name);
      if (value?.present) target[name] = value.value;
      else delete target[name];
    }
  };
};

/**
 * The low-level path: keyed rows with hand-written binding code, a manual
 * keyed child list, and real event listeners that are removed on clear.
 */
const createKeyedRowsDriver = (tbody: HTMLTableSectionElement): ListDriver => {
  const cellText = (row: HTMLTableRowElement, index: number): Text => {
    const text = row.cells[index]?.firstChild;
    if (!(text instanceof Text)) throw new Error(`Missing benchmark cell ${index}.`);
    return text;
  };
  const listenerCleanups = new Map<HTMLTableRowElement, () => void>();
  const itemsByRow = new WeakMap<HTMLTableRowElement, RepresentativeItem>();
  // Child identity is tracked off-DOM so the markup stays identical to the
  // generated paths.
  const childKeys = new WeakMap<Element, number>();
  let current: readonly RepresentativeItem[] = [];
  const syncChildren = (row: HTMLTableRowElement, item: RepresentativeItem): void => {
    const list = row.cells[3]?.querySelector("ul");
    if (!list) throw new Error("Missing benchmark child list.");
    const existing = new Map<number, Element>();
    for (const child of Array.from(list.children)) {
      const key = childKeys.get(child);
      if (child.tagName === "LI" && key !== undefined) existing.set(key, child);
    }
    const next: Element[] = [];
    for (const tag of item.tags) {
      let child = existing.get(tag.id);
      if (!child) {
        child = row.ownerDocument.createElement("li");
        childKeys.set(child, tag.id);
      }
      child.textContent = tag.name;
      next.push(child);
    }
    list.replaceChildren(...next);
  };
  const bindRow = (row: HTMLTableRowElement, item: RepresentativeItem): void => {
    itemsByRow.set(row, item);
    cellText(row, 0).data = String(item.id);
    const input = row.cells[1]?.querySelector("input");
    const label = row.cells[1]?.querySelector("span");
    if (!(input instanceof HTMLInputElement) || !(label instanceof HTMLSpanElement)) {
      throw new Error("Missing benchmark label controls.");
    }
    input.value = item.label;
    label.textContent = item.label;
    cellText(row, 2).data = item.selected ? "selected" : "";
    row.classList.toggle("selected", item.selected);
    syncChildren(row, item);
    if (!listenerCleanups.has(row)) {
      // Mirrors the template's bind:value contract: the model property is
      // written; a text binding on a plain item object does not re-render.
      const onInput = (): void => {
        const bound = itemsByRow.get(row);
        if (bound) bound.label = input.value;
      };
      const onClick = (): void => itemsByRow.get(row)?.onClick();
      input.addEventListener("input", onInput);
      row.addEventListener("click", onClick);
      listenerCleanups.set(row, () => {
        input.removeEventListener("input", onInput);
        row.removeEventListener("click", onClick);
      });
    }
  };
  const driver = createKeyedRows<RepresentativeItem>({ tbody, row: rowHtml, bind: bindRow });
  const rowElements = (): HTMLTableRowElement[] =>
    Array.from(tbody.children).filter((row): row is HTMLTableRowElement => row instanceof HTMLTableRowElement);
  const rebindAll = (items: readonly RepresentativeItem[]): void => {
    const rows = rowElements();
    items.forEach((item, index) => {
      const row = rows[index];
      if (row) bindRow(row, item);
    });
  };
  const replace = (items: readonly RepresentativeItem[]): void => {
    current = [...items];
    driver.replace(current);
    rebindAll(current);
  };
  const inputAt = (rowIndex: number): HTMLInputElement => {
    const input = rowElements()[rowIndex]?.querySelector("input");
    if (!(input instanceof HTMLInputElement)) throw new Error(`Missing input for row ${rowIndex}.`);
    return input;
  };
  return {
    replace,
    append: (items) => {
      current = [...current, ...items];
      driver.append(items);
      rebindAll(current);
    },
    partialUpdate: (items) => {
      current = items.map((item, index) => (index % 5 === 0 ? { ...item, label: `${item.label} !` } : item));
      rebindAll(current);
    },
    swap: () => {
      const last = driver.length() - 2;
      if (last < 2) return;
      const next = [...current];
      [next[1], next[last]] = [next[last] as RepresentativeItem, next[1] as RepresentativeItem];
      current = next;
      driver.swap(1, last);
      rebindAll(current);
    },
    remove: () => {
      current = current.filter((_, index) => index !== 2);
      driver.removeAt(2);
      rebindAll(current);
    },
    reorderChildren: () => {
      current = current.map((item, index) => (index % 3 === 0 ? { ...item, tags: [...item.tags].reverse() } : item));
      rebindAll(current);
    },
    emptyChildren: () => {
      current = current.map((item, index) => (index % 4 === 1 ? { ...item, tags: [] } : item));
      rebindAll(current);
    },
    dispose: () => {
      for (const cleanup of listenerCleanups.values()) cleanup();
      listenerCleanups.clear();
      current = [];
      driver.clear();
    },
    rows: rowElements,
    childRows: (rowIndex) => Array.from(rowElements()[rowIndex]?.querySelectorAll("li") ?? []),
    typeInto: (rowIndex, value) => {
      const input = inputAt(rowIndex);
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    },
    click: (rowIndex) => {
      const row = rowElements()[rowIndex];
      if (!row) throw new Error(`Missing row ${rowIndex}.`);
      row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    },
    setSelected: (rowIndex, selected) => {
      current = current.map((item, index) => (index === rowIndex ? { ...item, selected } : item));
      rebindAll(current);
    },
    inputValue: (rowIndex) => inputAt(rowIndex).value,
    current: () => current,
  };
};

const createDriver = (
  pathName: PathName,
  tbody: HTMLTableSectionElement,
  generatedModules: LoadedRepresentativeModules,
): ListDriver =>
  pathName === "keyed-rows"
    ? createKeyedRowsDriver(tbody)
    : createGeneratedTemplateDriver(pathName, tbody, generatedModules);

const domFor = (tbody: HTMLTableSectionElement): string => tbody.innerHTML;

const identitySnapshot = (driver: ListDriver): { rows: Map<number, Element>; children: Map<number, Element> } => {
  const rows = new Map<number, Element>();
  const children = new Map<number, Element>();
  const items = driver.current();
  driver.rows().forEach((row, index) => {
    const item = items[index];
    if (!item) return;
    rows.set(item.id, row);
    driver.childRows(index).forEach((child, childIndex) => {
      const tag = item.tags[childIndex];
      if (tag) children.set(tag.id, child);
    });
  });
  return { rows, children };
};

const operationOracleFor = (
  driver: ListDriver,
  tbody: HTMLTableSectionElement,
  before: ReturnType<typeof identitySnapshot>,
): RepresentativeOperationOracle => {
  const after = identitySnapshot(driver);
  let preservedRowIdentities = 0;
  for (const [id, element] of after.rows) if (before.rows.get(id) === element) preservedRowIdentities++;
  let preservedChildIdentities = 0;
  for (const [id, element] of after.children) if (before.children.get(id) === element) preservedChildIdentities++;
  return {
    domHash: hash(domFor(tbody)),
    rowCount: driver.rows().length,
    childCounts: driver.rows().map((_, index) => driver.childRows(index).length),
    liveInputValues: driver.rows().map((_, index) => driver.inputValue(index)),
    preservedRowIdentities,
    preservedChildIdentities,
  };
};

const runPathSample = (
  pathName: PathName,
  workload: RepresentativeWorkload,
  sampleIndex: number,
  generatedModules: LoadedRepresentativeModules,
): RepresentativeSample => {
  const dom = new JSDOM(`<table><tbody></tbody></table>`);
  const restore = installDom(dom);
  try {
    const tbody = dom.window.document.querySelector("tbody") as HTMLTableSectionElement;
    const driver = createDriver(pathName, tbody, generatedModules);
    const initial = itemsFor(workload.itemCount, workload.childCount);
    const appended = itemsFor(workload.appendCount, workload.childCount, workload.itemCount);
    const operationDurationsMs = {} as Record<OperationName, number>;
    const operationOracles = {} as Record<OperationName, RepresentativeOperationOracle>;
    const operationDomHtml = {} as Record<OperationName, string>;
    // Timing covers only the DOM operation; identity snapshots, hashes, and
    // oracle assertions run outside the measured interval on every path.
    const operation = (name: OperationName, run: () => void): void => {
      const before = identitySnapshot(driver);
      const started = performance.now();
      run();
      operationDurationsMs[name] = performance.now() - started;
      operationDomHtml[name] = domFor(tbody);
      operationOracles[name] = operationOracleFor(driver, tbody, before);
    };
    const gc = (globalThis as unknown as { gc?: () => void }).gc;
    const beforeGc = gc ? performance.now() : 0;
    gc?.();
    const gcBeforeMs = gc ? performance.now() - beforeGc : null;
    const startedHeap = process.memoryUsage().heapUsed;
    operation("create", () => driver.replace(initial));
    operation("append", () => driver.append(appended));
    operation("partial-update", () => driver.partialUpdate([...initial, ...appended]));
    operation("swap", () => driver.swap());
    operation("remove", () => driver.remove());
    operation("child-reorder", () => driver.reorderChildren());
    operation("child-empty", () => driver.emptyChildren());
    operation("mount-dispose", () => {
      for (let iteration = 0; iteration < 3; iteration++) {
        driver.replace(initial);
        driver.dispose();
      }
    });
    const heapDeltaBytes = process.memoryUsage().heapUsed - startedHeap;
    driver.dispose();
    const gcStarted = gc ? performance.now() : 0;
    gc?.();
    const gcMs = gc ? (gcBeforeMs ?? 0) + performance.now() - gcStarted : null;
    const retainedHeapBytes = gc ? process.memoryUsage().heapUsed - startedHeap : null;
    return {
      sampleIndex,
      durationMs: Object.values(operationDurationsMs).reduce((total, value) => total + value, 0),
      heapDeltaBytes,
      allocatedBytes: null,
      gcMs,
      retainedHeapBytes,
      operationDurationsMs,
      operationOracles,
      operationDomHtml,
      finalDomHash: hash(domFor(tbody)),
      finalRowCount: tbody.children.length,
    };
  } finally {
    restore();
    dom.window.close();
  }
};

const runInteractiveSample = (
  pathName: InteractivePathName,
  workload: RepresentativeWorkload,
  sampleIndex: number,
  generatedModules: LoadedRepresentativeModules,
): RepresentativeInteractiveSample => {
  const dom = new JSDOM(`<table><tbody></tbody></table>`);
  const restore = installDom(dom);
  try {
    const tbody = dom.window.document.querySelector("tbody") as HTMLTableSectionElement;
    const driver = createDriver(pathName, tbody, generatedModules);
    let clickCount = 0;
    const initial = itemsFor(workload.itemCount, workload.childCount, 0, () => {
      clickCount++;
    });
    driver.replace(initial);
    const operationDurationsMs = {} as Record<InteractiveOperationName, number>;
    const operationOracles = {} as Record<InteractiveOperationName, RepresentativeInteractiveOracle>;
    const oracle = (handlerRunsAfterDispose = 0): RepresentativeInteractiveOracle => ({
      domHash: hash(domFor(tbody)),
      inputValue: driver.inputValue(1),
      modelLabel: driver.current()[1]?.label ?? "",
      clickCount,
      selectedClassStates: driver.rows().map((row) => row.classList.contains("selected")),
      handlerRunsAfterDispose,
    });
    const operation = (name: InteractiveOperationName, run: () => void): void => {
      const started = performance.now();
      run();
      operationDurationsMs[name] = performance.now() - started;
      operationOracles[name] = oracle();
    };
    operation("input", () => driver.typeInto(1, "typed"));
    operation("click", () => {
      driver.click(1);
      driver.click(3);
    });
    operation("selected-toggle", () => {
      driver.setSelected(2, true);
      driver.setSelected(2, false);
      driver.setSelected(4, true);
    });
    // Handlers must not run once the list is disposed, even if a detached row
    // still receives a synthetic event.
    const detachedRow = driver.rows()[1];
    const detachedInput = driver.inputValue(1);
    const clicksBeforeDispose = clickCount;
    driver.dispose();
    detachedRow?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    operationOracles["selected-toggle"] = {
      ...(operationOracles["selected-toggle"] as RepresentativeInteractiveOracle),
      handlerRunsAfterDispose: clickCount - clicksBeforeDispose,
      inputValue: detachedInput,
    };
    return {
      sampleIndex,
      durationMs: Object.values(operationDurationsMs).reduce((total, value) => total + value, 0),
      operationDurationsMs,
      operationOracles,
    };
  } finally {
    restore();
    dom.window.close();
  }
};

const runPath = (
  pathName: PathName,
  workload: RepresentativeWorkload,
  generatedModules: LoadedRepresentativeModules,
): RepresentativePathMeasurement => {
  for (let index = 0; index < workload.warmup; index++) runPathSample(pathName, workload, -index - 1, generatedModules);
  const samples = Array.from({ length: workload.iterations }, (_, index) =>
    runPathSample(pathName, workload, index, generatedModules),
  );
  return {
    samples,
    medianDurationMs: median(samples.map((sample) => sample.durationMs)) ?? 0,
    medianHeapDeltaBytes: median(samples.map((sample) => sample.heapDeltaBytes)) ?? 0,
    medianGcMs: median(samples.flatMap((sample) => (sample.gcMs === null ? [] : [sample.gcMs]))),
    medianRetainedHeapBytes: median(
      samples.flatMap((sample) => (sample.retainedHeapBytes === null ? [] : [sample.retainedHeapBytes])),
    ),
  };
};

const runInteractivePath = (
  pathName: InteractivePathName,
  workload: RepresentativeWorkload,
  generatedModules: LoadedRepresentativeModules,
): RepresentativeInteractiveMeasurement => {
  for (let index = 0; index < workload.warmup; index++) {
    runInteractiveSample(pathName, workload, -index - 1, generatedModules);
  }
  const samples = Array.from({ length: workload.iterations }, (_, index) =>
    runInteractiveSample(pathName, workload, index, generatedModules),
  );
  return { samples, medianDurationMs: median(samples.map((sample) => sample.durationMs)) ?? 0 };
};

const sameOracle = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

export const runRepresentativeBenchmark = async (
  options: {
    iterations?: number;
    warmup?: number;
    itemCount?: number;
    appendCount?: number;
    childCount?: number;
    output?: string;
    argv?: readonly string[];
  } = {},
): Promise<RepresentativeBenchmark> => {
  const workload: RepresentativeWorkload = {
    contractVersion: TEMPLATE_REPRESENTATIVE_CONTRACT_VERSION,
    paths: TEMPLATE_REPRESENTATIVE_PATHS,
    operations: TEMPLATE_REPRESENTATIVE_OPERATIONS,
    interactivePaths: TEMPLATE_REPRESENTATIVE_INTERACTIVE_PATHS,
    interactiveOperations: TEMPLATE_REPRESENTATIVE_INTERACTIVE_OPERATIONS,
    interactiveOutOfScope: {
      "text-template": "no model or event bindings; manual state writes would not exercise write-back",
    },
    liveInputPaths: TEMPLATE_REPRESENTATIVE_LIVE_INPUT_PATHS,
    itemCount: options.itemCount ?? 100,
    appendCount: options.appendCount ?? 20,
    childCount: options.childCount ?? 3,
    warmup: options.warmup ?? 5,
    iterations: options.iterations ?? 30,
    buildMode: "generated-client-source",
    generatedTemplateSources: REPRESENTATIVE_TEMPLATE_SOURCES,
    memoryMeasurement: "heap-delta-only",
    timingScope: "warm-dom-operations-excluding-oracles",
  };
  if (!Number.isInteger(workload.iterations) || workload.iterations <= 0)
    throw new RangeError("iterations must be positive.");
  const generatedModules = await loadRepresentativeGeneratedModules();
  const cold = {
    "text-template": generatedModules["text-template"].timing,
    "mixed-template": generatedModules["mixed-template"].timing,
  };
  const paths = Object.fromEntries(
    TEMPLATE_REPRESENTATIVE_PATHS.map((pathName) => [pathName, runPath(pathName, workload, generatedModules)]),
  ) as Record<PathName, RepresentativePathMeasurement>;
  const first = paths[TEMPLATE_REPRESENTATIVE_PATHS[0]] as RepresentativePathMeasurement;
  const oracle = Object.fromEntries(
    TEMPLATE_REPRESENTATIVE_OPERATIONS.map((operation) => [
      operation,
      first.samples[0]?.operationOracles[operation],
    ]),
  ) as Record<OperationName, RepresentativeOperationOracle>;
  const comparable = (value: RepresentativeOperationOracle, pathName: PathName): RepresentativeOperationOracle =>
    (TEMPLATE_REPRESENTATIVE_LIVE_INPUT_PATHS as readonly string[]).includes(pathName)
      ? value
      : { ...value, liveInputValues: [] };
  for (const pathName of TEMPLATE_REPRESENTATIVE_PATHS) {
    for (const sample of paths[pathName].samples) {
      for (const operation of TEMPLATE_REPRESENTATIVE_OPERATIONS) {
        if (!sameOracle(comparable(sample.operationOracles[operation], pathName), comparable(oracle[operation], pathName))) {
          throw new Error(
            `Oracle mismatch for ${pathName} at ${operation}: ${JSON.stringify(sample.operationOracles[operation])} !== ${JSON.stringify(oracle[operation])} ${JSON.stringify(sample.operationDomHtml[operation])}`,
          );
        }
      }
      if (sample.finalRowCount !== 0) throw new Error(`Final DOM was not disposed for ${pathName}.`);
    }
  }
  const interactive = Object.fromEntries(
    TEMPLATE_REPRESENTATIVE_INTERACTIVE_PATHS.map((pathName) => [
      pathName,
      runInteractivePath(pathName, workload, generatedModules),
    ]),
  ) as Record<InteractivePathName, RepresentativeInteractiveMeasurement>;
  const firstInteractive = interactive[TEMPLATE_REPRESENTATIVE_INTERACTIVE_PATHS[0]];
  const interactiveOracle = Object.fromEntries(
    TEMPLATE_REPRESENTATIVE_INTERACTIVE_OPERATIONS.map((operation) => [
      operation,
      firstInteractive.samples[0]?.operationOracles[operation],
    ]),
  ) as Record<InteractiveOperationName, RepresentativeInteractiveOracle>;
  for (const pathName of TEMPLATE_REPRESENTATIVE_INTERACTIVE_PATHS) {
    for (const sample of interactive[pathName].samples) {
      for (const operation of TEMPLATE_REPRESENTATIVE_INTERACTIVE_OPERATIONS) {
        if (!sameOracle(sample.operationOracles[operation], interactiveOracle[operation])) {
          throw new Error(
            `Interactive oracle mismatch for ${pathName} at ${operation}: ${JSON.stringify(sample.operationOracles[operation])} !== ${JSON.stringify(interactiveOracle[operation])}`,
          );
        }
      }
    }
  }
  const argv = options.argv ?? [process.execPath, fileURLToPath(import.meta.url)];
  const provenance = await collectBenchmarkProvenance({
    cwd: process.cwd(),
    argv,
    dependencies: await collectDependencyVersions(process.cwd(), ["jsdom"]),
  });
  const result: RepresentativeBenchmark = {
    schemaVersion: 2,
    benchmark: { name: "template-representative", contractVersion: TEMPLATE_REPRESENTATIVE_CONTRACT_VERSION },
    provenance,
    workload,
    measurements: { cold, paths, interactive, oracle, interactiveOracle },
  };
  if (options.output) {
    await mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
    await writeFile(options.output, `${JSON.stringify(result, null, 2)}\n`);
  }
  return result;
};

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

const main = async (): Promise<void> => {
  const runId = argument("--run-id") ?? `${new Date().toISOString().replaceAll(/[^0-9]/g, "")}-${process.pid}`;
  // Contract version 3 results live beside the older files; nothing is overwritten.
  const output = path.resolve(argument("--output") ?? `benchmark/template-representative-results/${runId}-v3.json`);
  const result = await runRepresentativeBenchmark({
    iterations: Number(argument("--iterations") ?? 30),
    warmup: Number(argument("--warmup") ?? 5),
    itemCount: Number(argument("--items") ?? 100),
    appendCount: Number(argument("--append") ?? 20),
    childCount: Number(argument("--children") ?? 3),
    output,
    argv: process.argv,
  });
  console.log(JSON.stringify({ output, benchmark: result.benchmark, workload: result.workload }, null, 2));
};

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
