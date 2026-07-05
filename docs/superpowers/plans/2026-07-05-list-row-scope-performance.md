# List Row Scope Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the `agent-dag` skill to implement this plan task-by-task (it decides whether to use subagents and builds a Single-Writer Agent DAG). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce unnecessary keyed-list row rebinding CPU work and measure whether `keyed-rows` needs a separate local optimization.

**Architecture:** Keep the compiler and public list API stable. Add a runtime-only row update guard that reuses DOM records but skips binding re-evaluation when a reused row receives the identical item reference and unchanged outer scope reference. Treat `keyed-rows` as a lower-priority manual API surface and patch it only if focused measurement identifies a local bottleneck.

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

Selected candidate: row-level unchanged-item skipping in `mountKeyedList`.

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
- Modify: `src/runtime/list.ts`

- [ ] **Step 1: Store the last row item and outer scope reference**

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
};
```

- [ ] **Step 2: Initialize the new fields in `createRecord`**

Set `item` and `outerScope` when creating a record.

- [ ] **Step 3: Skip update when item and outer scope are unchanged**

In `updateRecord`, return before `Object.assign()` and `applyRowBindings()` when both references are identical:

```ts
if (record.item === item && record.outerScope === options.scope) {
  return;
}
```

Then update `record.item` and `record.outerScope` before applying bindings.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm vitest run tests/runtime-list.test.ts -t "skips binding reads for reused rows whose item and outer scope references are unchanged"`
Expected: pass.

- [ ] **Step 5: Run focused list tests**

Run: `pnpm vitest run tests/runtime-list.test.ts`
Expected: all runtime list tests pass.

### Task 4: Keyed-Rows Measurement and Patch Decision

**Files:**
- Inspect: `src/runtime/keyed-rows.ts`
- Inspect: `benchmark/js-framework-benchmark/src/main.ts`
- Modify only if measured bottleneck is local: `src/runtime/keyed-rows.ts`, `tests/keyed-rows.test.ts`

- [ ] **Step 1: Compare benchmark evidence**

Use baseline and after-change smoke results for `partial update` and `select row`.

- [ ] **Step 2: Decide whether to patch `keyed-rows`**

Patch only if the result points to local `keyed-rows` code. Do not change the manual API just to chase noisy one-iteration smoke numbers.

- [ ] **Step 3: Add RED test first if patching**

Use Vitest against `createKeyedRows`; no production code change without a failing test.

### Task 5: Verification, Logs, and Commit

**Files:**
- Modify: `docs.local/logs/2026-07-05/2026-07-05-004-list-row-scope-and-keyed-rows-investigation.md`
- Commit tracked source/test/docs plan files only.

- [ ] **Step 1: Run focused tests**

Run: `pnpm vitest run tests/runtime-list.test.ts tests/keyed-rows.test.ts`
Expected: all focused tests pass.

- [ ] **Step 2: Run lint**

Run: `pnpm lint`
Expected: no lint errors.

- [ ] **Step 3: Run build**

Run: `pnpm build`
Expected: TypeScript and package artifact build complete.

- [ ] **Step 4: Run after-change smoke benchmark**

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
