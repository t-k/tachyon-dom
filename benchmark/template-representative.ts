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
} from "./generated-template-driver.js";

export const TEMPLATE_REPRESENTATIVE_CONTRACT_VERSION = 2;
export const TEMPLATE_REPRESENTATIVE_PATHS = ["keyed-rows", "text-template", "mixed-template"] as const;
export const TEMPLATE_REPRESENTATIVE_OPERATIONS = [
  "create",
  "append",
  "partial-update",
  "swap",
  "remove",
  "mount-dispose",
] as const;

type PathName = (typeof TEMPLATE_REPRESENTATIVE_PATHS)[number];
type OperationName = (typeof TEMPLATE_REPRESENTATIVE_OPERATIONS)[number];

export type RepresentativeItem = {
  id: number;
  label: string;
  selected: boolean;
  onClick: () => void;
};

export type RepresentativeSample = {
  sampleIndex: number;
  durationMs: number;
  heapDeltaBytes: number;
  allocatedBytes: null;
  gcMs: number | null;
  retainedHeapBytes: number | null;
  operationDurationsMs: Record<OperationName, number>;
  operationDomHashes: Record<OperationName, string>;
  operationDomHtml: Record<OperationName, string>;
  finalDomHash: string;
  finalRowCount: number;
};

export type RepresentativePathMeasurement = {
  samples: RepresentativeSample[];
  medianDurationMs: number;
  medianHeapDeltaBytes: number;
  medianGcMs: number | null;
  medianRetainedHeapBytes: number | null;
};

export type RepresentativeWorkload = {
  paths: readonly PathName[];
  operations: readonly OperationName[];
  itemCount: number;
  appendCount: number;
  warmup: number;
  iterations: number;
  buildMode: "generated-client-source";
  generatedTemplateSources: Readonly<Record<"text-template" | "mixed-template", string>>;
  memoryMeasurement: "heap-delta-only";
};

export type RepresentativeMeasurements = {
  paths: Record<PathName, RepresentativePathMeasurement>;
  domOracle: Record<OperationName, string>;
};

export type RepresentativeBenchmark = BenchmarkEnvelope<RepresentativeWorkload, RepresentativeMeasurements>;

type ListDriver = {
  replace: (items: readonly RepresentativeItem[]) => void;
  append: (items: readonly RepresentativeItem[]) => void;
  partialUpdate: (items: readonly RepresentativeItem[]) => void;
  swap: () => void;
  remove: () => void;
  dispose: () => void;
};

const rowHtml = `<tr class="row"><td> </td><td><input value=""><span> </span></td><td> </td></tr>`;

const itemsFor = (count: number, start = 0): RepresentativeItem[] =>
  Array.from({ length: count }, (_, index) => ({
    id: start + index,
    label: `Row ${start + index}`,
    selected: false,
    onClick: () => undefined,
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

const createDriver = (
  pathName: PathName,
  tbody: HTMLTableSectionElement,
  generatedModules: Awaited<ReturnType<typeof loadRepresentativeGeneratedModules>>,
): ListDriver => {
  if (pathName !== "keyed-rows") {
    return createGeneratedTemplateDriver(pathName, tbody, generatedModules) as ListDriver;
  }
  const cellText = (row: HTMLTableRowElement, index: number): Text => {
    const text = row.cells[index]?.firstChild;
    if (!(text instanceof Text)) throw new Error(`Missing benchmark cell ${index}.`);
    return text;
  };
  const driver = createKeyedRows<RepresentativeItem>({
    tbody,
    row: rowHtml,
    bind: (row, item) => {
      cellText(row, 0).data = String(item.id);
      const input = row.cells[1]?.querySelector("input");
      const label = row.cells[1]?.querySelector("span");
      if (!(input instanceof HTMLInputElement) || !(label instanceof HTMLSpanElement)) {
        throw new Error("Missing benchmark label controls.");
      }
      input.value = item.label;
      label.textContent = item.label;
      cellText(row, 2).data = item.selected ? "selected" : "";
    },
  });
  return {
    replace: (items) => driver.replace(items),
    append: (items) => driver.append(items),
    partialUpdate: (items) =>
      driver.update(5, (row, index) => {
        const item = items[index];
        if (!item) return;
        const input = row.cells[1]?.querySelector("input");
        const label = row.cells[1]?.querySelector("span");
        if (!(input instanceof HTMLInputElement) || !(label instanceof HTMLSpanElement)) return;
        input.value = `${item.label} !`;
        label.textContent = `${item.label} !`;
      }),
    swap: () => {
      const last = driver.length() - 2;
      if (last >= 2) driver.swap(1, last);
    },
    remove: () => driver.removeAt(2),
    dispose: () => driver.clear(),
  };
};

const domFor = (tbody: HTMLTableSectionElement): string => tbody.innerHTML;

const runPathSample = (
  pathName: PathName,
  workload: RepresentativeWorkload,
  sampleIndex: number,
  generatedModules: Awaited<ReturnType<typeof loadRepresentativeGeneratedModules>>,
): RepresentativeSample => {
  const dom = new JSDOM(`<table><tbody></tbody></table>`);
  const restore = installDom(dom);
  try {
    const tbody = dom.window.document.querySelector("tbody") as HTMLTableSectionElement;
    const driver = createDriver(pathName, tbody, generatedModules);
    const initial = itemsFor(workload.itemCount);
    const appended = itemsFor(workload.appendCount, workload.itemCount);
    const operationDurationsMs = {} as Record<OperationName, number>;
    const operationDomHashes = {} as Record<OperationName, string>;
    const operationDomHtml = {} as Record<OperationName, string>;
    const operation = (name: OperationName, run: () => void): void => {
      const started = performance.now();
      run();
      operationDurationsMs[name] = performance.now() - started;
      operationDomHtml[name] = domFor(tbody);
      operationDomHashes[name] = hash(operationDomHtml[name]);
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
      operationDomHashes,
      operationDomHtml,
      finalDomHash: hash(domFor(tbody)),
      finalRowCount: tbody.children.length,
    };
  } finally {
    restore();
    dom.window.close();
  }
};

const runPath = (
  pathName: PathName,
  workload: RepresentativeWorkload,
  generatedModules: Awaited<ReturnType<typeof loadRepresentativeGeneratedModules>>,
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

export const runRepresentativeBenchmark = async (
  options: {
    iterations?: number;
    warmup?: number;
    itemCount?: number;
    appendCount?: number;
    output?: string;
    argv?: readonly string[];
  } = {},
): Promise<RepresentativeBenchmark> => {
  const workload: RepresentativeWorkload = {
    paths: TEMPLATE_REPRESENTATIVE_PATHS,
    operations: TEMPLATE_REPRESENTATIVE_OPERATIONS,
    itemCount: options.itemCount ?? 100,
    appendCount: options.appendCount ?? 20,
    warmup: options.warmup ?? 2,
    iterations: options.iterations ?? 5,
    buildMode: "generated-client-source",
    generatedTemplateSources: REPRESENTATIVE_TEMPLATE_SOURCES,
    memoryMeasurement: "heap-delta-only",
  };
  if (!Number.isInteger(workload.iterations) || workload.iterations <= 0)
    throw new RangeError("iterations must be positive.");
  const generatedModules = await loadRepresentativeGeneratedModules();
  const paths = Object.fromEntries(
    TEMPLATE_REPRESENTATIVE_PATHS.map((pathName) => [pathName, runPath(pathName, workload, generatedModules)]),
  ) as Record<PathName, RepresentativePathMeasurement>;
  const first = paths[TEMPLATE_REPRESENTATIVE_PATHS[0]] as RepresentativePathMeasurement;
  const domOracle = Object.fromEntries(
    TEMPLATE_REPRESENTATIVE_OPERATIONS.map((operation) => [
      operation,
      first.samples[0]?.operationDomHashes[operation] ?? "",
    ]),
  ) as Record<OperationName, string>;
  for (const pathName of TEMPLATE_REPRESENTATIVE_PATHS) {
    for (const sample of paths[pathName].samples) {
      for (const operation of TEMPLATE_REPRESENTATIVE_OPERATIONS) {
        if (sample.operationDomHashes[operation] !== domOracle[operation]) {
          throw new Error(
            `DOM oracle mismatch for ${pathName} at ${operation}: ${domOracle[operation]} !== ${sample.operationDomHashes[operation]} ${JSON.stringify(sample.operationDomHtml[operation])}`,
          );
        }
      }
      if (sample.finalRowCount !== 0) throw new Error(`Final DOM was not disposed for ${pathName}.`);
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
    measurements: { paths, domOracle },
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
  const output = path.resolve(argument("--output") ?? `benchmark/template-representative-results/${runId}.json`);
  const result = await runRepresentativeBenchmark({
    iterations: Number(argument("--iterations") ?? 5),
    warmup: Number(argument("--warmup") ?? 2),
    output,
    argv: process.argv,
  });
  console.log(JSON.stringify({ output, benchmark: result.benchmark, workload: result.workload }, null, 2));
};

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
