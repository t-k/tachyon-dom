import { randomUUID } from "node:crypto";
import { brotliCompressSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { compileTemplate, generateClientModule, renderServerTemplate } from "../src/compiler/index.js";
import { createRoot, createSignal, effect } from "../src/runtime/signal.js";
import { collectBenchmarkProvenance, collectDependencyVersions, type BenchmarkEnvelope } from "./provenance.js";

export const REPRESENTATION_EVALUATION_CONTRACT_VERSION = 1;

type Metric = {
  durationMs: number;
  allocationBytes: number;
};

type EvaluationDecision = {
  adopted: boolean;
  reason: string;
};

export type RepresentationEvaluation = BenchmarkEnvelope<
  { iterations: number; warmup: number; buildMode: "source" },
  {
    rowCodegen: {
      domEquivalent: boolean;
      generic: { rawSamples: Array<Metric & { codeBytes: number; brotliBytes: number }> };
      specialized: { rawSamples: Array<Metric & { codeBytes: number; brotliBytes: number }> };
      decision: EvaluationDecision;
    };
    signal: {
      distributions: Record<string, { rawSamples: Array<Metric & { representation: "set" | "array" }> }>;
      decision: EvaluationDecision;
    };
    metadata: {
      rawSamples: Array<
        Metric & { currentBytes: number; compactBytes: number; hmrSafe: boolean; scopesIndependent: boolean }
      >;
      decision: EvaluationDecision;
    };
  }
>;

const heapUsed = (): number => process.memoryUsage().heapUsed;

const measure = <T>(run: () => T): Metric & { value: T } => {
  const before = heapUsed();
  const started = performance.now();
  const value = run();
  return { value, durationMs: performance.now() - started, allocationBytes: Math.max(0, heapUsed() - before) };
};

const compilerResult = (source: string) => {
  const result = compileTemplate(source);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

const rowSources = {
  specialized: `<tbody><for each={rows} key={row.id}><tr><td>{row.id}</td><td>{row.label}</td></tr></for></tbody>`,
  generic: `<tbody><for each={rows} key={row.id}><tr on:click={noop}><td>{row.id}</td><td>{row.label}</td></tr></for></tbody>`,
} as const;

const rowScope = {
  rows: Array.from({ length: 24 }, (_, id) => ({ id, label: `Row ${id}` })),
  noop: () => undefined,
};

const rowCodegenEvaluation = (iterations: number, warmup: number) => {
  const templates = {
    specialized: compilerResult(rowSources.specialized),
    generic: compilerResult(rowSources.generic),
  };
  const outputs = {
    specialized: generateClientModule(templates.specialized),
    generic: generateClientModule(templates.generic),
  };
  const domEquivalent =
    renderServerTemplate(templates.specialized, rowScope) === renderServerTemplate(templates.generic, rowScope);
  const sampleFor = (name: "specialized" | "generic"): Array<Metric & { codeBytes: number; brotliBytes: number }> => {
    for (let index = 0; index < warmup; index++) generateClientModule(templates[name]);
    return Array.from({ length: iterations }, () => {
      const sample = measure(() => generateClientModule(templates[name]));
      return {
        durationMs: sample.durationMs,
        allocationBytes: sample.allocationBytes,
        codeBytes: Buffer.byteLength(outputs[name]),
        brotliBytes: brotliCompressSync(outputs[name]).byteLength,
      };
    });
  };
  return {
    domEquivalent,
    generic: { rawSamples: sampleFor("generic") },
    specialized: { rawSamples: sampleFor("specialized") },
    decision: {
      adopted: false,
      reason:
        "The prototype only changes row emission shape; current generic descriptors already provide the cleanup fallback for every binding. Keep the specialized row codegen out until a production build shows a stable size and allocation win.",
    },
  };
};

const setRepresentationSample = (subscriberCount: number): Metric =>
  measure(() => {
    const dispose = createRoot((disposeRoot) => {
      const source = createSignal(0);
      const disposers = Array.from({ length: subscriberCount }, () => effect(() => source()));
      source.set(1);
      return () => {
        for (const disposeEffect of disposers) disposeEffect();
        disposeRoot();
      };
    });
    dispose();
  });

const arrayRepresentationSample = (subscriberCount: number): Metric =>
  measure(() => {
    let value = 0;
    const subscribers: Array<() => void> = [];
    for (let index = 0; index < subscriberCount; index++) subscribers.push(() => value);
    value = 1;
    for (const subscriber of subscribers) subscriber();
  });

const signalEvaluation = (iterations: number, warmup: number) => {
  const distributions: Record<string, { rawSamples: Array<Metric & { representation: "set" | "array" }> }> = {};
  for (const subscriberCount of [0, 1, 4, 16]) {
    for (let index = 0; index < warmup; index++) {
      setRepresentationSample(subscriberCount);
      arrayRepresentationSample(subscriberCount);
    }
    const rawSamples = Array.from({ length: iterations }, () => {
      const set = setRepresentationSample(subscriberCount);
      const array = arrayRepresentationSample(subscriberCount);
      return [
        { ...set, representation: "set" as const },
        { ...array, representation: "array" as const },
      ];
    }).flat() as Array<Metric & { representation: "set" | "array" }>;
    distributions[String(subscriberCount)] = { rawSamples };
  }
  return {
    distributions,
    decision: {
      adopted: false,
      reason:
        "The array candidate is an isolated mechanics comparison and is not wired into signal semantics. Set remains the production representation because the existing batch, diamond, computed-priority, error, and reentrant contracts are covered by runtime tests.",
    },
  };
};

const metadataEvaluation = (iterations: number, warmup: number) => {
  const sourceA = `<main><section hydrate:id={first}><p>{title}</p></section></main>`;
  const sourceB = `<main><section hydrate:id={second}><p>{title}</p></section></main>`;
  const first = compilerResult(sourceA);
  const second = compilerResult(sourceB);
  const firstCode = generateClientModule(first);
  const secondCode = generateClientModule(second);
  const currentMetadata = JSON.stringify({
    hydrationBoundaries: first.client.hydrationBoundaries,
    hydrationDynamicRegions: first.client.hydrationDynamicRegions,
    hydrationDynamicAttributes: first.client.bindings,
  });
  const compactMetadata = JSON.stringify([
    first.client.hydrationBoundaries.map((boundary) => [boundary.path, boundary.id]),
    first.client.hydrationDynamicRegions.map((region) => [region.path, region.index, region.kind]),
    first.client.bindings.map((binding) => [binding.kind, binding.path]),
  ]);
  for (let index = 0; index < warmup; index++) {
    generateClientModule(first);
    generateClientModule(second);
  }
  const rawSamples = Array.from({ length: iterations }, () => {
    const sample = measure(() => {
      generateClientModule(first);
      generateClientModule(second);
      return undefined;
    });
    return {
      durationMs: sample.durationMs,
      allocationBytes: sample.allocationBytes,
      currentBytes: Buffer.byteLength(currentMetadata),
      compactBytes: Buffer.byteLength(compactMetadata),
      hmrSafe: firstCode !== secondCode,
      scopesIndependent: firstCode.includes("createRoot") && secondCode.includes("createRoot"),
    };
  });
  return {
    rawSamples,
    decision: {
      adopted: false,
      reason:
        "Compact metadata is smaller in isolation, but the current structural metadata is the stable public contract for hydration and editor tooling. Retain it until a generated-module parse and Brotli gate proves a safe representation change.",
    },
  };
};

export const runRepresentationEvaluation = async (
  options: {
    iterations?: number;
    warmup?: number;
    output?: string;
    argv?: readonly string[];
  } = {},
): Promise<RepresentationEvaluation> => {
  const iterations = options.iterations ?? 3;
  const warmup = options.warmup ?? 1;
  if (!Number.isInteger(iterations) || iterations <= 0) throw new RangeError("iterations must be positive.");
  const result: RepresentationEvaluation = {
    schemaVersion: 2,
    benchmark: { name: "representation-evaluation", contractVersion: REPRESENTATION_EVALUATION_CONTRACT_VERSION },
    provenance: await collectBenchmarkProvenance({
      cwd: process.cwd(),
      argv: options.argv ?? [process.execPath, fileURLToPath(import.meta.url)],
      dependencies: await collectDependencyVersions(process.cwd(), ["typescript", "jsdom"]),
    }),
    workload: { iterations, warmup, buildMode: "source" },
    measurements: {
      rowCodegen: rowCodegenEvaluation(iterations, warmup),
      signal: signalEvaluation(iterations, warmup),
      metadata: metadataEvaluation(iterations, warmup),
    },
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
  const runId = argument("--run-id") ?? `${new Date().toISOString().replaceAll(/[^0-9]/g, "")}-${randomUUID()}`;
  const output = path.resolve(argument("--output") ?? `benchmark/representation-evaluation-results/${runId}.json`);
  const result = await runRepresentationEvaluation({
    iterations: Number(argument("--iterations") ?? 3),
    warmup: Number(argument("--warmup") ?? 1),
    output,
    argv: process.argv,
  });
  console.log(
    JSON.stringify(
      {
        output,
        benchmark: result.benchmark,
        decisions: {
          rowCodegen: result.measurements.rowCodegen.decision,
          signal: result.measurements.signal.decision,
          metadata: result.measurements.metadata.decision,
        },
      },
      null,
      2,
    ),
  );
};

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
