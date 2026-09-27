import type {
  GeneratedClientModule,
  GeneratedTemplateDriver,
  GeneratedTemplateItem,
} from "./generated-template-driver.js";
import type { BrowserRepresentativeSample } from "./browser-representative.js";
import type { PerformanceCounterName } from "../src/runtime/performance-counters.js";

type BrowserSampleArgs = {
  pathName: "keyed-rows" | "text-template" | "mixed-template";
  itemCount: number;
  childCount: number;
  bundles: { driverCode: string; textCode: string; mixedCode: string };
  counterDiagnostics?: boolean;
  traceDiagnostics?: boolean;
};

const importBundle = async (code: string) => {
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  try {
    const nativeImport = new Function("url", "return import(url)") as (url: string) => Promise<unknown>;
    return await nativeImport(url);
  } finally {
    URL.revokeObjectURL(url);
  }
};

type NodeCounts = { elements: number; text: number; comments: number };

const countNodes = (): NodeCounts => {
  const counts = { elements: 0, text: 0, comments: 0 };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ALL);
  for (let node: Node | null = walker.currentNode; node; node = walker.nextNode()) {
    if (node.nodeType === Node.ELEMENT_NODE) counts.elements++;
    else if (node.nodeType === Node.TEXT_NODE) counts.text++;
    else if (node.nodeType === Node.COMMENT_NODE) counts.comments++;
  }
  return counts;
};

let memoryDriver: GeneratedTemplateDriver | undefined;
let memoryItemCount = 0;
let memoryChildCount = 0;

const createMemoryItems = (): GeneratedTemplateItem[] =>
  Array.from({ length: memoryItemCount }, (_, index) => ({
    id: index,
    label: `Row ${index}`,
    selected: false,
    tags: Array.from({ length: memoryChildCount }, (_, tagIndex) => ({
      id: index * 100 + tagIndex,
      name: `tag ${index}.${tagIndex}`,
    })),
    onClick: () => undefined,
  }));

export const prepareMemorySample = async ({
  pathName,
  itemCount,
  childCount,
  bundles,
}: BrowserSampleArgs): Promise<NodeCounts> => {
  const drivers = (await importBundle(bundles.driverCode)) as typeof import("./representative-drivers.js") &
    typeof import("./generated-representative-driver.js");
  const module =
    pathName === "keyed-rows"
      ? undefined
      : ((await importBundle(
          pathName === "text-template" ? bundles.textCode : bundles.mixedCode,
        )) as GeneratedClientModule);
  const tbody = document.querySelector("tbody");
  if (!(tbody instanceof HTMLTableSectionElement)) throw new Error("Missing benchmark table body.");
  memoryDriver =
    pathName === "keyed-rows"
      ? drivers.createKeyedRowsDriver(tbody)
      : drivers.createGeneratedTemplateDriver(tbody, module as GeneratedClientModule);
  memoryItemCount = itemCount;
  memoryChildCount = childCount;
  return countNodes();
};

export const mountMemorySample = (): NodeCounts => {
  if (!memoryDriver) throw new Error("Memory sample is not prepared.");
  memoryDriver.replace(createMemoryItems());
  return countNodes();
};

export const disposeMemorySample = (): NodeCounts => {
  if (!memoryDriver) throw new Error("Memory sample is not mounted.");
  memoryDriver.dispose();
  return countNodes();
};

export const repeatMemoryCycles = (additionalCycles: number): NodeCounts => {
  if (!memoryDriver) throw new Error("Memory sample is not prepared.");
  for (let cycle = 0; cycle < additionalCycles; cycle++) {
    memoryDriver.replace(createMemoryItems());
    memoryDriver.dispose();
  }
  return countNodes();
};

export const releaseMemorySample = (): void => {
  memoryDriver = undefined;
};

export const runSample = async ({
  pathName,
  itemCount,
  childCount,
  bundles,
  counterDiagnostics,
  traceDiagnostics,
}: BrowserSampleArgs): Promise<BrowserRepresentativeSample> => {
  const importStarted = performance.now();
  const drivers = (await importBundle(bundles.driverCode)) as typeof import("./representative-drivers.js") &
    typeof import("./generated-representative-driver.js");
  const module =
    pathName === "keyed-rows"
      ? undefined
      : ((await importBundle(
          pathName === "text-template" ? bundles.textCode : bundles.mixedCode,
        )) as GeneratedClientModule);
  const coldImportMs = performance.now() - importStarted;
  const tbody = document.querySelector("tbody");
  if (!(tbody instanceof HTMLTableSectionElement)) throw new Error("Missing benchmark table body.");
  const driver =
    pathName === "keyed-rows"
      ? drivers.createKeyedRowsDriver(tbody)
      : drivers.createGeneratedTemplateDriver(tbody, module as GeneratedClientModule);
  let clickCount = 0;
  const itemsFor = (count: number, start = 0) =>
    Array.from({ length: count }, (_, index) => ({
      id: start + index,
      label: `Row ${start + index}`,
      selected: false,
      tags: Array.from({ length: childCount }, (_, tagIndex) => ({
        id: (start + index) * 100 + tagIndex,
        name: `tag ${start + index}.${tagIndex}`,
      })),
      onClick: () => {
        clickCount++;
      },
    }));
  const initial = itemsFor(itemCount);
  const appended = itemsFor(Math.max(1, Math.floor(itemCount / 4)), itemCount);
  const snapshot = () => {
    const rows = new Map<number, Element>();
    const children = new Map<number, Element>();
    driver.rows().forEach((row: Element, rowIndex: number) => {
      const item = driver.current()[rowIndex];
      if (!item) return;
      rows.set(item.id, row);
      driver.childRows(rowIndex).forEach((child: Element, childIndex: number) => {
        const tag = item.tags[childIndex];
        if (tag) children.set(tag.id, child);
      });
    });
    return { rows, children };
  };
  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const counters = () =>
    ({
      ...(globalThis as typeof globalThis & { __tachyonPerformanceCounters?: Record<string, number> })
        .__tachyonPerformanceCounters,
    }) as Partial<Record<PerformanceCounterName, number>>;
  const measure = async (name: string, run: () => void) => {
    const before = snapshot();
    const beforeCounters = counterDiagnostics ? counters() : undefined;
    if (traceDiagnostics) performance.mark(`tachyon:${name}:start`);
    const started = performance.now();
    run();
    const syncUpdateMs = performance.now() - started;
    if (traceDiagnostics) performance.mark(`tachyon:${name}:sync`);
    const afterCounters = counterDiagnostics ? counters() : undefined;
    await frame();
    await frame();
    const settledUpdateMs = performance.now() - started;
    if (traceDiagnostics) performance.mark(`tachyon:${name}:settled`);
    const after = snapshot();
    const rows = driver.rows();
    if (rows.length !== driver.current().length) throw new Error("Rendered row count differs from the model.");
    rows.forEach((row, rowIndex) => {
      const item = driver.current()[rowIndex];
      const label = row.cells[1]?.querySelector("span")?.textContent;
      if (!item || row.cells[0]?.textContent !== String(item.id) || label !== item.label) {
        throw new Error(`Rendered row ${rowIndex} differs from the model.`);
      }
      const children = driver.childRows(rowIndex);
      if (
        children.length !== item.tags.length ||
        children.some((child, index) => child.textContent !== item.tags[index]?.name)
      ) {
        throw new Error(`Rendered child list ${rowIndex} differs from the model.`);
      }
      if (pathName !== "text-template" && driver.inputValue(rowIndex) !== item.label) {
        throw new Error(`Live input ${rowIndex} differs from the model.`);
      }
    });
    return {
      syncUpdateMs,
      settledUpdateMs,
      rowCount: rows.length,
      preservedRowIdentities: [...after.rows].filter(([key, row]) => before.rows.get(key) === row).length,
      preservedChildIdentities: [...after.children].filter(([key, child]) => before.children.get(key) === child).length,
      ...(afterCounters
        ? {
            counters: Object.fromEntries(
              Object.entries(afterCounters).map(([key, value]) => [
                key,
                value - (beforeCounters?.[key as PerformanceCounterName] ?? 0),
              ]),
            ),
          }
        : {}),
    };
  };
  const create = await measure("create", () => driver.replace(initial));
  const append = await measure("append", () => driver.append(appended));
  const partialUpdate = await measure("partialUpdate", () => driver.partialUpdate([...initial, ...appended]));
  const noChange = await measure("noChange", () => driver.noChange());
  const sparseOnePercent = await measure("sparseOnePercent", () => driver.sparseUpdate(1, false));
  const sparseTenPercent = await measure("sparseTenPercent", () => driver.sparseUpdate(10, false));
  const fullValueUpdate = await measure("fullValueUpdate", () => driver.sparseUpdate(100, false));
  const mutableOnePercent = await measure("mutableOnePercent", () => driver.sparseUpdate(1, true));
  const swap = await measure("swap", () => driver.swap());
  const remove = await measure("remove", () => driver.remove());
  const childReorder = await measure("childReorder", () => driver.reorderChildren());
  const childEmpty = await measure("childEmpty", () => driver.emptyChildren());
  let interaction;
  if (pathName !== "text-template") {
    driver.typeInto(1, "typed");
    driver.click(1);
    driver.setSelected(2, true);
    if (!driver.rows()[2]?.classList.contains("selected")) throw new Error("Selection class did not update.");
    interaction = {
      inputValue: driver.inputValue(1),
      modelLabel: driver.current()[1]?.label ?? "",
      clickCount,
      handlerRunsAfterDispose: 0,
    };
  }
  const detachedRow = driver.rows()[1];
  const clicksBeforeDispose = clickCount;
  const dispose = await measure("dispose", () => driver.dispose());
  detachedRow?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  if (interaction) interaction.handlerRunsAfterDispose = clickCount - clicksBeforeDispose;
  return {
    coldImportMs,
    create,
    append,
    partialUpdate,
    noChange,
    sparseOnePercent,
    sparseTenPercent,
    fullValueUpdate,
    mutableOnePercent,
    swap,
    remove,
    childReorder,
    childEmpty,
    dispose,
    ...(interaction ? { interaction } : {}),
  };
};
