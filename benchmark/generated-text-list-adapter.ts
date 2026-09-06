import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import {
  GENERATED_TEXT_LIST_ADAPTER_SOURCE,
  generatedClientArtifact,
  loadCandidateModule,
  type GeneratedClientModule,
  type LoadedGeneratedModule,
} from "./generated-template-driver.js";
import { collectBenchmarkProvenance, collectDependencyVersions, type BenchmarkEnvelope } from "./provenance.js";

export const GENERATED_TEXT_LIST_ADAPTER_CONTRACT_VERSION = 1;
export const GENERATED_TEXT_LIST_ADAPTER_SPEED_THRESHOLD = 1.1;

const GENERATED_ADAPTER_IMPORT = "mountGeneratedTextKeyedList as __tachyonMountTextKeyedList";
const LEGACY_ADAPTER_IMPORT = "mountTextKeyedList as __tachyonMountTextKeyedList";

type AdapterName = "generated" | "legacy";
type OperationName = "update" | "reorder" | "append" | "remove" | "restore";

type AdapterItem = {
  id: number;
  label: string;
};

type AdapterSample = {
  sampleIndex: number;
  durationMs: number;
  operationDurationsMs: Record<OperationName, number>;
};

type AdapterSummary = {
  sampleCount: number;
  medianDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  medianOperationDurationsMs: Record<OperationName, number>;
};

type AdapterArtifact = {
  adapter: AdapterName;
  generatedSourceImport: string;
  bundleIncludesListTextRuntime: boolean;
  bundleIncludesAdapterImplementation: boolean;
  minifiedBytes: number;
  brotliBytes: number;
  timing: LoadedGeneratedModule["timing"];
};

export type GeneratedTextListAdapterWorkload = {
  contractVersion: typeof GENERATED_TEXT_LIST_ADAPTER_CONTRACT_VERSION;
  source: string;
  itemCount: number;
  operations: readonly OperationName[];
  warmup: number;
  iterations: number;
  buildMode: "generated-client-source";
  adapterComparison: "same-generated-source-import-switch";
  speedThresholdRatio: number;
  timingScope: "warm-generated-dom-operations-excluding-oracles";
};

export type GeneratedTextListAdapterMeasurements = {
  artifacts: Record<AdapterName, AdapterArtifact>;
  samples: Record<AdapterName, AdapterSample[]>;
  summaries: Record<AdapterName, AdapterSummary>;
  pairedSamples: Array<{
    sampleIndex: number;
    first: AdapterName;
    generatedDurationMs: number;
    legacyDurationMs: number;
    totalRatio: number;
  }>;
  gates: {
    generatedImport: boolean;
    generatedBundle: boolean;
    legacyBundle: boolean;
    listTextMetafileInput: boolean;
    minifiedSizeReduced: boolean;
    brotliSizeReduced: boolean;
    speedWithinThreshold: boolean;
    decision: "candidate" | "indeterminate";
  };
};

export type GeneratedTextListAdapterBenchmark = BenchmarkEnvelope<
  GeneratedTextListAdapterWorkload,
  GeneratedTextListAdapterMeasurements
>;

const median = (values: readonly number[]): number => {
  if (values.length === 0) throw new Error("Cannot calculate a median from no samples.");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] as number;
};

const summarize = (samples: readonly AdapterSample[]): AdapterSummary => {
  if (samples.length === 0) throw new Error("The benchmark produced no samples.");
  const operationNames: readonly OperationName[] = ["update", "reorder", "append", "remove", "restore"];
  return {
    sampleCount: samples.length,
    medianDurationMs: median(samples.map((sample) => sample.durationMs)),
    minDurationMs: Math.min(...samples.map((sample) => sample.durationMs)),
    maxDurationMs: Math.max(...samples.map((sample) => sample.durationMs)),
    medianOperationDurationsMs: Object.fromEntries(
      operationNames.map((operation) => [
        operation,
        median(samples.map((sample) => sample.operationDurationsMs[operation])),
      ]),
    ) as Record<OperationName, number>,
  };
};

const installDom = (dom: JSDOM): (() => void) => {
  const names = [
    "window",
    "document",
    "Node",
    "Element",
    "HTMLElement",
    "HTMLTemplateElement",
    "HTMLUListElement",
    "HTMLLIElement",
    "HTMLSpanElement",
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

const itemsFor = (count: number, suffix = ""): AdapterItem[] =>
  Array.from({ length: count }, (_, id) => ({ id, label: `Row ${id}${suffix}` }));

const inputFilesFor = (metafile: Record<string, unknown>): string[] => {
  const outputs = metafile.outputs;
  if (!outputs || typeof outputs !== "object") return [];
  return Object.values(outputs).flatMap((output) => {
    if (!output || typeof output !== "object") return [];
    const inputs = (output as { inputs?: unknown }).inputs;
    return inputs && typeof inputs === "object" ? Object.keys(inputs) : [];
  });
};

const hasListTextInput = (loaded: LoadedGeneratedModule): boolean =>
  inputFilesFor(loaded.metafile).some((file) => file.replaceAll("\\", "/").endsWith("src/runtime/list-text.ts"));

const hasGeneratedAdapterImplementation = (loaded: LoadedGeneratedModule, adapter: AdapterName): boolean => {
  const marker = adapter === "generated" ? "resolveGeneratedOptions" : "resolveLegacyOptions";
  return loaded.bundledCode.includes(marker);
};

const runSample = (loaded: LoadedGeneratedModule, sampleIndex: number, itemCount: number): AdapterSample => {
  const module = loaded.module;
  const root = document.createElement("ul");
  const initial = itemsFor(itemCount);
  const rows = module.createSignal<readonly AdapterItem[]>(initial);
  const cleanup = module.bind(root, { rows });
  const update = itemsFor(itemCount, " updated");
  const reordered = [...update].reverse();
  const appended = [
    ...reordered,
    ...itemsFor(20, " appended").map((item, index) => ({ ...item, id: itemCount + index })),
  ];
  const removed = appended.filter((_, index) => index % 4 !== 0);
  const operations: Array<[OperationName, readonly AdapterItem[]]> = [
    ["update", update],
    ["reorder", reordered],
    ["append", appended],
    ["remove", removed],
    ["restore", initial],
  ];
  const operationDurationsMs = {} as Record<OperationName, number>;
  const started = performance.now();
  for (const [operation, next] of operations) {
    const operationStarted = performance.now();
    rows.set(next);
    operationDurationsMs[operation] = performance.now() - operationStarted;
  }
  const durationMs = performance.now() - started;
  const rendered = Array.from(root.children);
  if (rendered.length !== itemCount || rendered.some((node, index) => node.textContent !== `Row ${index}`)) {
    throw new Error(`Generated ${sampleIndex} produced an invalid final DOM.`);
  }
  if (typeof cleanup === "function") cleanup();
  if (root.childElementCount !== 0) throw new Error(`Generated ${sampleIndex} left DOM after dispose.`);
  return { sampleIndex, durationMs, operationDurationsMs };
};

const loadAdapterArtifacts = async (
  source: string,
): Promise<{
  artifacts: Record<AdapterName, LoadedGeneratedModule>;
  generatedSource: string;
  legacySource: string;
}> => {
  const generated = generatedClientArtifact(source);
  if (!generated.code.includes(GENERATED_ADAPTER_IMPORT)) {
    throw new Error("The pure text-list fixture did not use the generated reader adapter.");
  }
  if (generated.code.includes('from "tachyon-dom/runtime/list"')) {
    throw new Error("The pure text-list fixture unexpectedly used the generic list runtime.");
  }
  const legacy = generated.code.replace(GENERATED_ADAPTER_IMPORT, LEGACY_ADAPTER_IMPORT);
  if (legacy === generated.code || legacy.includes(GENERATED_ADAPTER_IMPORT)) {
    throw new Error("Could not create the same-revision legacy adapter artifact.");
  }
  const [generatedLoaded, legacyLoaded] = await Promise.all([
    loadCandidateModule<GeneratedClientModule>(generated.code, generated.compileMs),
    loadCandidateModule<GeneratedClientModule>(legacy, generated.compileMs),
  ]);
  return {
    artifacts: { generated: generatedLoaded, legacy: legacyLoaded },
    generatedSource: generated.code,
    legacySource: legacy,
  };
};

export const runGeneratedTextListAdapterBenchmark = async (
  options: {
    itemCount?: number;
    warmup?: number;
    iterations?: number;
    output?: string;
    argv?: readonly string[];
  } = {},
): Promise<GeneratedTextListAdapterBenchmark> => {
  const itemCount = options.itemCount ?? 100;
  const warmup = options.warmup ?? 5;
  const iterations = options.iterations ?? 30;
  if (!Number.isInteger(itemCount) || itemCount < 1) throw new Error("itemCount must be a positive integer.");
  if (!Number.isInteger(warmup) || warmup < 0) throw new Error("warmup must be a non-negative integer.");
  if (!Number.isInteger(iterations) || iterations < 1) throw new Error("iterations must be a positive integer.");

  const dom = new JSDOM("<!doctype html>");
  const restoreDom = installDom(dom);
  try {
    const loaded = await loadAdapterArtifacts(GENERATED_TEXT_LIST_ADAPTER_SOURCE);
    const samples: Record<AdapterName, AdapterSample[]> = { generated: [], legacy: [] };
    const pairedSamples: GeneratedTextListAdapterMeasurements["pairedSamples"] = [];
    for (let cycle = 0; cycle < warmup + iterations; cycle++) {
      const first: AdapterName = cycle % 2 === 0 ? "generated" : "legacy";
      const second: AdapterName = first === "generated" ? "legacy" : "generated";
      const cycleSamples = new Map<AdapterName, AdapterSample>();
      for (const adapter of [first, second]) {
        const sample = runSample(loaded.artifacts[adapter], cycle, itemCount);
        cycleSamples.set(adapter, sample);
        if (cycle >= warmup) samples[adapter].push({ ...sample, sampleIndex: cycle - warmup });
      }
      if (cycle >= warmup) {
        const generated = cycleSamples.get("generated");
        const legacy = cycleSamples.get("legacy");
        if (!generated || !legacy) throw new Error("A paired adapter sample was missing.");
        pairedSamples.push({
          sampleIndex: cycle - warmup,
          first,
          generatedDurationMs: generated.durationMs,
          legacyDurationMs: legacy.durationMs,
          totalRatio: generated.durationMs / Math.max(legacy.durationMs, Number.EPSILON),
        });
      }
    }

    const summaries = { generated: summarize(samples.generated), legacy: summarize(samples.legacy) };
    const artifact = (adapter: AdapterName): AdapterArtifact => {
      const loadedModule = loaded.artifacts[adapter];
      return {
        adapter,
        generatedSourceImport: adapter === "generated" ? GENERATED_ADAPTER_IMPORT : LEGACY_ADAPTER_IMPORT,
        bundleIncludesListTextRuntime: hasListTextInput(loadedModule),
        bundleIncludesAdapterImplementation: hasGeneratedAdapterImplementation(loadedModule, adapter),
        minifiedBytes: loadedModule.size.minifiedBytes,
        brotliBytes: loadedModule.size.brotliBytes,
        timing: loadedModule.timing,
      };
    };
    const artifacts = { generated: artifact("generated"), legacy: artifact("legacy") };
    const operationNames: readonly OperationName[] = ["update", "reorder", "append", "remove", "restore"];
    const speedWithinThreshold =
      summaries.generated.medianDurationMs <=
        summaries.legacy.medianDurationMs * GENERATED_TEXT_LIST_ADAPTER_SPEED_THRESHOLD &&
      operationNames.every(
        (operation) =>
          summaries.generated.medianOperationDurationsMs[operation] <=
          summaries.legacy.medianOperationDurationsMs[operation] * GENERATED_TEXT_LIST_ADAPTER_SPEED_THRESHOLD,
      );
    const gates = {
      generatedImport: loaded.generatedSource.includes(GENERATED_ADAPTER_IMPORT),
      generatedBundle: artifacts.generated.bundleIncludesAdapterImplementation,
      legacyBundle: artifacts.legacy.bundleIncludesAdapterImplementation,
      listTextMetafileInput:
        artifacts.generated.bundleIncludesListTextRuntime && artifacts.legacy.bundleIncludesListTextRuntime,
      minifiedSizeReduced: artifacts.generated.minifiedBytes < artifacts.legacy.minifiedBytes,
      brotliSizeReduced: artifacts.generated.brotliBytes < artifacts.legacy.brotliBytes,
      speedWithinThreshold,
      decision:
        artifacts.generated.minifiedBytes < artifacts.legacy.minifiedBytes &&
        artifacts.generated.brotliBytes < artifacts.legacy.brotliBytes &&
        speedWithinThreshold
          ? ("candidate" as const)
          : ("indeterminate" as const),
    };
    const workload: GeneratedTextListAdapterWorkload = {
      contractVersion: GENERATED_TEXT_LIST_ADAPTER_CONTRACT_VERSION,
      source: GENERATED_TEXT_LIST_ADAPTER_SOURCE,
      itemCount,
      operations: operationNames,
      warmup,
      iterations,
      buildMode: "generated-client-source",
      adapterComparison: "same-generated-source-import-switch",
      speedThresholdRatio: GENERATED_TEXT_LIST_ADAPTER_SPEED_THRESHOLD,
      timingScope: "warm-generated-dom-operations-excluding-oracles",
    };
    const provenance = await collectBenchmarkProvenance({
      cwd: process.cwd(),
      argv: options.argv ?? [process.execPath, fileURLToPath(import.meta.url)],
      dependencies: await collectDependencyVersions(process.cwd(), ["jsdom", "esbuild"]),
    });
    const result: GeneratedTextListAdapterBenchmark = {
      schemaVersion: 2,
      benchmark: {
        name: "generated-text-list-adapter",
        contractVersion: GENERATED_TEXT_LIST_ADAPTER_CONTRACT_VERSION,
      },
      provenance,
      workload,
      measurements: {
        artifacts,
        samples,
        summaries,
        pairedSamples,
        gates,
      },
    };
    if (options.output) {
      const output = path.resolve(options.output);
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
    }
    return result;
  } finally {
    restoreDom();
    dom.window.close();
  }
};

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

const main = async (): Promise<void> => {
  const output = path.resolve(argument("--output") ?? "docs.local/review/20260906-generated-text-list-adapter.json");
  const result = await runGeneratedTextListAdapterBenchmark({
    itemCount: Number(argument("--items") ?? 100),
    warmup: Number(argument("--warmup") ?? 5),
    iterations: Number(argument("--iterations") ?? 30),
    output,
    argv: process.argv,
  });
  console.log(
    JSON.stringify(
      {
        output,
        artifacts: result.measurements.artifacts,
        summaries: result.measurements.summaries,
        gates: result.measurements.gates,
      },
      null,
      2,
    ),
  );
};

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
