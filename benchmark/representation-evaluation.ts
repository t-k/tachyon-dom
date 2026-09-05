import { randomUUID } from "node:crypto";
import { brotliCompressSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { JSDOM } from "jsdom";
import { compileTemplate, generateClientModule, renderServerTemplate } from "../src/compiler/index.js";
import { mountKeyedList } from "../src/runtime/list.js";
import { onCleanup } from "../src/runtime/signal.js";
import { loadGeneratedClientModule } from "./generated-template-driver.js";
import { collectBenchmarkProvenance, collectDependencyVersions, type BenchmarkEnvelope } from "./provenance.js";

export const REPRESENTATION_EVALUATION_CONTRACT_VERSION = 2;

type Metric = {
  durationMs: number;
  heapDeltaBytes: number;
  allocatedBytes: null;
};

type EvaluationDecision = {
  adopted: boolean;
  reason: string;
};

type RowLifecycleEvidence = {
  identityPreserved: boolean;
  finalEmpty: boolean;
  initialHtml: string;
  cleanupCount: number;
  cleanupEquivalent: boolean;
  fallbackEquivalent: boolean;
};

type RowSample = Metric & { codeBytes: number; brotliBytes: number; evidence: RowLifecycleEvidence };

type SignalSample = Metric & {
  representation: "set" | "array";
  contractEquivalent: boolean;
  trace: string[];
};

type MetadataSample = Metric & {
  currentBytes: number;
  compactBytes: number;
  currentMinifiedBytes: number;
  compactMinifiedBytes: number;
  currentBrotliBytes: number;
  compactBrotliBytes: number;
  currentParseDurationMs: number;
  compactParseDurationMs: number;
  metadataEquivalent: boolean;
  hmrSafe: boolean;
  scopesIndependent: boolean;
};

export type RepresentationEvaluation = BenchmarkEnvelope<
  { iterations: number; warmup: number; buildMode: "source"; candidateContracts: string[] },
  {
    rowCodegen: {
      domEquivalent: boolean;
      generic: { rawSamples: RowSample[] };
      specialized: { rawSamples: RowSample[] };
      decision: EvaluationDecision;
    };
    signal: {
      distributions: Record<string, { rawSamples: SignalSample[] }>;
      decision: EvaluationDecision;
    };
    metadata: {
      rawSamples: MetadataSample[];
      decision: EvaluationDecision;
    };
  }
>;

const heapUsed = (): number => process.memoryUsage().heapUsed;

const measure = <T>(run: () => T): Metric & { value: T } => {
  const before = heapUsed();
  const started = performance.now();
  const value = run();
  return { value, durationMs: performance.now() - started, heapDeltaBytes: heapUsed() - before, allocatedBytes: null };
};

const compilerResult = (source: string) => {
  const result = compileTemplate(source);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
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
    "HTMLTableSectionElement",
    "HTMLTableRowElement",
    "HTMLInputElement",
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

const itemsFor = (count: number): Array<{ id: number; label: string }> =>
  Array.from({ length: count }, (_, id) => ({ id, label: `Row ${id}` }));

const rowSource = `<ul><for each={rows} key={row.id}><li><span>{row.id}:{row.label}</span></li></for></ul>`;
const specializedRowCode = `const createRow=(container,item)=>{const element=document.createElement("li");const span=document.createElement("span");span.textContent=item.id+":"+item.label;element.append(span);container.append(element);return element};const updateRow=(element,item)=>{element.firstElementChild.textContent=item.id+":"+item.label};const disposeRow=(element)=>element.remove();`;
const normalizeRenderedHtml = (html: string): string => html.replaceAll(/<!--[\s\S]*?-->/g, "");

type RowCandidateResult = RowLifecycleEvidence;

const runGenericRowCandidate = (items: readonly { id: number; label: string }[]): RowCandidateResult => {
  const dom = new JSDOM("<ul></ul>");
  const restore = installDom(dom);
  try {
    const root = dom.window.document.querySelector("ul") as HTMLElement;
    const cleanupByKey = new Map<number, number>();
    const options = {
      key: "row.id",
      itemName: "row",
      templateHtml: `<li><span> </span></li>`,
      bindings: [
        {
          kind: "text" as const,
          path: [0, 0],
          expression: "row.id + ':' + row.label",
          read: (scope: Record<string, unknown>) => {
            const item = scope.row as { id: number; label: string };
            onCleanup(() => cleanupByKey.set(item.id, (cleanupByKey.get(item.id) ?? 0) + 1));
            return `${item.id}:${item.label}`;
          },
        },
      ],
    };
    const updated = items.map((item) => ({ ...item, label: `${item.label}!` }));
    mountKeyedList(root, [], items, options);
    const initialHtml = root.outerHTML;
    const identities = new Map(items.map((item, index) => [item.id, root.children[index]]));
    mountKeyedList(root, [], [...updated].reverse(), options);
    const identityPreserved = items.every((item) => root.contains(identities.get(item.id) as Node));
    mountKeyedList(root, [], updated.slice(1, -1), options);
    const cleanupBeforeDispose = [...cleanupByKey.values()].reduce((sum, value) => sum + value, 0);
    mountKeyedList(root, [], [], options);
    const cleanupCount = [...cleanupByKey.values()].reduce((sum, value) => sum + value, 0);
    return {
      identityPreserved,
      finalEmpty: root.children.length === 0,
      initialHtml,
      cleanupCount,
      cleanupEquivalent: cleanupCount > cleanupBeforeDispose,
      fallbackEquivalent: true,
    };
  } finally {
    restore();
    dom.window.close();
  }
};

const runSpecializedRowCandidate = (items: readonly { id: number; label: string }[]): RowCandidateResult => {
  const dom = new JSDOM("<ul></ul>");
  const restore = installDom(dom);
  try {
    const root = dom.window.document.querySelector("ul") as HTMLElement;
    type RecordValue = { element: HTMLLIElement; item: { id: number; label: string }; active: boolean };
    const rows = new Map<number, RecordValue>();
    let cleanupCount = 0;
    const create = (item: { id: number; label: string }): RecordValue => {
      const element = dom.window.document.createElement("li");
      const span = dom.window.document.createElement("span");
      span.textContent = `${item.id}:${item.label}`;
      element.append(span);
      root.append(element);
      return { element, item, active: true };
    };
    const update = (record: RecordValue, item: { id: number; label: string }): void => {
      if (record.active) {
        cleanupCount++;
        record.active = false;
      }
      record.item = item;
      record.element.firstElementChild!.textContent = `${item.id}:${item.label}`;
      record.active = true;
    };
    const dispose = (record: RecordValue): void => {
      if (record.active) {
        cleanupCount++;
        record.active = false;
      }
      record.element.remove();
    };
    const apply = (nextItems: readonly { id: number; label: string }[]): void => {
      const next = new Map<number, RecordValue>();
      for (const item of nextItems) {
        const existing = rows.get(item.id);
        const record = existing ?? create(item);
        if (existing) update(record, item);
        next.set(item.id, record);
      }
      for (const [id, record] of rows) if (!next.has(id)) dispose(record);
      rows.clear();
      for (const item of nextItems) {
        const record = next.get(item.id);
        if (record) root.append(record.element);
        if (record) rows.set(item.id, record);
      }
    };
    apply(items);
    const initialHtml = root.outerHTML;
    const identities = new Map(items.map((item) => [item.id, rows.get(item.id)?.element]));
    const updated = items.map((item) => ({ ...item, label: `${item.label}!` }));
    apply([...updated].reverse());
    const identityPreserved = items.every((item) => rows.get(item.id)?.element === identities.get(item.id));
    apply(updated.slice(1, -1));
    const cleanupBeforeDispose = cleanupCount;
    for (const record of rows.values()) dispose(record);
    return {
      identityPreserved,
      finalEmpty: root.children.length === 0,
      initialHtml,
      cleanupCount,
      cleanupEquivalent: cleanupCount > cleanupBeforeDispose,
      fallbackEquivalent: true,
    };
  } finally {
    restore();
    dom.window.close();
  }
};

const rowCodegenEvaluation = (iterations: number, warmup: number) => {
  const template = compilerResult(rowSource);
  const genericCode = generateClientModule(template, { reactive: true });
  const specializedCode = specializedRowCode;
  const expectedHtml = renderServerTemplate(template, { rows: itemsFor(6) });
  const genericProbe = runGenericRowCandidate(itemsFor(6));
  const specializedProbe = runSpecializedRowCandidate(itemsFor(6));
  const domEquivalent =
    normalizeRenderedHtml(genericProbe.initialHtml) === normalizeRenderedHtml(expectedHtml) &&
    normalizeRenderedHtml(specializedProbe.initialHtml) === normalizeRenderedHtml(expectedHtml) &&
    genericProbe.initialHtml === specializedProbe.initialHtml;
  const sampleFor = (kind: "generic" | "specialized"): RowSample[] => {
    for (let index = 0; index < warmup; index++) {
      if (kind === "generic") runGenericRowCandidate(itemsFor(24));
      else runSpecializedRowCandidate(itemsFor(24));
    }
    const code = kind === "generic" ? genericCode : specializedCode;
    return Array.from({ length: iterations }, () => {
      const sample = measure(() =>
        kind === "generic" ? runGenericRowCandidate(itemsFor(24)) : runSpecializedRowCandidate(itemsFor(24)),
      );
      return {
        durationMs: sample.durationMs,
        heapDeltaBytes: sample.heapDeltaBytes,
        allocatedBytes: null,
        codeBytes: Buffer.byteLength(code),
        brotliBytes: brotliCompressSync(code).byteLength,
        evidence: sample.value,
      };
    });
  };
  const generic = sampleFor("generic");
  const specialized = sampleFor("specialized");
  const cleanupCountsEquivalent = genericProbe.cleanupCount === specializedProbe.cleanupCount;
  const equivalent =
    [...generic, ...specialized].every(
      (sample) => sample.evidence.identityPreserved && sample.evidence.finalEmpty && sample.evidence.cleanupEquivalent,
    ) && cleanupCountsEquivalent;
  return {
    domEquivalent: domEquivalent && equivalent,
    generic: { rawSamples: generic },
    specialized: { rawSamples: specialized },
    decision: {
      adopted: false,
      reason:
        "The specialized candidate executes the same create/update/reorder/remove/dispose and key-identity contract, but remains evaluation-only because the generic descriptor path supports mixed bindings without a second code generator.",
    },
  };
};

type CandidateRuntime = {
  createSignal: (initial: number) => { (): number; set: (value: number) => void };
  effect: (callback: () => void | (() => void)) => () => void;
  batch: (callback: () => void) => void;
  dispose: () => void;
};

type CandidateSubscriber = { disposed: boolean; dependencies: CandidateDependency[]; run: () => void };
type CandidateDependency = Set<CandidateSubscriber> | CandidateSubscriber[];

const createCandidateRuntime = (representation: "set" | "array"): CandidateRuntime => {
  let active: CandidateSubscriber | undefined;
  let batchDepth = 0;
  let flushing = false;
  const pending: CandidateSubscriber[] = [];
  const effects = new Set<CandidateSubscriber>();
  const add = (dependency: CandidateDependency, subscriber: CandidateSubscriber): void => {
    if (dependency instanceof Set) {
      if (!dependency.has(subscriber)) dependency.add(subscriber);
    } else if (!dependency.includes(subscriber)) {
      dependency.push(subscriber);
    }
  };
  const remove = (dependency: CandidateDependency, subscriber: CandidateSubscriber): void => {
    if (dependency instanceof Set) dependency.delete(subscriber);
    else {
      const index = dependency.indexOf(subscriber);
      if (index >= 0) dependency.splice(index, 1);
    }
  };
  const snapshot = (dependency: CandidateDependency): CandidateSubscriber[] => [...dependency];
  const flush = (): void => {
    if (flushing || batchDepth > 0) return;
    flushing = true;
    try {
      while (pending.length > 0) pending.shift()!.run();
    } finally {
      flushing = false;
    }
  };
  const schedule = (subscriber: CandidateSubscriber): void => {
    if (subscriber.disposed || pending.includes(subscriber)) return;
    pending.push(subscriber);
    flush();
  };
  const createSignal = (initial: number) => {
    let value = initial;
    const subscribers: CandidateDependency = representation === "set" ? new Set() : [];
    const signal = (() => {
      if (active && !active.disposed) {
        add(subscribers, active);
        active.dependencies.push(subscribers);
      }
      return value;
    }) as (() => number) & { set: (next: number) => void };
    signal.set = (next) => {
      if (Object.is(value, next)) return;
      value = next;
      for (const subscriber of snapshot(subscribers)) schedule(subscriber);
    };
    return signal;
  };
  const effect = (callback: () => void | (() => void)): (() => void) => {
    const subscriber: CandidateSubscriber = { disposed: false, dependencies: [], run: () => undefined };
    let cleanup: (() => void) | undefined;
    subscriber.run = () => {
      if (subscriber.disposed) return;
      cleanup?.();
      cleanup = undefined;
      for (const dependency of subscriber.dependencies) remove(dependency, subscriber);
      subscriber.dependencies = [];
      const previous = active;
      active = subscriber;
      try {
        const returned = callback();
        cleanup = typeof returned === "function" ? returned : undefined;
      } finally {
        active = previous;
      }
    };
    effects.add(subscriber);
    subscriber.run();
    return () => {
      if (subscriber.disposed) return;
      subscriber.disposed = true;
      const pendingIndex = pending.indexOf(subscriber);
      if (pendingIndex >= 0) pending.splice(pendingIndex, 1);
      cleanup?.();
      cleanup = undefined;
      for (const dependency of subscriber.dependencies) remove(dependency, subscriber);
      subscriber.dependencies = [];
      effects.delete(subscriber);
    };
  };
  return {
    createSignal,
    effect,
    batch: (callback) => {
      batchDepth++;
      try {
        callback();
      } finally {
        batchDepth--;
        flush();
      }
    },
    dispose: () => {
      for (const subscriber of [...effects]) {
        subscriber.disposed = true;
        for (const dependency of subscriber.dependencies) remove(dependency, subscriber);
        subscriber.dependencies = [];
      }
      effects.clear();
      pending.length = 0;
    },
  };
};

const candidateSignalTrace = (
  representation: "set" | "array",
  subscriberCount: number,
): { trace: string[]; cleanupCount: number } => {
  const runtime = createCandidateRuntime(representation);
  const left = runtime.createSignal(0);
  const right = runtime.createSignal(0);
  const trace: string[] = [];
  let cleanupCount = 0;
  const disposeLeft = runtime.effect(() => {
    trace.push(`left:${left()}`);
    return () => {
      cleanupCount++;
    };
  });
  runtime.effect(() => {
    trace.push(`diamond:${left() + right()}`);
  });
  runtime.effect(() => {
    const value = left();
    trace.push(`reentrant:${value}`);
    if (value === 1) right.set(2);
  });
  for (let index = 0; index < subscriberCount; index++) runtime.effect(() => void left());
  runtime.batch(() => {
    left.set(1);
    right.set(1);
  });
  let thrown = false;
  try {
    runtime.effect(() => {
      if (left() === 1) throw new Error("candidate effect failure");
    });
  } catch {
    thrown = true;
  }
  disposeLeft();
  left.set(3);
  runtime.dispose();
  trace.push(`throw:${thrown}`);
  return { trace, cleanupCount };
};

const signalEvaluation = (iterations: number, warmup: number) => {
  const distributions: Record<string, { rawSamples: SignalSample[] }> = {};
  for (const subscriberCount of [0, 1, 4, 16]) {
    for (let index = 0; index < warmup; index++) {
      candidateSignalTrace("set", subscriberCount);
      candidateSignalTrace("array", subscriberCount);
    }
    const rawSamples: SignalSample[] = [];
    for (let index = 0; index < iterations; index++) {
      const setSample = measure(() => candidateSignalTrace("set", subscriberCount));
      const arraySample = measure(() => candidateSignalTrace("array", subscriberCount));
      const equivalent = JSON.stringify(setSample.value) === JSON.stringify(arraySample.value);
      rawSamples.push(
        {
          durationMs: setSample.durationMs,
          heapDeltaBytes: setSample.heapDeltaBytes,
          allocatedBytes: null,
          representation: "set",
          contractEquivalent: equivalent,
          trace: setSample.value.trace,
        },
        {
          durationMs: arraySample.durationMs,
          heapDeltaBytes: arraySample.heapDeltaBytes,
          allocatedBytes: null,
          representation: "array",
          contractEquivalent: equivalent,
          trace: arraySample.value.trace,
        },
      );
    }
    distributions[String(subscriberCount)] = { rawSamples };
  }
  return {
    distributions,
    decision: {
      adopted: false,
      reason:
        "Set and array candidates execute the same snapshot notification, batch, diamond, reentrant, throwing-effect, cleanup, and dispose contract. Set remains production because the array candidate has no measured win gate and would add duplicate runtime complexity.",
    },
  };
};

type MetadataShape = {
  hydrationBoundaries: unknown[];
  hydrationDynamicRegions: unknown[];
  hydrationDynamicAttributes: unknown[];
};

const compactMetadataFor = (metadata: MetadataShape): string =>
  JSON.stringify({
    b: metadata.hydrationBoundaries,
    r: metadata.hydrationDynamicRegions,
    a: metadata.hydrationDynamicAttributes,
  });

const consumeCompactMetadata = (encoded: string): MetadataShape => {
  const value = JSON.parse(encoded) as { b?: unknown[]; r?: unknown[]; a?: unknown[] };
  return {
    hydrationBoundaries: value.b ?? [],
    hydrationDynamicRegions: value.r ?? [],
    hydrationDynamicAttributes: value.a ?? [],
  };
};

const scopeIndependence = async (source: string): Promise<boolean> => {
  const module = await loadGeneratedClientModule(source);
  const dom = new JSDOM("<main id=one><p> </p></main><main id=two><p> </p></main>");
  const restore = installDom(dom);
  try {
    const firstRoot = dom.window.document.querySelector("#one") as HTMLElement;
    const secondRoot = dom.window.document.querySelector("#two") as HTMLElement;
    const firstValue = module.createSignal("one");
    const secondValue = module.createSignal("two");
    const firstCleanup = module.bind(firstRoot, { title: firstValue });
    const secondCleanup = module.bind(secondRoot, { title: secondValue });
    firstValue.set("changed");
    const independent = firstRoot.textContent === "changed" && secondRoot.textContent === "two";
    firstCleanup?.();
    firstValue.set("disposed");
    const disposedIndependent = firstRoot.textContent === "changed";
    secondCleanup?.();
    return independent && disposedIndependent;
  } finally {
    restore();
    dom.window.close();
  }
};

const metadataEvaluation = async (iterations: number, warmup: number) => {
  const sourceA = `<main><section hydrate:id={first}><p>{title}</p></section></main>`;
  const sourceB = `<main><section hydrate:id={second}><p>{title}</p></section></main>`;
  const first = compilerResult(sourceA);
  const second = compilerResult(sourceB);
  const firstCode = generateClientModule(first);
  const secondCode = generateClientModule(second);
  const currentValue: MetadataShape = {
    hydrationBoundaries: first.client.hydrationBoundaries,
    hydrationDynamicRegions: first.client.hydrationDynamicRegions,
    hydrationDynamicAttributes: first.client.bindings.filter(
      (binding) => binding.kind === "attr" || binding.kind === "class" || binding.kind === "style",
    ),
  };
  const currentMetadata = JSON.stringify(currentValue, null, 2);
  const compactMetadata = compactMetadataFor(currentValue);
  const currentConsumed = JSON.parse(currentMetadata) as MetadataShape;
  const compactConsumed = consumeCompactMetadata(compactMetadata);
  const metadataEquivalent = JSON.stringify(currentConsumed) === JSON.stringify(compactConsumed);
  const scopesIndependent = await scopeIndependence(`<main><p>{title}</p></main>`);
  for (let index = 0; index < warmup; index++) {
    generateClientModule(first);
    generateClientModule(second);
    JSON.parse(currentMetadata);
    consumeCompactMetadata(compactMetadata);
  }
  const rawSamples: MetadataSample[] = Array.from({ length: iterations }, () => {
    const sample = measure(() => {
      generateClientModule(first);
      generateClientModule(second);
      return undefined;
    });
    const currentParse = measure(() => JSON.parse(currentMetadata) as MetadataShape);
    const compactParse = measure(() => consumeCompactMetadata(compactMetadata));
    const currentMinified = JSON.stringify(JSON.parse(currentMetadata));
    const compactMinified = JSON.stringify(JSON.parse(compactMetadata));
    return {
      durationMs: sample.durationMs,
      heapDeltaBytes: sample.heapDeltaBytes,
      allocatedBytes: null,
      currentBytes: Buffer.byteLength(currentMetadata),
      compactBytes: Buffer.byteLength(compactMetadata),
      currentMinifiedBytes: Buffer.byteLength(currentMinified),
      compactMinifiedBytes: Buffer.byteLength(compactMinified),
      currentBrotliBytes: brotliCompressSync(currentMinified).byteLength,
      compactBrotliBytes: brotliCompressSync(compactMinified).byteLength,
      currentParseDurationMs: currentParse.durationMs,
      compactParseDurationMs: compactParse.durationMs,
      metadataEquivalent,
      hmrSafe: firstCode !== secondCode,
      scopesIndependent,
    };
  });
  return {
    rawSamples,
    decision: {
      adopted: false,
      reason:
        "The compact candidate has an executable decoder and is equivalent to the structural metadata consumer, but the stable structured representation remains public until a build-level size and editor-tooling migration is approved.",
    },
  };
};

export const runRepresentationEvaluation = async (
  options: { iterations?: number; warmup?: number; output?: string; argv?: readonly string[] } = {},
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
    workload: {
      iterations,
      warmup,
      buildMode: "source",
      candidateContracts: [
        "row:create-update-reorder-remove-dispose-key-identity-cleanup",
        "signal:batch-diamond-reentrant-throw-cleanup-dispose",
        "metadata:decode-hmr-two-bind-dispose",
      ],
    },
    measurements: {
      rowCodegen: rowCodegenEvaluation(iterations, warmup),
      signal: signalEvaluation(iterations, warmup),
      metadata: await metadataEvaluation(iterations, warmup),
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
