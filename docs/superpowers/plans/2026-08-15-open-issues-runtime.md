# Open Issue Runtime Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the `agent-dag` skill to implement this plan task-by-task (it decides whether to use subagents and builds a Single-Writer Agent DAG). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close issues 017 and 022 through 027 with bounded caches, explicit error ownership, deterministic disposal, race-safe forms, fresh keyed rows, and no-throw deferred data.

**Architecture:** Add resource bounds and ownership metadata at the point each runtime object is created. Preserve scheduler ordering while catching at runner granularity, make cleanup idempotent and identity-aware, and separate virtual-list identity from content refresh through an explicit hook.

**Tech Stack:** TypeScript, Tachyon DOM reactive runtime, Vitest/jsdom, Playwright, benchmark scripts.

---

### Task 1: Bound the client loader cache with LRU semantics (Issue 017)

**Files:**
- Modify: `src/runtime/router.ts`
- Test: `tests/router-client.test.ts`
- Create: `benchmark/client-router-cache.ts`
- Modify: `docs/routing.md`

- [ ] **Step 1: Create the benchmark harness and record the baseline**

```ts
import { performance } from "node:perf_hooks";
import { JSDOM } from "jsdom";
import { createClientRouter } from "../src/runtime/router";

const dom = new JSDOM(`<main id="root"></main>`, { url: "https://example.test/item/0" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, location: dom.window.location, navigator: dom.window.navigator, Element: dom.window.Element, Node: dom.window.Node });
const root = document.querySelector("#root");
if (!(root instanceof Element)) throw new Error("Missing benchmark root");
const router = createClientRouter({
  root,
  cache: true,
  eager: false,
  routes: [{ path: "/item/:id", load: ({ params }) => params.id, render: ({ data }) => String(data) }],
});
const beforeHeap = process.memoryUsage().heapUsed;
const started = performance.now();
for (let index = 0; index < 5_000; index++) await router.navigate(`/item/${index}`);
console.log(JSON.stringify({ node: process.version, operations: 5_000, durationMs: performance.now() - started, heapDelta: process.memoryUsage().heapUsed - beforeHeap }));
router.dispose();
dom.window.close();
```

```bash
TD_BENCH_RUN="2026-08-15-017-node-$(node -p 'process.version')"
mkdir -p "benchmark/client-router-cache/results/$TD_BENCH_RUN"
pnpm exec tsx benchmark/client-router-cache.ts | tee "benchmark/client-router-cache/results/$TD_BENCH_RUN/before.txt"
```

- [ ] **Step 2: Write deterministic RED tests**

```ts
it("evicts the least recently used loader cache entry", async () => {
  const router = createClientRouter({ routes, cache: { maxEntries: 2 } });
  await router.prefetch("/a");
  await router.prefetch("/b");
  await router.navigate("/a");
  await router.prefetch("/c");
  await router.navigate("/b");
  expect(loaderCalls.get("/a")).toBe(1);
  expect(loaderCalls.get("/b")).toBe(2);
  expect(loaderCalls.get("/c")).toBe(1);
});

it("disables loader caching when maxEntries is zero", async () => {
  const router = createClientRouter({ routes, cache: { maxEntries: 0 } });
  await router.navigate("/a");
  await router.navigate("/a");
  expect(loaderCalls).toBe(2);
});
```

Use public behavior counters rather than exposing a test-only cache API if no inspection method exists.

- [ ] **Step 3: Verify RED**

Run: `pnpm exec vitest run tests/router-client.test.ts -t 'least recently used|cache.*zero'`

Expected: cache growth is unbounded and zero does not disable it.

- [ ] **Step 4: Implement bounded Map recency**

```ts
type LoaderCacheOptions = boolean | { maxEntries?: number };

const resolveCacheLimit = (options: LoaderCacheOptions | undefined): number =>
  options === undefined || options === false
    ? 0
    : typeof options === "object"
      ? Math.max(0, options.maxEntries ?? 100)
      : 100;

const touchCache = <T>(cache: Map<string, T>, key: string, value: T, limit: number): void => {
  if (limit === 0) return;
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) cache.delete(cache.keys().next().value as string);
};
```

Use the same function for navigation results, prefetch results, and hydration seeds; delete then reinsert on reads to update recency.

- [ ] **Step 5: Verify GREEN and benchmark**

```bash
pnpm exec vitest run tests/router-client.test.ts
TD_BENCH_RUN="2026-08-15-017-node-$(node -p 'process.version')"
mkdir -p "benchmark/client-router-cache/results/$TD_BENCH_RUN"
pnpm exec tsx benchmark/client-router-cache.ts | tee "benchmark/client-router-cache/results/$TD_BENCH_RUN/after.txt"
```

Expected: eviction, recency reads, query keys, invalidation, prefetch, and hydration seeding pass; benchmark records 5,000 URLs, operations per second, and heap delta.

- [ ] **Step 6: Document and commit**

```bash
git add src/runtime/router.ts tests/router-client.test.ts benchmark/client-router-cache.ts docs/routing.md
git commit -m "fix: bound the client loader cache"
```

### Task 2: Drain scheduler failures by owner boundary (Issue 022)

**Files:**
- Modify: `src/runtime/signal.ts`
- Modify: `src/runtime/error-boundary.ts`
- Test: `tests/runtime-signal.test.ts`
- Test: `tests/runtime-error-boundary.test.ts`

- [ ] **Step 1: Write failing queue, boundary, and unhandled tests**

```ts
it("drains sibling effects before reporting failures", () => {
  const source = createSignal(0);
  const calls: string[] = [];
  effect(() => { source(); if (source() === 1) throw new Error("first"); });
  effect(() => { source(); calls.push("sibling"); });
  expect(() => batch(() => source.set(1))).toThrow(AggregateError);
  expect(calls).toEqual(["sibling", "sibling"]);
});

it("routes a later child effect failure to the nearest boundary", () => {
  const source = createSignal(false);
  const errors: string[] = [];
  createErrorBoundary(() => effect(() => { if (source()) throw new Error("child"); }), {
    onError: (error) => errors.push(error.message),
  });
  source.set(true);
  expect(errors).toEqual(["child"]);
});
```

Add two-error ordering, memo failure, fallback failure to parent, disposed boundary, retry, and cleanup-throw cases.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run tests/runtime-signal.test.ts tests/runtime-error-boundary.test.ts -t 'drains sibling|nearest boundary|ordered failures'`

Expected: the first throwing runner aborts the queue and later child failures bypass their boundary.

- [ ] **Step 3: Attach error ownership and collect unhandled failures**

```ts
type ErrorOwner = { parent?: ErrorOwner; handleError?: (error: unknown) => void; disposed: boolean };

const deliverError = (owner: ErrorOwner | undefined, error: unknown): boolean => {
  for (let current = owner; current; current = current.parent) {
    if (!current.disposed && current.handleError) {
      current.handleError(error);
      return true;
    }
  }
  return false;
};

const flush = (): void => {
  const unhandled: unknown[] = [];
  while (pendingComputed.size || pendingEffects.size) {
    const runner = takeNextRunner();
    try { runner.run(); } catch (error) {
      if (!deliverError(runner.owner, error)) unhandled.push(error);
    }
  }
  if (unhandled.length === 1) throw unhandled[0];
  if (unhandled.length > 1) throw new AggregateError(unhandled, "Reactive effects failed");
};
```

Preserve computed-before-effect ordering and the existing initial-registration behavior. If a boundary handler throws, resume traversal at its parent rather than recursing into the same boundary.

- [ ] **Step 4: Verify GREEN and scheduler performance invariants**

Run: `pnpm exec vitest run tests/runtime-signal.test.ts tests/runtime-error-boundary.test.ts`

Expected: queue drain, ownership, aggregation order, retry, and existing Set-snapshot performance tests pass with no swallowed error.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/signal.ts src/runtime/error-boundary.ts tests/runtime-signal.test.ts tests/runtime-error-boundary.test.ts
git commit -m "fix: drain reactive errors by owner boundary"
```

### Task 3: Dispose late keyed rows with their root (Issue 023)

**Files:**
- Modify: `src/runtime/list.ts`
- Test: `tests/runtime-list.test.ts`

- [ ] **Step 1: Write the failing late-row disposal test**

```ts
it("disposes effects for rows appended after root creation", () => {
  const rows = createSignal([{ id: 1 }]);
  const shared = createSignal(0);
  const calls = new Map<number, number>();
  const dispose = createRoot((disposeRoot) => {
    mountList(rows, (row) => effect(() => calls.set(row.id, (calls.get(row.id) ?? 0) + shared())));
    return disposeRoot;
  });
  rows.set([{ id: 1 }, { id: 2 }]);
  dispose();
  const snapshot = new Map(calls);
  shared.set(1);
  expect(calls).toEqual(snapshot);
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run tests/runtime-list.test.ts -t 'rows appended after root creation'`

Expected: the late row effect runs after root disposal.

- [ ] **Step 3: Register list-state cleanup at creation**

```ts
const getListState = (anchor: Comment): ListState => {
  const state = existingState(anchor) ?? createListState(anchor);
  if (!state.ownerCleanupRegistered) {
    state.ownerCleanupRegistered = true;
    onCleanup(() => cleanupListState(state));
  }
  return state;
};
```

Make `cleanupListState` idempotent and reuse it for explicit teardown, owner cleanup, and nested-list cleanup.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm exec vitest run tests/runtime-list.test.ts`

Expected: initial rows, multiple late appends, nested rows, explicit row removal, and normal rerender behavior all pass.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/list.ts tests/runtime-list.test.ts
git commit -m "fix: dispose late keyed row effects"
```

### Task 4: Reject concurrent enhanced form submissions (Issue 024)

**Files:**
- Modify: `src/runtime/form.ts`
- Test: `tests/runtime-form-hmr.test.ts`
- Create: `tests/runtime-form-browser.test.ts`
- Modify: `docs/runtime.md`

- [ ] **Step 1: Write rapid-submit and restoration RED tests**

```ts
it("accepts only the first valid submission while pending", async () => {
  const first = deferred<Response>();
  enhanceForm(form, { submit: () => first.promise, onSuccess });
  form.requestSubmit();
  form.requestSubmit();
  expect(submitCalls).toBe(1);
  first.resolve(new Response("ok"));
  await first.promise;
  expect(onSuccessCalls).toBe(1);
});

it("restores each submit control's original disabled state", async () => {
  const initiallyDisabled = form.querySelector('[name="disabled"]') as HTMLButtonElement;
  initiallyDisabled.disabled = true;
  await submitAndResolve(form);
  expect(initiallyDisabled.disabled).toBe(true);
  expect(enabledButton.disabled).toBe(false);
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run tests/runtime-form-hmr.test.ts tests/runtime-form-browser.test.ts -t 'first valid submission|original disabled state'`

Expected: two requests start and control restoration loses at least one original state.

- [ ] **Step 3: Add pending lock and generation guard**

```ts
let phase: "idle" | "validating" | "pending" = "idle";
let disposed = false;
let generation = 0;

const submit = async (event: SubmitEvent): Promise<void> => {
  if (phase !== "idle" || disposed) return;
  phase = "validating";
  if (!form.checkValidity()) { phase = "idle"; return; }
  phase = "pending";
  const currentGeneration = ++generation;
  const disabledStates = submitControls(form).map((control) => [control, control.disabled] as const);
  disabledStates.forEach(([control]) => { control.disabled = true; });
  try {
    const result = await options.submit(createContext(event));
    if (!disposed && currentGeneration === generation) await handleResult(result);
  } finally {
    if (currentGeneration === generation) {
      phase = "idle";
      disabledStates.forEach(([control, disabled]) => { control.disabled = disabled; });
    }
  }
};
```

Acquire the lock only after native/custom validation passes. Increment generation on cleanup so a completion after disposal cannot update UI or call success handlers.

- [ ] **Step 4: Verify GREEN in unit and browser tests**

```bash
pnpm exec vitest run tests/runtime-form-hmr.test.ts tests/router-compatibility.test.ts
pnpm exec vitest run tests/runtime-form-browser.test.ts
```

Expected: rapid clicks start one request, validation failures start none, stale completions do nothing, and disabled state is restored after success and failure.

- [ ] **Step 5: Document and commit**

```bash
git add src/runtime/form.ts tests/runtime-form-hmr.test.ts tests/runtime-form-browser.test.ts docs/runtime.md
git commit -m "fix: prevent concurrent enhanced form submissions"
```

### Task 5: Preserve virtual-list identity and freshness (Issue 025)

**Files:**
- Modify: `src/runtime/virtual-list.ts`
- Test: `tests/runtime-virtual-list.test.ts`
- Create: `tests/runtime-virtual-list-browser.test.ts`
- Create: `benchmark/virtual-list-update.ts`
- Modify: `docs/runtime.md`

- [ ] **Step 1: Create the benchmark harness and record the baseline**

```ts
import { performance } from "node:perf_hooks";
import { JSDOM } from "jsdom";
import { createVirtualizedList } from "../src/runtime/virtual-list";

const dom = new JSDOM(`<div id="scroller"></div>`);
Object.assign(globalThis, { window: dom.window, document: dom.window.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement });
const scroller = document.querySelector("#scroller");
if (!(scroller instanceof HTMLElement)) throw new Error("Missing benchmark scroller");
let renderCalls = 0;
const items = Array.from({ length: 10_000 }, (_, id) => ({ id, label: `Row ${id}` }));
const list = createVirtualizedList({
  scroller, items, itemHeight: 20, viewportHeight: 400, getKey: (item) => item.id,
  renderItem: (item) => { renderCalls++; const row = document.createElement("div"); row.textContent = item.label; return row; },
});
const started = performance.now();
for (let iteration = 0; iteration < 100; iteration++) list.update(items.map((item) => ({ ...item })));
console.log(JSON.stringify({ node: process.version, items: items.length, updates: 100, renderCalls, durationMs: performance.now() - started }));
list.destroy();
dom.window.close();
```

```bash
TD_BENCH_RUN="2026-08-15-025-node-$(node -p 'process.version')"
mkdir -p "benchmark/virtual-list/results/$TD_BENCH_RUN"
pnpm exec tsx benchmark/virtual-list-update.ts | tee "benchmark/virtual-list/results/$TD_BENCH_RUN/before.txt"
```

- [ ] **Step 2: Write separate identity and freshness RED tests**

```ts
it("keeps keyed elements and refreshes their content on update", () => {
  const first = { id: "a", label: "A" };
  const list = createVirtualizedList({ scroller: container, items: [first], itemHeight: 24,
    getKey: (item) => item.id,
    renderItem: (item) => element("button", item.label),
    updateItem: (element, item) => { element.textContent = item.label; },
  });
  const before = container.querySelector("button");
  list.update([{ id: "a", label: "B" }]);
  expect(container.querySelector("button")).toBe(before);
  expect(before?.textContent).toBe("B");
});
```

Add move/add/remove, changed index, duplicate-key rejection, focus preservation, and fallback index-key insertion cases.

- [ ] **Step 3: Verify RED**

Run: `pnpm exec vitest run tests/runtime-virtual-list.test.ts tests/runtime-virtual-list-browser.test.ts -t 'keyed elements|duplicate key|focus'`

Expected: `update()` discards the rendered Map and replaces the focused element.

- [ ] **Step 4: Add the refresh hook and retain keyed state**

```ts
export type VirtualizedListOptions<T> = {
  scroller: HTMLElement;
  items: readonly T[];
  itemHeight: number;
  overscan?: number;
  getKey?: (item: T, index: number) => PropertyKey;
  renderItem: (item: T, index: number) => Element;
  updateItem?: (element: Element, item: T, index: number) => void;
};

const reuseRow = <T>(record: RowRecord, item: T, index: number, options: VirtualizedListOptions<T>): Element => {
  options.updateItem?.(record.element, item, index);
  updateRowMetadata(record.element, index);
  return record.element;
};
```

Do not clear the rendered Map during `update`. Remove only keys no longer present, reject duplicate keys, and call `updateItem` before insertion for every reused visible row.

- [ ] **Step 5: Verify GREEN and benchmark**

```bash
pnpm exec vitest run tests/runtime-virtual-list.test.ts
pnpm exec vitest run tests/runtime-virtual-list-browser.test.ts
TD_BENCH_RUN="2026-08-15-025-node-$(node -p 'process.version')"
mkdir -p "benchmark/virtual-list/results/$TD_BENCH_RUN"
pnpm exec tsx benchmark/virtual-list-update.ts | tee "benchmark/virtual-list/results/$TD_BENCH_RUN/after.txt"
```

Expected: identity, freshness, focus, window bounds, requestAnimationFrame coalescing, and same-range no-op pass; benchmark records render and update call counts.

- [ ] **Step 6: Document and commit**

```bash
git add src/runtime/virtual-list.ts tests/runtime-virtual-list.test.ts tests/runtime-virtual-list-browser.test.ts benchmark/virtual-list-update.ts docs/runtime.md
git commit -m "fix: preserve virtual list identity and freshness"
```

### Task 6: Clear refs on every disposal path (Issue 026)

**Files:**
- Modify: `src/runtime/attr.ts`
- Modify: `src/runtime/conditional.ts`
- Modify: `src/runtime/list.ts`
- Modify: `src/compiler/targets/client.ts`
- Test: `tests/runtime-attr-form.test.ts`
- Test: `tests/runtime-conditional.test.ts`
- Test: `tests/runtime-list.test.ts`
- Test: `tests/compiler.test.ts`

- [ ] **Step 1: Write failing top-level, conditional, and list tests**

```ts
it("clears only the element currently held by a ref", () => {
  const scope = { ref: undefined as Element | undefined };
  const first = document.createElement("div");
  const cleanup = setRef(scope, ["ref"], first);
  scope.ref = document.createElement("span");
  cleanup();
  expect(scope.ref?.tagName).toBe("SPAN");
});
```

Add disposal cases for top-level generated bind, conditional unmount, keyed row removal, and root disposal.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run tests/runtime-attr-form.test.ts tests/runtime-conditional.test.ts tests/runtime-list.test.ts tests/compiler.test.ts -t 'clears.*ref|ref.*disposal'`

Expected: `setRef` returns no cleanup and disposed refs retain detached elements.

- [ ] **Step 3: Return identity-guarded cleanup and register it**

```ts
export const setRef = (scope: object, path: readonly string[], element: Element): (() => void) => {
  const target = resolveRefTarget(scope, path);
  if (!target) return () => undefined;
  target.object[target.key] = element;
  return () => {
    if (target.object[target.key] === element) target.object[target.key] = undefined;
  };
};
```

Push the returned cleanup into generated top-level cleanup, conditional cleanup, and each list record cleanup.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm exec vitest run tests/runtime-attr-form.test.ts tests/runtime-conditional.test.ts tests/runtime-list.test.ts tests/compiler.test.ts`

Expected: all paths clear refs once, replacement refs survive old cleanup, and invalid intermediate paths remain no-ops.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/attr.ts src/runtime/conditional.ts src/runtime/list.ts src/compiler/targets/client.ts tests/runtime-attr-form.test.ts tests/runtime-conditional.test.ts tests/runtime-list.test.ts tests/compiler.test.ts
git commit -m "fix: clear refs during binding disposal"
```

### Task 7: Add Result-based deferred data reading (Issue 027)

**Files:**
- Modify: `src/runtime/stream-client.ts`
- Modify: `src/index.ts`
- Test: `tests/runtime-form-hmr.test.ts`
- Test: `tests/public-api.test.ts`
- Modify: `docs/runtime.md`

- [ ] **Step 1: Write failing missing, malformed, and compatibility tests**

```ts
it("distinguishes missing and invalid deferred data", () => {
  expect(readDeferredDataScriptResult(document, "missing")).toEqual({ ok: false, error: { kind: "missing" } });
  document.body.innerHTML = `<script id="td-data-broken" type="application/json">{</script>`;
  expect(readDeferredDataScriptResult(document, "broken")).toEqual({ ok: false, error: { kind: "invalid" } });
  expect(readDeferredDataScript(document, "broken")).toBeUndefined();
});
```

Add valid `null`, object, array, selector-special ID, and error-message secrecy cases.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run tests/runtime-form-hmr.test.ts tests/public-api.test.ts -t 'deferred data'`

Expected: the Result function is missing and the legacy helper throws on malformed JSON.

- [ ] **Step 3: Add a discriminated Result and no-throw wrapper**

```ts
export type DeferredDataReadError =
  | { kind: "missing"; id: string }
  | { kind: "invalid"; id: string; cause: unknown };

export const readDeferredDataScriptResult = <T>(root: ParentNode, id: string): Result<T, DeferredDataReadError> => {
  const script = Array.from(root.querySelectorAll(`script[type="application/json"][data-tachyon-deferred]`)).find(
    (candidate) => candidate.getAttribute("data-tachyon-deferred") === id,
  );
  if (!script) return err({ kind: "missing", id });
  try { return ok(JSON.parse(script.textContent ?? "null") as T); }
  catch (cause) { return err({ kind: "invalid", id, cause }); }
};

/** @deprecated Use readDeferredDataScriptResult to distinguish missing and invalid data. */
export const readDeferredDataScript = <T>(root: ParentNode, id: string): T | undefined => {
  const result = readDeferredDataScriptResult<T>(root, id);
  return result.ok ? result.value : undefined;
};
```

- [ ] **Step 4: Verify GREEN and exports**

```bash
pnpm exec vitest run tests/runtime-form-hmr.test.ts tests/public-api.test.ts
pnpm build
pnpm check:exports
```

Expected: malformed JSON never throws, callers can distinguish both failures, valid `null` remains a successful value, and the subpath declaration exposes the new API.

- [ ] **Step 5: Document and commit**

```bash
git add src/runtime/stream-client.ts src/index.ts tests/runtime-form-hmr.test.ts tests/public-api.test.ts docs/runtime.md
git commit -m "feat: add safe deferred data reader"
```

### Task 8: Run runtime verification

**Files:**
- No source changes expected.

- [ ] **Step 1: Run focused suites and gates**

```bash
pnpm exec vitest run tests/router-client.test.ts tests/runtime-signal.test.ts tests/runtime-error-boundary.test.ts tests/runtime-list.test.ts tests/runtime-form-hmr.test.ts tests/runtime-form-browser.test.ts tests/runtime-virtual-list.test.ts tests/runtime-virtual-list-browser.test.ts tests/runtime-attr-form.test.ts tests/runtime-conditional.test.ts tests/compiler.test.ts tests/public-api.test.ts
pnpm lint
pnpm build
pnpm check:exports
pnpm check:size
```

Expected: every command exits 0.

- [ ] **Step 2: Check process cleanup**

```bash
ps -eo pid=,ppid=,comm=,args= | rg 'chrome-headless|playwright|vite' || true
```

Expected: no process started by the runtime browser suite remains.
