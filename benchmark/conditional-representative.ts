import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { JSDOM } from "jsdom";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileTemplate, generateClientModule } from "../src/compiler/index.js";
import { collectBenchmarkProvenance, collectDependencyVersions } from "./provenance.js";
import { loadCandidateModule, type GeneratedClientModule } from "./generated-template-driver.js";

export const CONDITIONAL_REPRESENTATIVE_CONTRACT_VERSION = 1;

const sources = {
  "minimal-if":
    `<main><if test={visible}><button on:click={save}>{label}</button></if><footer>Static</footer></main>`,
  "composite-if":
    `<main><if test={visible}><section><button on:click={save}>{label}</button><ul><for each={rows} key={row.id}><li>{row.label}</li></for></ul></section></if><footer>Static</footer></main>`,
} as const;

type FixtureName = keyof typeof sources;
type ConditionalModule = GeneratedClientModule & {
  createSignal: <T>(initial: T) => (() => T) & { set: (value: T) => void };
  templateHtml: string;
};

type Sample = {
  sampleIndex: number;
  durationMs: number;
  heapDeltaBytes: number;
  operationDurationsMs: Record<string, number>;
  oracle: {
    text: string;
    rowCount: number;
    clicks: number;
    detachedClicks: number;
  };
};

type Measurement = {
  samples: Sample[];
  medianDurationMs: number;
  medianHeapDeltaBytes: number;
  minDurationMs: number;
  maxDurationMs: number;
};

const installDom = (dom: JSDOM): (() => void) => {
  const names = [
    "window",
    "document",
    "Node",
    "Element",
    "HTMLElement",
    "HTMLButtonElement",
    "HTMLUListElement",
    "HTMLLIElement",
    "Comment",
    "Text",
    "NodeFilter",
    "DOMException",
    "Event",
    "MouseEvent",
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

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const generatedArtifact = async (source: string) => {
  const compileStarted = performance.now();
  const compiled = compileTemplate(source);
  if (!compiled.ok) throw new Error(compiled.error.message);
  const generated = generateClientModule(compiled.value, { reactive: true, instrumentBindings: false });
  const code =
    `import { createSignal as __tachyonCreateSignal } from "tachyon-dom/runtime/signal";\n` +
    `export { __tachyonCreateSignal as createSignal };\n` +
    generated;
  return loadCandidateModule<ConditionalModule>(code, performance.now() - compileStarted);
};

const rowsFor = (start: number, count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: start + index, label: `Row ${start + index}` }));

const runSample = (fixture: FixtureName, module: ConditionalModule, sampleIndex: number): Sample => {
  const dom = new JSDOM(`<div id="target"></div>`);
  const restore = installDom(dom);
  try {
    const container = dom.window.document.querySelector("#target");
    if (!(container instanceof dom.window.HTMLElement)) throw new Error("Missing benchmark container.");
    container.innerHTML = module.templateHtml;
    const root = container.firstElementChild;
    if (!(root instanceof dom.window.HTMLElement)) throw new Error("Missing benchmark root.");
    const visible = module.createSignal(true);
    const label = module.createSignal("A");
    const rows = module.createSignal(rowsFor(0, 40));
    let clicks = 0;
    const cleanup = module.bind(root, {
      visible,
      label,
      rows,
      save: () => clicks++,
    });
    const initialButton = root.querySelector("button");
    if (!(initialButton instanceof dom.window.HTMLButtonElement)) throw new Error("Missing benchmark button.");
    const operationDurationsMs: Record<string, number> = {};
    const operation = (name: string, run: () => void): void => {
      const started = performance.now();
      run();
      operationDurationsMs[name] = performance.now() - started;
    };
    const startedHeap = process.memoryUsage().heapUsed;
    operation("toggle", () => {
      visible.set(false);
      visible.set(true);
    });
    const button = root.querySelector("button");
    if (!(button instanceof dom.window.HTMLButtonElement)) throw new Error("Missing remounted benchmark button.");
    operation("text-update", () => label.set("A2"));
    if (fixture === "composite-if") {
      operation("list-update", () => rows.set(rows().map((row, index) => ({ ...row, label: `Updated ${index}` })).reverse()));
    }
    operation("event", () => button.click());
    const text = root.textContent ?? "";
    const rowCount = root.querySelectorAll("li").length;
    const clicksBeforeDispose = clicks;
    operation("dispose", () => cleanup?.());
    button.click();
    return {
      sampleIndex,
      durationMs: Object.values(operationDurationsMs).reduce((total, value) => total + value, 0),
      heapDeltaBytes: process.memoryUsage().heapUsed - startedHeap,
      operationDurationsMs,
      oracle: { text, rowCount, clicks, detachedClicks: clicks - clicksBeforeDispose },
    };
  } finally {
    restore();
    dom.window.close();
  }
};

const runFixture = (
  fixture: FixtureName,
  module: ConditionalModule,
  options: { iterations: number; warmup: number },
): Measurement => {
  for (let index = 0; index < options.warmup; index++) runSample(fixture, module, -index - 1);
  const samples = Array.from({ length: options.iterations }, (_, index) => runSample(fixture, module, index));
  const durations = samples.map((sample) => sample.durationMs);
  return {
    samples,
    medianDurationMs: median(durations),
    medianHeapDeltaBytes: median(samples.map((sample) => sample.heapDeltaBytes)),
    minDurationMs: Math.min(...durations),
    maxDurationMs: Math.max(...durations),
  };
};

export const runConditionalRepresentativeBenchmark = async (options: {
  iterations?: number;
  warmup?: number;
  output?: string;
  argv?: readonly string[];
} = {}) => {
  const iterations = options.iterations ?? 30;
  const warmup = options.warmup ?? 5;
  if (!Number.isInteger(iterations) || iterations <= 0) throw new RangeError("iterations must be positive.");
  if (!Number.isInteger(warmup) || warmup < 0) throw new RangeError("warmup must be non-negative.");
  const artifacts = {
    "minimal-if": await generatedArtifact(sources["minimal-if"]),
    "composite-if": await generatedArtifact(sources["composite-if"]),
  } as const;
  const measurements = {
    "minimal-if": runFixture("minimal-if", artifacts["minimal-if"].module, { iterations, warmup }),
    "composite-if": runFixture("composite-if", artifacts["composite-if"].module, { iterations, warmup }),
  } as const;
  for (const [fixture, measurement] of Object.entries(measurements)) {
    for (const sample of measurement.samples) {
      const expectedText =
        fixture === "minimal-if"
          ? "A2Static"
          : `A2${Array.from({ length: 40 }, (_, index) => `Updated ${39 - index}`).join("")}Static`;
      if (sample.oracle.text !== expectedText || sample.oracle.clicks !== 1 || sample.oracle.detachedClicks !== 0) {
        throw new Error(`Conditional benchmark oracle failed for ${fixture}: ${JSON.stringify(sample.oracle)}`);
      }
      if (fixture === "composite-if" && sample.oracle.rowCount !== 40) {
        throw new Error(`Conditional benchmark row oracle failed: ${sample.oracle.rowCount}`);
      }
    }
  }
  const provenance = await collectBenchmarkProvenance({
    cwd: process.cwd(),
    argv: options.argv ?? [process.execPath, fileURLToPath(import.meta.url)],
    dependencies: await collectDependencyVersions(process.cwd(), ["jsdom", "esbuild"]),
  });
  const result = {
    schemaVersion: 2,
    benchmark: { name: "conditional-representative", contractVersion: CONDITIONAL_REPRESENTATIVE_CONTRACT_VERSION },
    provenance,
    workload: {
      fixtures: sources,
      operations: ["toggle", "text-update", "list-update", "event", "dispose"],
      itemCount: 40,
      warmup,
      iterations,
      buildMode: "generated-client-source",
      timingScope: "warm-dom-operations-excluding-oracles",
      allocationMeasurement: "heap-delta-only",
    },
    artifacts: Object.fromEntries(
      Object.entries(artifacts).map(([fixture, artifact]) => [
        fixture,
        { timing: artifact.timing, size: artifact.size, bundledCodeSha256: hash(artifact.bundledCode) },
      ]),
    ),
    measurements,
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
  const output = path.resolve(argument("--output") ?? `benchmark/conditional-representative-results/${runId}.json`);
  const result = await runConditionalRepresentativeBenchmark({
    iterations: Number(argument("--iterations") ?? 30),
    warmup: Number(argument("--warmup") ?? 5),
    output,
    argv: process.argv,
  });
  console.log(
    JSON.stringify(
      {
        output,
        artifacts: result.artifacts,
        summary: Object.fromEntries(
          Object.entries(result.measurements).map(([fixture, measurement]) => [
            fixture,
            {
              medianDurationMs: measurement.medianDurationMs,
              medianHeapDeltaBytes: measurement.medianHeapDeltaBytes,
              minDurationMs: measurement.minDurationMs,
              maxDurationMs: measurement.maxDurationMs,
            },
          ]),
        ),
      },
      null,
      2,
    ),
  );
};

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
