# List Row Scope Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the `agent-dag` skill to implement this plan task-by-task (it decides whether to use subagents and builds a Single-Writer Agent DAG). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce unnecessary keyed-list row rebinding CPU work and measure whether `keyed-rows` needs a separate local optimization.

**Architecture:** Keep the compiler and public list API stable. Add runtime-only row-scoped binding effects, detached from the outer list effect with `untrack()`, so row signal changes update only the owning row. Use a per-record revision signal for item replacement updates. Treat `keyed-rows` as a lower-priority manual API surface and patch it only if focused measurement identifies a local bottleneck.

**Tech Stack:** TypeScript, Tachyon DOM runtime, Vitest, Playwright-backed local benchmark runner, pnpm.

---

### Task 1: Baseline and Tournament Artifacts

**Files:**
- Create: `docs.local/logs/2026-07-05/2026-07-05-004-list-row-scope-and-keyed-rows-investigation.md`
- Create: `.codex/candidate-tournaments/list-row-scope/tournament.json`
- Create: `.codex/agent-dags/list-row-scope/decision.json`

- [x] **Step 1: Record local work log and Agent DAG decision**

Use single-writer execution because the impact area is narrow after source inspection.

- [x] **Step 2: Rank implementation candidates**

Selected candidate after RED refinement: row-scoped binding effects in `mountKeyedList`, with unchanged-item skipping as the compatibility guard for item replacement updates.

- [x] **Step 3: Validate artifacts**

Run: `python3 /home/tk/.agents/skills/candidate-tournament/scripts/validate_tournament.py .codex/candidate-tournaments/list-row-scope/tournament.json`
Expected: `OK`.

- [x] **Step 4: Run focused baseline tests**

Run: `pnpm vitest run tests/runtime-list.test.ts tests/keyed-rows.test.ts`
Expected: all focused tests pass before edits.

- [x] **Step 5: Run baseline smoke benchmark**

Run through port registry:

```bash
python3 /home/tk/.agents/skills/port-registry/scripts/portctl.py --cwd /home/tk/work/tachyon-dom run --service vite-benchmark --preferred 5173 --range 5000-5999 -- pnpm bench:local:smoke
```

Expected: benchmark completes, writes a JSON result under `benchmark/local-compare/results/`.

### Task 2: Runtime List RED Test

**Files:**
- Modify: `tests/runtime-list.test.ts`

- [ ] **Step 1: Add a failing test for unchanged row reader suppression**

Add this test near the existing keyed-list binding guard tests:

```ts
  it("skips binding reads for reused rows whose item and outer scope references are unchanged", () => {
    document.body.innerHTML = `<ul id="items"></ul>`;
    const root = document.querySelector("#items");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing test root.");
    }
    const readIds: number[] = [];
    const rows = Array.from({ length: 5 }, (_, index) => ({ id: index + 1, label: `Row ${index + 1}` }));
    const options = {
      signature: "row-scope-skip-unchanged-items",
      key: "item.id",
      itemName: "item",
      templateHtml: `<li><span> </span></li>`,
      bindings: [
        {
          kind: "text" as const,
          path: [0, 0],
          expression: "item.label",
          read: (scope: Record<string, unknown>) => {
            readIds.push((scope.item as { id: number }).id);
            return (scope.item as { label: string }).label;
          },
        },
      ],
    };

    mountKeyedList(root, [], rows, options);
    readIds.length = 0;
    const nextRows = rows.slice();
    nextRows[2] = { id: 3, label: "Row 3 updated" };

    mountKeyedList(root, [], nextRows, options);

    expect(readIds).toEqual([3]);
    expect(Array.from(root.children, (child) => child.textContent)).toEqual([
      "Row 1",
      "Row 2",
      "Row 3 updated",
      "Row 4",
      "Row 5",
    ]);
  });
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run tests/runtime-list.test.ts -t "skips binding reads for reused rows whose item and outer scope references are unchanged"`
Expected: fail with `expected [1,2,3,4,5] to deeply equal [3]`.

### Task 3: Runtime List Implementation

**Files:**
- Modify: `src/runtime/signal.ts`
- Modify: `src/index.ts`
- Modify: `src/runtime/list.ts`

- [x] **Step 1: Add `untrack()` to the signal runtime**

`untrack(fn)` temporarily clears the active effect while `fn` runs.

- [x] **Step 2: Store the last row item, outer scope reference, and row revision signal**

Extend `RowRecord`:

```ts
type RowRecord = {
  key: PropertyKey;
  element: Element;
  nodes: Node[];
  scope: Record<string, unknown>;
  cleanups: Array<() => void>;
  lastValues: unknown[];
  item: unknown;
  outerScope: Record<string, unknown> | undefined;
  revision: Signal<number>;
};
```

- [x] **Step 3: Initialize row-scoped binding effects in `createRecord`**

Create one detached effect per non-event binding with `untrack(() => effect(...))`, and store each disposer in `record.cleanups`.

- [x] **Step 4: Invalidate row effects only when the row item changes or outer-dependent bindings need compatibility updates**

In `updateRecord`, refresh the row scope, then return without bumping the revision when the item is unchanged and every binding is item-scoped:

```ts
if (previousItem === item && hasOnlyItemScopedBindings(options)) {
  return;
}
```

Otherwise, bump `record.revision` so only that row's binding effects rerun.

- [x] **Step 5: Verify GREEN**

Run: `pnpm vitest run tests/runtime-list.test.ts -t "skips binding reads for reused rows whose item and outer scope references are unchanged"`
Expected: pass.

- [x] **Step 6: Run focused signal/list tests**

Run: `pnpm vitest run tests/runtime-signal.test.ts tests/runtime-list.test.ts tests/keyed-rows.test.ts`
Expected: all focused runtime tests pass.

### Task 4: Keyed-Rows Measurement and Patch Decision

**Files:**
- Inspect: `src/runtime/keyed-rows.ts`
- Inspect: `benchmark/js-framework-benchmark/src/main.ts`
- Modify only if measured bottleneck is local: `src/runtime/keyed-rows.ts`, `tests/keyed-rows.test.ts`

- [x] **Step 1: Compare benchmark evidence**

Use baseline and after-change smoke results for `partial update` and `select row`.

- [x] **Step 2: Decide whether to patch `keyed-rows`**

Patch only if the result points to local `keyed-rows` code. Do not change the manual API just to chase noisy one-iteration smoke numbers.

- [x] **Step 3: Add RED test first if patching**

Use Vitest against `createKeyedRows`; no production code change without a failing test.

Decision: no `keyed-rows` patch. The after-change smoke run showed `select row` faster than Solid and `partial update` close to Solid. The remaining `partial update` cost is mainly the benchmark patch body's row DOM traversal, not an isolated `keyed-rows.ts` runtime defect.

### Task 5: Verification, Logs, and Commit

**Files:**
- Modify: `docs.local/logs/2026-07-05/2026-07-05-004-list-row-scope-and-keyed-rows-investigation.md`
- Commit tracked source/test/docs plan files only.

- [x] **Step 1: Run focused tests**

Run: `pnpm vitest run tests/runtime-list.test.ts tests/keyed-rows.test.ts`
Expected: all focused tests pass.

- [x] **Step 2: Run lint**

Run: `pnpm lint`
Expected: no lint errors.

- [x] **Step 3: Run build**

Run: `pnpm build`
Expected: TypeScript and package artifact build complete.

- [x] **Step 4: Run after-change smoke benchmark**

Run through port registry:

```bash
python3 /home/tk/.agents/skills/port-registry/scripts/portctl.py --cwd /home/tk/work/tachyon-dom run --service vite-benchmark --preferred 5173 --range 5000-5999 -- pnpm bench:local:smoke
```

Expected: benchmark completes and writes a new JSON result.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-07-05-list-row-scope-performance.md tests/runtime-list.test.ts src/runtime/list.ts
git commit -m "perf: skip unchanged keyed list row reads"
```
