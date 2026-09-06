import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { JSDOM } from "jsdom";
import { compileTemplate, renderServerTemplate } from "../src/compiler/index.js";
import { hydrate as hydrateClientModule, type ClientTemplateModule } from "../src/runtime/mount.js";
import {
  batch as productionBatch,
  createMemo as productionCreateMemo,
  createRoot,
  createSignal as productionCreateSignal,
  effect as productionEffect,
} from "../src/runtime/signal.js";
import {
  generatedClientArtifact,
  loadCandidateModule,
  type ArtifactSize,
  type GeneratedClientModule,
} from "./generated-template-driver.js";
import { collectBenchmarkProvenance, collectDependencyVersions, type BenchmarkEnvelope } from "./provenance.js";

/**
 * Contract version 3 evaluates every candidate as the artifact that is
 * actually executed: row candidates are bundled, imported, sized, and driven
 * through the same stage sequence; signal candidates are compared against the
 * production runtime's trace; metadata candidates are decoded by the real
 * hydrate consumer. Adoption of a production representation is out of scope.
 */
export const REPRESENTATION_EVALUATION_CONTRACT_VERSION = 3;

type Metric = {
  durationMs: number;
  heapDeltaBytes: number;
  allocatedBytes: null;
};

type EvaluationDecision = {
  adopted: boolean;
  reason: string;
};

/** Observed state after one lifecycle stage; compared verbatim between candidates. */
type RowStageRecord = {
  stage: "create" | "update" | "reorder" | "remove" | "dispose";
  values: string[];
  order: number[];
  identityPreserved: number;
  removedNodes: number;
};

type RowFallbackEvidence = {
  /** The candidate declared it cannot handle the mixed template. */
  candidateDeclined: boolean;
  /** The generic generated module handled the mixed template's class, event, and form behaviour. */
  classToggled: boolean;
  clickHandled: boolean;
  modelWrittenBack: boolean;
};

type RowSample = Metric & {
  candidate: "generic" | "specialized";
  artifactHash: string;
  size: ArtifactSize;
  stages: RowStageRecord[];
  stagesEquivalent: boolean;
};

type SignalRepresentation = "production" | "set" | "array";

type SignalSample = Metric & {
  representation: SignalRepresentation;
  /** Trace equals the production runtime's trace for the same scenario. */
  contractEquivalent: boolean;
  /** Only candidates that match the production contract may be compared on time. */
  eligible: boolean;
  trace: string[];
};

type MetadataSample = Metric & {
  currentArtifactHash: string;
  compactArtifactHash: string;
  currentSize: ArtifactSize;
  compactSize: ArtifactSize;
  currentParseDurationMs: number;
  compactParseDurationMs: number;
  consumerEquivalent: boolean;
  /** Hydrate failures observed while validating, if any (empty when equivalent). */
  consumerErrors: string[];
  /** Text observed on the current-artifact and compact-artifact instances. */
  consumerTexts: string[];
  twoInstancesIndependent: boolean;
  storeShadowingIndependent: boolean;
  hmrSafe: boolean;
};

export type RepresentationEvaluation = BenchmarkEnvelope<
  { iterations: number; warmup: number; buildMode: "bundled-artifact"; candidateContracts: string[] },
  {
    rowCodegen: {
      stagesEquivalent: boolean;
      fallback: RowFallbackEvidence;
      generic: { artifactHash: string; size: ArtifactSize; rawSamples: RowSample[] };
      specialized: { artifactHash: string; size: ArtifactSize; rawSamples: RowSample[] };
      decision: EvaluationDecision;
    };
    signal: {
      productionTrace: string[];
      distributions: Record<string, { rawSamples: SignalSample[] }>;
      ineligible: SignalRepresentation[];
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
  const startedHeap = heapUsed();
  const started = performance.now();
  const value = run();
  return { value, durationMs: performance.now() - started, heapDeltaBytes: heapUsed() - startedHeap, allocatedBytes: null };
};

const hashOf = async (value: string): Promise<string> => {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(value).digest("hex");
};

const compilerResult = (source: string) => {
  const compiled = compileTemplate(source);
  if (!compiled.ok) throw new Error(compiled.error.message);
  return compiled.value;
};

const installDom = (dom: JSDOM): (() => void) => {
  const names = [
    "window",
    "document",
    "Document",
    "Node",
    "Element",
    "HTMLElement",
    "HTMLTemplateElement",
    "HTMLInputElement",
    "HTMLSelectElement",
    "HTMLTextAreaElement",
    "Comment",
    "Text",
    "NodeFilter",
    "DOMException",
    "Event",
    "MouseEvent",
    "KeyboardEvent",
    "MutationObserver",
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

// ---------------------------------------------------------------------------
// 017: specialised row codegen candidate versus the generic generated module.
// ---------------------------------------------------------------------------

type RowItem = { id: number; label: string };

const itemsFor = (count: number): RowItem[] => Array.from({ length: count }, (_, id) => ({ id, label: `Row ${id}` }));

const rowSource = `<ul><for each={rows} key={row.id}><li><span>{row.id}:{row.label}</span></li></for></ul>`;
const mixedRowSource = `<ul><for each={rows} key={row.id}><li class:on={row.on} on:click={row.onClick}><input bind:value={row.label}><span>{row.id}:{row.label}</span></li></for></ul>`;

/**
 * The specialised candidate is a complete ESM artifact: a per-template row
 * reconciler with keyed identity, update, reorder, remove, and dispose, that
 * subscribes to `scope.rows` through the production signal runtime. It only
 * supports text rows and declares that through `supports`.
 */
const specializedRowArtifact = `import { createSignal as __benchmarkCreateSignal, effect, read } from "tachyon-dom/runtime/signal";
export { __benchmarkCreateSignal as createSignal };
export const supports = (bindingKinds) => bindingKinds.every((kind) => kind === "text");
export const templateHtml = "<ul></ul>";
export const bind = (root, scope) => {
  const container = root;
  const rows = new Map();
  const createRow = (item) => {
    const element = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = item.id + ":" + item.label;
    element.append(span);
    return { element, item };
  };
  const updateRow = (record, item) => {
    record.item = item;
    record.element.firstElementChild.textContent = item.id + ":" + item.label;
  };
  const disposeRow = (record) => record.element.remove();
  const reconcile = (items) => {
    const next = new Map();
    for (const item of items) {
      const existing = rows.get(item.id);
      const record = existing ?? createRow(item);
      if (existing) updateRow(record, item);
      next.set(item.id, record);
    }
    for (const [id, record] of rows) if (!next.has(id)) disposeRow(record);
    let cursor = container.firstChild;
    for (const record of next.values()) {
      if (cursor === record.element) {
        cursor = cursor.nextSibling;
      } else {
        container.insertBefore(record.element, cursor);
      }
    }
    rows.clear();
    for (const [id, record] of next) rows.set(id, record);
  };
  const stop = effect(() => reconcile(read(scope.rows)));
  return () => {
    stop();
    for (const record of rows.values()) disposeRow(record);
    rows.clear();
  };
};
`;

type RowCandidateModule = GeneratedClientModule & { supports?: (bindingKinds: string[]) => boolean };

const runRowStages = (
  module: RowCandidateModule,
  items: readonly RowItem[],
): { stages: RowStageRecord[]; removedNodes: number } => {
  const dom = new JSDOM("<ul></ul>");
  const restore = installDom(dom);
  try {
    const root = dom.window.document.querySelector("ul") as HTMLElement;
    let removedNodes = 0;
    const observer = new dom.window.MutationObserver((records) => {
      for (const record of records) removedNodes += record.removedNodes.length;
    });
    observer.observe(root, { childList: true });
    const rows = module.createSignal<readonly RowItem[]>([]);
    const cleanup = module.bind(root, { rows });
    const identities = new Map<number, Element>();
    const snapshot = (stage: RowStageRecord["stage"], current: readonly RowItem[]): RowStageRecord => {
      observer.takeRecords().forEach((record) => (removedNodes += record.removedNodes.length));
      const elements = Array.from(root.children);
      let identityPreserved = 0;
      current.forEach((item, index) => {
        const element = elements[index];
        if (!element) return;
        if (identities.get(item.id) === element) identityPreserved++;
        identities.set(item.id, element);
      });
      for (const id of Array.from(identities.keys())) {
        if (!current.some((item) => item.id === id)) identities.delete(id);
      }
      return {
        stage,
        values: elements.map((element) => element.textContent ?? ""),
        order: current.map((item) => item.id),
        identityPreserved,
        removedNodes,
      };
    };
    const stages: RowStageRecord[] = [];
    rows.set(items);
    stages.push(snapshot("create", items));
    const updated = items.map((item) => ({ ...item, label: `${item.label}!` }));
    rows.set(updated);
    stages.push(snapshot("update", updated));
    const reordered = [...updated].reverse();
    rows.set(reordered);
    stages.push(snapshot("reorder", reordered));
    const removed = reordered.slice(1, -1);
    rows.set(removed);
    stages.push(snapshot("remove", removed));
    cleanup?.();
    stages.push(snapshot("dispose", []));
    observer.disconnect();
    return { stages, removedNodes };
  } finally {
    restore();
    dom.window.close();
  }
};

const fallbackEvidence = (
  candidate: RowCandidateModule,
  genericMixed: GeneratedClientModule,
  mixedBindingKinds: string[],
): RowFallbackEvidence => {
  const candidateDeclined = candidate.supports ? !candidate.supports(mixedBindingKinds) : false;
  const dom = new JSDOM("<ul></ul>");
  const restore = installDom(dom);
  try {
    const root = dom.window.document.querySelector("ul") as HTMLElement;
    let clicks = 0;
    const item = { id: 1, label: "one", on: true, onClick: () => clicks++ };
    const rows = genericMixed.createSignal<readonly (typeof item)[]>([item]);
    const cleanup = genericMixed.bind(root, { rows });
    const li = root.querySelector("li");
    const input = root.querySelector("input");
    if (!li || !(input instanceof dom.window.HTMLInputElement)) throw new Error("Mixed fallback did not render.");
    const classToggled = li.classList.contains("on");
    li.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    input.value = "typed";
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    const modelWrittenBack = item.label === "typed";
    cleanup?.();
    return { candidateDeclined, classToggled, clickHandled: clicks === 1, modelWrittenBack };
  } finally {
    restore();
    dom.window.close();
  }
};

const rowCodegenEvaluation = async (iterations: number, warmup: number) => {
  const genericArtifact = generatedClientArtifact(rowSource);
  const generic = await loadCandidateModule<RowCandidateModule>(genericArtifact.code, genericArtifact.compileMs);
  const specialized = await loadCandidateModule<RowCandidateModule>(specializedRowArtifact);
  const mixedArtifact = generatedClientArtifact(mixedRowSource);
  const genericMixed = await loadCandidateModule<GeneratedClientModule>(mixedArtifact.code, mixedArtifact.compileMs);
  const mixedTemplate = compilerResult(mixedRowSource);
  const mixedBindingKinds = (mixedTemplate.client.bindings[0]?.kind === "list"
    ? mixedTemplate.client.bindings[0].bindings
    : []
  ).map((binding) => binding.kind);
  const fallback = fallbackEvidence(specialized.module, genericMixed.module, mixedBindingKinds);
  const expectedHtml = renderServerTemplate(compilerResult(rowSource), { rows: itemsFor(4) }).replaceAll(
    /<!--[\s\S]*?-->/g,
    "",
  );
  const probe = runRowStages(generic.module, itemsFor(4));
  const genericHash = await hashOf(generic.bundledCode);
  const specializedHash = await hashOf(specialized.bundledCode);
  const sampleFor = (candidate: "generic" | "specialized", loaded: typeof generic, artifactHash: string): RowSample[] => {
    for (let index = 0; index < warmup; index++) runRowStages(loaded.module, itemsFor(24));
    return Array.from({ length: iterations }, () => {
      const sample = measure(() => runRowStages(loaded.module, itemsFor(24)));
      return {
        durationMs: sample.durationMs,
        heapDeltaBytes: sample.heapDeltaBytes,
        allocatedBytes: null,
        candidate,
        artifactHash,
        size: loaded.size,
        stages: sample.value.stages,
        stagesEquivalent: false,
      };
    });
  };
  const genericSamples = sampleFor("generic", generic, genericHash);
  const specializedSamples = sampleFor("specialized", specialized, specializedHash);
  const reference = JSON.stringify(genericSamples[0]?.stages);
  for (const sample of [...genericSamples, ...specializedSamples]) {
    sample.stagesEquivalent = JSON.stringify(sample.stages) === reference;
  }
  const stagesEquivalent =
    [...genericSamples, ...specializedSamples].every((sample) => sample.stagesEquivalent) &&
    probe.stages[0]?.values.join("") === expectedHtml.replaceAll(/<[^>]+>/g, "");
  return {
    stagesEquivalent,
    fallback,
    generic: { artifactHash: genericHash, size: generic.size, rawSamples: genericSamples },
    specialized: { artifactHash: specializedHash, size: specialized.size, rawSamples: specializedSamples },
    decision: {
      adopted: false,
      reason: stagesEquivalent
        ? "The specialised artifact matches the generic module on every stage (values, order, identity, removed nodes) and its size and time were measured on the executed bundle. It stays evaluation-only: it supports text rows only and mixed templates fall back to the generic module, so a second generator would add surface without a build-level win."
        : "The specialised artifact failed the stage equivalence validator and is not eligible for adoption.",
    },
  };
};

// ---------------------------------------------------------------------------
// 018: subscriber representation candidates against the production runtime.
// ---------------------------------------------------------------------------

type SignalAdapter = {
  createSignal: (initial: number) => { (): number; set: (value: number) => void };
  createMemo: (compute: () => number) => () => number;
  effect: (callback: () => void | (() => void)) => () => void;
  batch: (callback: () => void) => void;
  run: <T>(scenario: () => T) => { value: T; dispose: () => void };
};

type CandidateSubscriber = {
  disposed: boolean;
  computed: boolean;
  dependencies: CandidateDependency[];
  run: () => void;
};
type CandidateDependency = Set<CandidateSubscriber> | CandidateSubscriber[];

/** A small runtime implementing the production contract with either representation. */
const createCandidateAdapter = (representation: "set" | "array"): SignalAdapter => {
  let active: CandidateSubscriber | undefined;
  let batchDepth = 0;
  let flushing = false;
  const pendingComputed = new Set<CandidateSubscriber>();
  const pendingEffects = new Set<CandidateSubscriber>();
  const effects = new Set<CandidateSubscriber>();
  const add = (dependency: CandidateDependency, subscriber: CandidateSubscriber): void => {
    if (dependency instanceof Set) dependency.add(subscriber);
    else if (!dependency.includes(subscriber)) dependency.push(subscriber);
  };
  const remove = (dependency: CandidateDependency, subscriber: CandidateSubscriber): void => {
    if (dependency instanceof Set) dependency.delete(subscriber);
    else {
      const index = dependency.indexOf(subscriber);
      if (index >= 0) dependency.splice(index, 1);
    }
  };
  const flush = (): void => {
    if (flushing || batchDepth > 0 || active) return;
    flushing = true;
    const unhandled: unknown[] = [];
    try {
      while (pendingComputed.size > 0 || pendingEffects.size > 0) {
        const subscriber = pendingComputed.values().next().value ?? pendingEffects.values().next().value;
        if (!subscriber) break;
        (subscriber.computed ? pendingComputed : pendingEffects).delete(subscriber);
        try {
          subscriber.run();
        } catch (error) {
          // Siblings keep running; the first error is thrown after the flush.
          unhandled.push(error);
        }
      }
    } finally {
      flushing = false;
    }
    if (unhandled.length === 1) throw unhandled[0];
    if (unhandled.length > 1) throw new AggregateError(unhandled, "Reactive effects failed.");
  };
  const notify = (subscribers: CandidateDependency): void => {
    for (const subscriber of Array.from(subscribers)) {
      if (subscriber.disposed) continue;
      (subscriber.computed ? pendingComputed : pendingEffects).add(subscriber);
    }
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
      notify(subscribers);
    };
    return signal;
  };
  const disposers: Array<() => void> = [];
  const createEffect = (callback: () => void | (() => void), computed: boolean): (() => void) => {
    const subscriber: CandidateSubscriber = { disposed: false, computed, dependencies: [], run: () => undefined };
    let cleanup: (() => void) | undefined;
    subscriber.run = () => {
      if (subscriber.disposed) return;
      let cleanupError: unknown;
      let cleanupFailed = false;
      try {
        cleanup?.();
      } catch (error) {
        cleanupError = error;
        cleanupFailed = true;
      }
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
        if (!previous) flush();
      }
      if (cleanupFailed) throw cleanupError;
    };
    effects.add(subscriber);
    try {
      subscriber.run();
    } catch (error) {
      subscriber.disposed = true;
      effects.delete(subscriber);
      throw error;
    }
    const dispose = (): void => {
      if (subscriber.disposed) return;
      subscriber.disposed = true;
      pendingComputed.delete(subscriber);
      pendingEffects.delete(subscriber);
      const currentCleanup = cleanup;
      cleanup = undefined;
      for (const dependency of subscriber.dependencies) remove(dependency, subscriber);
      subscriber.dependencies = [];
      effects.delete(subscriber);
      currentCleanup?.();
    };
    disposers.push(dispose);
    return dispose;
  };
  return {
    createSignal,
    createMemo: (compute) => {
      const value = createSignal(Number.NaN);
      createEffect(() => value.set(compute()), true);
      return () => value();
    },
    effect: (callback) => createEffect(callback, false),
    batch: (callback) => {
      batchDepth++;
      try {
        callback();
      } finally {
        batchDepth--;
        flush();
      }
    },
    run: (scenario) => ({
      value: scenario(),
      // Like the production root, dispose runs every effect cleanup in reverse
      // registration order and rethrows the first cleanup failure.
      dispose: () => {
        let firstError: unknown;
        let failed = false;
        for (const dispose of [...disposers].reverse()) {
          try {
            dispose();
          } catch (error) {
            if (!failed) firstError = error;
            failed = true;
          }
        }
        disposers.length = 0;
        effects.clear();
        pendingComputed.clear();
        pendingEffects.clear();
        if (failed) throw firstError;
      },
    }),
  };
};

const productionAdapter: SignalAdapter = {
  createSignal: (initial) => productionCreateSignal(initial),
  createMemo: (compute) => productionCreateMemo(compute),
  effect: (callback) => productionEffect(callback),
  batch: (callback) => productionBatch(callback),
  run: (scenario) => {
    let dispose = (): void => undefined;
    const value = createRoot((disposeRoot) => {
      dispose = disposeRoot;
      return scenario();
    });
    return { value, dispose };
  },
};

/**
 * The shared contract scenario: batch, diamond, computed priority, re-entrant
 * writes, dependency unsubscribe/resubscribe, an effect throwing during
 * notification with siblings continuing, a throwing cleanup, and dispose.
 */
const signalContractTrace = (adapter: SignalAdapter, subscriberCount: number): string[] => {
  const trace: string[] = [];
  const { dispose } = adapter.run(() => {
    const a = adapter.createSignal(1);
    const b = adapter.createSignal(10);
    const sum = adapter.createMemo(() => a() + b());
    const double = adapter.createMemo(() => sum() * 2);
    adapter.effect(() => {
      trace.push(`computed:${sum()}:${double()}`);
    });
    adapter.effect(() => {
      trace.push(`diamond:${a()}:${sum()}`);
    });
    adapter.effect(() => {
      const value = a();
      trace.push(`reentrant:${value}`);
      if (value === 2) b.set(20);
    });
    const toggle = adapter.createSignal(1);
    const c = adapter.createSignal(0);
    adapter.effect(() => {
      trace.push(`cond:${toggle() ? a() : c()}`);
    });
    for (let index = 0; index < subscriberCount; index++) adapter.effect(() => void a());
    adapter.batch(() => {
      a.set(2);
      b.set(11);
    });
    trace.push("after-batch");
    toggle.set(0);
    c.set(5);
    a.set(3);
    adapter.effect(() => {
      if (a() === 4) throw new Error("effect failure");
    });
    adapter.effect(() => {
      trace.push(`sibling:${a()}`);
    });
    try {
      a.set(4);
    } catch (error) {
      trace.push(`caught:${error instanceof Error ? error.message : String(error)}`);
    }
    adapter.effect(() => {
      a();
      return () => {
        throw new Error("cleanup failure");
      };
    });
    try {
      a.set(5);
    } catch (error) {
      trace.push(`cleanup-caught:${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
  });
  try {
    dispose();
  } catch (error) {
    trace.push(`dispose-caught:${error instanceof Error ? error.message : String(error)}`);
  }
  return trace;
};

const signalEvaluation = (iterations: number, warmup: number) => {
  const productionTrace = signalContractTrace(productionAdapter, 4);
  const distributions: Record<string, { rawSamples: SignalSample[] }> = {};
  const ineligible = new Set<SignalRepresentation>();
  const adapters: Array<[SignalRepresentation, () => SignalAdapter]> = [
    ["production", () => productionAdapter],
    ["set", () => createCandidateAdapter("set")],
    ["array", () => createCandidateAdapter("array")],
  ];
  for (const subscriberCount of [0, 1, 4, 16]) {
    const expected = JSON.stringify(signalContractTrace(productionAdapter, subscriberCount));
    for (let index = 0; index < warmup; index++) {
      for (const [, create] of adapters) signalContractTrace(create(), subscriberCount);
    }
    const rawSamples: SignalSample[] = [];
    for (let index = 0; index < iterations; index++) {
      for (const [representation, create] of adapters) {
        const adapter = create();
        const sample = measure(() => signalContractTrace(adapter, subscriberCount));
        const contractEquivalent = JSON.stringify(sample.value) === expected;
        if (!contractEquivalent) ineligible.add(representation);
        rawSamples.push({
          durationMs: sample.durationMs,
          heapDeltaBytes: sample.heapDeltaBytes,
          allocatedBytes: null,
          representation,
          contractEquivalent,
          eligible: contractEquivalent,
          trace: sample.value,
        });
      }
    }
    distributions[String(subscriberCount)] = { rawSamples };
  }
  const ineligibleList = [...ineligible];
  return {
    productionTrace,
    distributions,
    ineligible: ineligibleList,
    decision: {
      adopted: false,
      reason:
        ineligibleList.length === 0
          ? "Set and array candidates reproduce the production trace (batch, diamond, computed priority, re-entrant writes, dependency resubscription, sibling continuation after a throwing effect, throwing cleanup, dispose) at every subscriber distribution. Set stays production because the array candidate has no measured win gate."
          : `Candidates ${ineligibleList.join(", ")} did not reproduce the production trace and are recorded as ineligible; their timings are not compared.`,
    },
  };
};

// ---------------------------------------------------------------------------
// 020: compact metadata consumed by the real hydrate consumer.
// ---------------------------------------------------------------------------

const metadataSource = `<main><h1>{title}</h1><section hydrate:id={panel}><store note={"local"}/><p class:on={active}>{title}:{note}</p></section></main>`;
const revisedMetadataSource = `<main><h1>{title}</h1><section hydrate:id={panel}><store note={"local"}/><p class:on={active} data-revision="2">{title}:{note}!</p></section></main>`;

const metadataExports = ["hydrationBoundaries", "hydrationDynamicAttributes", "hydrationDynamicRegions"] as const;

/** Rewrites the generated module so its metadata exports are decoded from a compact encoding at load time. */
const compactMetadataArtifact = (code: string): string => {
  const values: Record<string, unknown> = {};
  let rewritten = code;
  for (const name of metadataExports) {
    const match = new RegExp(`^export const ${name} = (.*);$`, "m").exec(rewritten);
    if (!match) throw new Error(`Generated module has no ${name} export.`);
    values[name] = JSON.parse(match[1] as string);
    rewritten = rewritten.replace(match[0], `export const ${name} = __tachyonCompact.${name.slice(9, 10).toLowerCase()}${name.slice(10)};`);
  }
  const compact = JSON.stringify({
    boundaries: values.hydrationBoundaries,
    dynamicAttributes: values.hydrationDynamicAttributes,
    dynamicRegions: values.hydrationDynamicRegions,
  });
  const decoder = `const __tachyonCompact = (() => { const value = JSON.parse(${JSON.stringify(compact)}); return { boundaries: value.boundaries ?? [], dynamicAttributes: value.dynamicAttributes ?? [], dynamicRegions: value.dynamicRegions ?? [] }; })();\n`;
  return rewritten
    .replace("export const hydrationBoundaries = __tachyonCompact.boundaries;", "export const hydrationBoundaries = __tachyonCompact.boundaries;")
    .replace("export const hydrationDynamicAttributes = __tachyonCompact.dynamicAttributes;", "export const hydrationDynamicAttributes = __tachyonCompact.dynamicAttributes;")
    .replace("export const hydrationDynamicRegions = __tachyonCompact.dynamicRegions;", "export const hydrationDynamicRegions = __tachyonCompact.dynamicRegions;")
    .replace(/^(import .*\n)+/m, (imports) => `${imports}${decoder}`);
};

type HydratableModule = ClientTemplateModule<Record<string, unknown>> & GeneratedClientModule;

const ssrFor = (source: string, scope: Record<string, unknown>): string =>
  renderServerTemplate(compilerResult(source), scope);

const hydrateConsumer = (
  module: HydratableModule,
  markup: string,
  scope: Record<string, unknown>,
): { ok: boolean; message?: string; text: string; dispose: () => void; root: HTMLElement } => {
  const root = document.createElement("div");
  root.innerHTML = markup;
  document.body.append(root);
  const result = hydrateClientModule(root, module, scope);
  if (!result.ok) return { ok: false, message: result.error.message, text: root.textContent ?? "", dispose: () => root.remove(), root };
  return {
    ok: true,
    text: root.textContent ?? "",
    dispose: () => {
      result.value.dispose();
      root.remove();
    },
    root,
  };
};

const metadataEvaluation = async (iterations: number, warmup: number) => {
  const currentArtifact = generatedClientArtifact(metadataSource);
  const compactCode = compactMetadataArtifact(currentArtifact.code);
  const current = await loadCandidateModule<HydratableModule>(currentArtifact.code, currentArtifact.compileMs);
  const compact = await loadCandidateModule<HydratableModule>(compactCode);
  const revisedArtifact = generatedClientArtifact(revisedMetadataSource);
  const revised = await loadCandidateModule<HydratableModule>(compactMetadataArtifact(revisedArtifact.code));
  const dom = new JSDOM("<body></body>");
  const restore = installDom(dom);
  let consumerEquivalent = false;
  const consumerErrors: string[] = [];
  const consumerTexts: string[] = [];
  let twoInstancesIndependent = false;
  let storeShadowingIndependent = false;
  let hmrSafe = false;
  try {
    // Each bundled artifact carries its own runtime copy, so signals are
    // created through the module that consumes them.
    const scopeCurrentA = { title: current.module.createSignal("A"), active: true, panel: "p-a", note: "shadowed" };
    const scopeA = { title: compact.module.createSignal("A"), active: true, panel: "p-a", note: "shadowed" };
    const scopeB = { title: compact.module.createSignal("B"), active: false, panel: "p-b", note: "shadowed" };
    const markupA = ssrFor(metadataSource, { title: "A", active: true, panel: "p-a", note: "local" });
    const markupB = ssrFor(metadataSource, { title: "B", active: false, panel: "p-b", note: "local" });
    const currentA = hydrateConsumer(current.module, markupA, scopeCurrentA);
    const compactA = hydrateConsumer(compact.module, markupA, scopeA);
    const compactB = hydrateConsumer(compact.module, markupB, scopeB);
    for (const attempt of [currentA, compactA, compactB]) if (!attempt.ok && attempt.message) consumerErrors.push(attempt.message);
    consumerTexts.push(currentA.text, compactA.text, compactB.text);
    consumerEquivalent = currentA.ok && compactA.ok && compactB.ok && currentA.text === compactA.text;
    scopeA.title.set("A2");
    twoInstancesIndependent = compactA.text !== compactB.text && compactA.root.textContent?.includes("A2") === true &&
      compactB.root.textContent?.includes("B") === true && !compactB.root.textContent.includes("A2");
    // The boundary-local store wins over the shadowed scope property.
    storeShadowingIndependent = compactA.root.textContent?.includes(":local") === true && scopeA.note === "shadowed";
    // HMR: the revised artifact is a different module whose metadata and
    // behaviour reflect the edit, the stale module rejects the new markup, and
    // the old instance keeps working.
    const revisedMarkup = ssrFor(revisedMetadataSource, { title: "C", active: true, panel: "p-c", note: "local" });
    const staleAttempt = hydrateConsumer(compact.module, revisedMarkup, {
      title: compact.module.createSignal("C"),
      active: true,
      panel: "p-c",
      note: "x",
    });
    const revisedInstance = hydrateConsumer(revised.module, revisedMarkup, {
      title: revised.module.createSignal("C"),
      active: true,
      panel: "p-c",
      note: "x",
    });
    hmrSafe =
      !staleAttempt.ok &&
      revisedInstance.ok &&
      revisedInstance.root.textContent?.includes("C:local!") === true &&
      compactA.root.textContent?.includes("A2:local") === true &&
      current.bundledCode !== revised.bundledCode;
    staleAttempt.dispose();
    revisedInstance.dispose();
    currentA.dispose();
    compactA.dispose();
    compactB.dispose();
  } finally {
    restore();
    dom.window.close();
  }
  const currentHash = await hashOf(current.bundledCode);
  const compactHash = await hashOf(compact.bundledCode);
  const parseWith = (code: string): number => {
    const dom2 = new JSDOM("<body></body>");
    const restore2 = installDom(dom2);
    try {
      const started = performance.now();
      new Function("document", code.replaceAll(/^export \{[^}]*\};?$/gm, "").replaceAll(/^export /gm, ""));
      return performance.now() - started;
    } finally {
      restore2();
      dom2.window.close();
    }
  };
  for (let index = 0; index < warmup; index++) {
    parseWith(current.bundledCode);
    parseWith(compact.bundledCode);
  }
  const rawSamples: MetadataSample[] = Array.from({ length: iterations }, () => {
    const sample = measure(() => undefined);
    return {
      durationMs: sample.durationMs,
      heapDeltaBytes: sample.heapDeltaBytes,
      allocatedBytes: null,
      currentArtifactHash: currentHash,
      compactArtifactHash: compactHash,
      currentSize: current.size,
      compactSize: compact.size,
      currentParseDurationMs: parseWith(current.bundledCode),
      compactParseDurationMs: parseWith(compact.bundledCode),
      consumerEquivalent,
      consumerErrors,
      consumerTexts,
      twoInstancesIndependent,
      storeShadowingIndependent,
      hmrSafe,
    };
  });
  const validated = consumerEquivalent && twoInstancesIndependent && storeShadowingIndependent && hmrSafe;
  return {
    rawSamples,
    decision: {
      adopted: false,
      reason: validated
        ? "The compact artifact is decoded at load time and consumed by the real hydrate structure check with two independent instances, store shadowing, and an HMR revision that rejects stale markup. The structured representation stays public until a build-level size and editor-tooling migration is approved."
        : "The compact artifact failed the consumer validator (hydrate, two instances, store shadowing, or HMR) and is not eligible for adoption.",
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
      dependencies: await collectDependencyVersions(process.cwd(), ["typescript", "jsdom", "esbuild"]),
    }),
    workload: {
      iterations,
      warmup,
      buildMode: "bundled-artifact",
      candidateContracts: [
        "row:same-artifact-executed-and-sized:create-update-reorder-remove-dispose-identity-removed-nodes:fallback-generic-mixed",
        "signal:production-trace-oracle:batch-diamond-computed-priority-reentrant-resubscribe-throw-sibling-cleanup-throw-dispose",
        "metadata:compact-decoded-artifact-consumed-by-hydrate:two-instances-store-shadowing-hmr-stale-rejection",
      ],
    },
    measurements: {
      rowCodegen: await rowCodegenEvaluation(iterations, warmup),
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
  const runId = argument("--run-id") ?? `${new Date().toISOString().replaceAll(/[^0-9]/g, "")}-${process.pid}`;
  const output = path.resolve(argument("--output") ?? `benchmark/representation-evaluation-results/${runId}-v3.json`);
  const result = await runRepresentationEvaluation({
    iterations: Number(argument("--iterations") ?? 30),
    warmup: Number(argument("--warmup") ?? 5),
    output,
    argv: process.argv,
  });
  console.log(JSON.stringify({ output, benchmark: result.benchmark, workload: result.workload }, null, 2));
};

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
