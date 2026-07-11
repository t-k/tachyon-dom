# Resolve All Open Performance Issues Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the `agent-dag` skill to implement this plan task-by-task (it decides whether to use subagents and builds a Single-Writer Agent DAG). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve all eight local open performance issues with statistically authoritative benchmark evidence and semantics-preserving implementation changes.

**Architecture:** A shared statistical-authority module treats fresh processes as independent observations and is consumed by local and web benchmark reports. Runners emit versioned raw samples and balanced-order metadata. Stream parity is repaired independently, while keyed-row candidates proceed only after action-only evidence and correctness guardrails justify a change.

**Tech Stack:** TypeScript, Vitest, Playwright/Chromium benchmark runners, OxLint, pnpm, Port Registry.

---

## File Structure

- Create `benchmark/shared/statistical-authority.ts`: deterministic PRNG, balanced-order generation, one-sided run-level bootstrap, and authority classification.
- Create `tests/statistical-authority.test.ts`: deterministic statistical and order-balance fixtures.
- Modify `benchmark/local-compare/validation.ts`: contract v3 decoding and authoritative-run validation.
- Modify `benchmark/local-compare/run-local-compare.ts`: v3 metadata, raw samples, seeded measured order, and run ID.
- Modify `benchmark/local-compare/aggregate.ts`: ratio distributions, confidence upper bounds, and reason-coded output.
- Modify `tests/local-compare-validation.test.ts` and `tests/local-compare-report.test.ts`: local authority regressions.
- Modify `benchmark/web-framework/contract.ts`, `report.ts`, and `run-web-framework-benchmark.ts`: contract v4, repeated stream samples, authority metadata, and reporting.
- Modify `benchmark/web-framework/fixtures/tachyon/server.ts`: scored/evidence stream split.
- Modify `tests/web-framework-contract.test.ts`, `tests/web-framework-fixtures.test.ts`, and `tests/web-framework-report.test.ts`: parity, chronology, distribution, and diagnostics coverage.
- Modify `benchmark/js-framework-benchmark/src/main.ts`, `src/runtime/keyed-rows.ts`, `tests/keyed-rows.test.ts`, and `tests/js-framework-benchmark-app.test.ts` only when the corresponding RED test and trace justify a candidate.
- Modify `benchmark/local-compare/README.md` and `benchmark/web-framework/README.md`: public authority contract documentation.

### Task 1: Shared Statistical Authority

**Files:**

- Create: `benchmark/shared/statistical-authority.ts`
- Create: `tests/statistical-authority.test.ts`

- [ ] **Step 1: Write the failing statistical tests**

Add tests that call the proposed public API:

```ts
import { describe, expect, it } from "vitest";
import { analyzeRatios, balancedOrder } from "../benchmark/shared/statistical-authority";

describe("benchmark statistical authority", () => {
  it("classifies a stable one-percent-or-better win as meaningful", () => {
    expect(analyzeRatios([0.979, 0.981, 0.98, 0.982, 0.978], { seed: 7, resamples: 10_000 })).toMatchObject({
      status: "meaningful-win",
      medianRatio: 0.98,
    });
  });

  it("keeps a noisy apparent win inconclusive", () => {
    expect(analyzeRatios([0.8, 1.2, 0.82, 1.18, 0.9], { seed: 7, resamples: 10_000 }).status).toBe(
      "inconclusive",
    );
  });

  it("reproduces balanced order from the same seed", () => {
    expect(balancedOrder(["a", "b", "c"], 4, 9)).toEqual(balancedOrder(["a", "b", "c"], 4, 9));
    expect(new Set([0, 1, 2].map((run) => balancedOrder(["a", "b", "c"], run, 9)[0]))).toEqual(
      new Set(["a", "b", "c"]),
    );
  });
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run tests/statistical-authority.test.ts`

Expected: FAIL because `benchmark/shared/statistical-authority.ts` does not exist.

- [ ] **Step 3: Implement the minimal shared module**

Export these exact contracts:

```ts
export type AuthorityStatus = "meaningful-win" | "reproducible-win" | "tie-or-loss" | "inconclusive";
export type RatioAnalysis = {
  status: AuthorityStatus;
  medianRatio: number;
  oneSided95UpperBound: number;
  independentRunCount: number;
};
export const balancedOrder: <T>(items: readonly T[], runIndex: number, seed: number) => T[];
export const analyzeRatios: (
  ratios: readonly number[],
  options: { seed: number; resamples: number },
) => RatioAnalysis;
```

Use a small deterministic integer PRNG. Resample the supplied run ratios, compute one median per resample, and take the 95th percentile. Reject non-finite/non-positive ratios and fewer than five independent runs with an `inconclusive` result.

- [ ] **Step 4: Verify GREEN and refactor**

Run: `pnpm exec vitest run tests/statistical-authority.test.ts`

Expected: PASS with deterministic repeated results.

- [ ] **Step 5: Commit**

```bash
git add benchmark/shared/statistical-authority.ts tests/statistical-authority.test.ts
git commit -m "feat: add benchmark statistical authority"
```

### Task 2: Local Benchmark Contract v3 Validation

**Files:**

- Modify: `benchmark/local-compare/validation.ts`
- Modify: `tests/local-compare-validation.test.ts`

- [ ] **Step 1: Extend the fixture and write rejection tests**

Change the test fixture to contract v3 with:

```ts
benchmark: { name: "local-compare", contractVersion: 3 },
workload: {
  runId: "run-0",
  seed: 17,
  order: ["vanillajs-lite-keyed", "tachyon-dom"],
  scenarioOrder: [...scenarioIds],
  iterations: 30,
  warmup: 5,
  // existing fields remain
},
```

Add table tests proving rejection of contract v2, fewer than five runs, duplicate run IDs, fewer than 30 iterations, fewer than 5 warmups, missing raw samples, repeated fixed positions, and mismatched provenance. Add one success fixture with five run IDs and balanced implementation positions.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run tests/local-compare-validation.test.ts`

Expected: FAIL because v3 fields and cross-run authority checks are not implemented.

- [ ] **Step 3: Implement v3 validation**

Update `LocalCompareRun` so each summary contains `values: number[]`, and add run ID, seed, implementation order, and scenario order. Require contract version 3, five compatible runs, 30/5 samples for authority, unique IDs, finite raw values, and balanced position coverage. Return reason paths through the existing `invalidFields` result rather than throwing.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm exec vitest run tests/local-compare-validation.test.ts tests/statistical-authority.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add benchmark/local-compare/validation.ts tests/local-compare-validation.test.ts
git commit -m "feat: validate authoritative local benchmark runs"
```

### Task 3: Local Runner Metadata and Balanced Orders

**Files:**

- Modify: `benchmark/local-compare/run-local-compare.ts`
- Modify: `tests/local-compare-report.test.ts`

- [ ] **Step 1: Write runner metadata RED tests**

Extract pure helpers for CLI seed/run-index parsing and artifact workload construction. Test that the same seed/run index reproduces implementation and scenario order, adjacent run indices rotate positions, raw scenario values are retained, and the default output remains timestamp scoped.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run tests/local-compare-report.test.ts`

Expected: FAIL because runner metadata helpers and raw `values` fields are absent.

- [ ] **Step 3: Implement runner changes**

Accept `--seed <integer>`, `--run-index <non-negative integer>`, and optional `--run-id <string>`. Generate a UUID when run ID is omitted. Apply `balancedOrder` to implementations and scenarios without changing scenario definitions or DOM workload. Store actual measured orders, seed, run ID, raw values, warmups, and iterations in contract v3 output.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm exec vitest run tests/local-compare-report.test.ts tests/local-compare-validation.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add benchmark/local-compare/run-local-compare.ts tests/local-compare-report.test.ts
git commit -m "feat: balance local benchmark execution order"
```

### Task 4: Local Authority Aggregate

**Files:**

- Modify: `benchmark/local-compare/aggregate.ts`
- Create: `benchmark/local-compare/aggregate-report.ts`
- Modify: `tests/local-compare-report.test.ts`

- [ ] **Step 1: Write report RED tests**

Create pure report fixtures for stable `0.98`, high-variance, tie, loss, dirty, undersampled, and incompatible inputs. Assert output fields `medianRatio`, `oneSided95UpperBound`, `independentRunCount`, `sampleCountPerRun`, `status`, and `reasons`.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run tests/local-compare-report.test.ts`

Expected: FAIL because authority report rows do not exist.

- [ ] **Step 3: Implement the pure report and CLI adapter**

Build per-run candidate-to-fastest-competitor ratios from each run's trimmed means, pass ratios to `analyzeRatios`, and format `meaningful-win`, `reproducible-win`, `tie-or-loss`, or `inconclusive`. Keep historical JSON parsing available through an explicitly non-authoritative path, but never promote it to a v3 ranking.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm exec vitest run tests/local-compare-report.test.ts tests/local-compare-validation.test.ts tests/statistical-authority.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add benchmark/local-compare/aggregate.ts benchmark/local-compare/aggregate-report.ts tests/local-compare-report.test.ts
git commit -m "feat: report confidence-bounded local rankings"
```

### Task 5: Web Contract v4 Repeated Stream Measurements

**Files:**

- Modify: `benchmark/web-framework/contract.ts`
- Modify: `benchmark/web-framework/report.ts`
- Modify: `benchmark/web-framework/run-web-framework-benchmark.ts`
- Modify: `tests/web-framework-contract.test.ts`
- Modify: `tests/web-framework-report.test.ts`

- [ ] **Step 1: Write repeated-sample RED tests**

Define `StreamSample` as `{ ttfb, complete, shellToDoneGap, chunkArrivalMs }`. Test that a collection requires at least 20 measured samples after 5 warmups, every measured sample passes chronology, raw arrivals are retained, the same seed reproduces framework order, and a high-variance distribution is inconclusive.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run tests/web-framework-contract.test.ts tests/web-framework-report.test.ts`

Expected: FAIL because the runner stores one stream sample and the report has no authority state.

- [ ] **Step 3: Implement contract v4**

Bump `WEB_FRAMEWORK_CONTRACT_VERSION` to 4. Add CLI/default controls for 5 warmups and 20 measured stream samples, loop through `measureStreamSemantics` with the same connection policy for every framework, and save every raw sample. Store seed, run ID, actual framework order, and explicit authority reason codes. Retain existing non-stream metrics and clearly mark old v3 stream rankings non-authoritative.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm exec vitest run tests/web-framework-contract.test.ts tests/web-framework-report.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add benchmark/web-framework/contract.ts benchmark/web-framework/report.ts benchmark/web-framework/run-web-framework-benchmark.ts tests/web-framework-contract.test.ts tests/web-framework-report.test.ts
git commit -m "feat: record authoritative web stream distributions"
```

### Task 6: Scored Stream Parity and Evidence Route

**Files:**

- Modify: `benchmark/web-framework/fixtures/tachyon/server.ts`
- Modify: `benchmark/web-framework/run-web-framework-benchmark.ts`
- Modify: `tests/web-framework-fixtures.test.ts`
- Modify: `tests/web-framework-contract.test.ts`

- [ ] **Step 1: Write fixture parity RED tests**

Replace the source-substring-only expectation with a scored workload manifest or exported fixture contract. Assert every scored fixture has `delayDependencies: 1`, `delayMs: 20`, `items: 80`, and `deferredBoundaries: 1`. Assert Tachyon `/stream-evidence` has four stages, uses `RouteDefinition.stream`, and remains the diagnostics target.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run tests/web-framework-fixtures.test.ts tests/web-framework-contract.test.ts`

Expected: FAIL because Tachyon scored `/stream` still has four sequential stages and no separate evidence route.

- [ ] **Step 3: Split scored and evidence generators**

Make `/stream` yield shell, wait 20 ms once, then yield exactly one 80-item done section. Keep the four-stage generator under `/stream-evidence`. Register both through the same Tachyon route table and Node streaming adapter. Point `measureTachyonRouteStreamEvidence` to `/stream-evidence`; do not weaken cancellation, completed-stream, emitted-chunk, RSS, or TTFB thresholds.

- [ ] **Step 4: Verify GREEN and adapter regressions**

Run: `pnpm exec vitest run tests/web-framework-fixtures.test.ts tests/web-framework-contract.test.ts tests/router-adapters.test.ts tests/router-stream-escaping-property.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add benchmark/web-framework/fixtures/tachyon/server.ts benchmark/web-framework/run-web-framework-benchmark.ts tests/web-framework-fixtures.test.ts tests/web-framework-contract.test.ts
git commit -m "fix: restore scored stream fixture parity"
```

### Task 7: Delegated Remove and Select Routing

**Files:**

- Modify: `benchmark/js-framework-benchmark/src/main.ts`
- Modify: `tests/js-framework-benchmark-app.test.ts`
- Modify: `tests/keyed-rows.test.ts`

- [ ] **Step 1: Add table-driven RED tests**

Cover remove span, remove anchor, select anchor, nested element, text target, non-element target, and target outside the owned `tbody`. Verify exactly one row lookup for classified actions, no remove/select confusion, one delegated listener, and correct selected identity after removal.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run tests/js-framework-benchmark-app.test.ts tests/keyed-rows.test.ts`

Expected: FAIL on the row-lookup count or uncovered target classification.

- [ ] **Step 3: Capture before trace**

Use Port Registry and production mode:

```bash
python3 /home/tk/.agents/skills/port-registry/scripts/portctl.py run -- \
  pnpm exec tsx benchmark/local-compare/run-local-compare.ts \
  --serve-mode production --iterations 1 --warmup 1 \
  --trace-implementation tachyon-dom --trace-scenario removeRow
```

Save the trace under a new run-scoped path and record EventDispatch versus frame waiting. If the double lookup is not a repeated script cost, do not change the fixture and close issues 004/007 through measurement evidence.

- [ ] **Step 4: Implement only the evidenced routing candidate**

Classify a safe `Element` action before resolving its owning row, perform at most one `closest("tr")`, verify the row belongs to the owned `tbody`, then call remove or select. Do not use a fixed parent chain or add row listeners.

- [ ] **Step 5: Verify and capture after trace**

Run the targeted tests and the identical trace command. Confirm select correctness and non-selection classes remain unchanged.

- [ ] **Step 6: Commit if and only if validators pass**

```bash
git add benchmark/js-framework-benchmark/src/main.ts tests/js-framework-benchmark-app.test.ts tests/keyed-rows.test.ts
git commit -m "perf: streamline delegated keyed-row actions"
```

### Task 8: Keyed-Row Semantic Guardrails

**Files:**

- Modify: `tests/keyed-rows.test.ts`
- Modify: `tests/js-framework-benchmark-app.test.ts`

- [ ] **Step 1: Add RED coverage for unresolved obligations**

Add focused tests for update callback indices and live mutation, swap directions/adjacency/focus/input value, clear `tbody` identity and post-clear reuse, same-row selection mutation count, rebuild counts at 49/50/51 and non-divisible boundaries, selection reset, and append global indices.

- [ ] **Step 2: Verify RED behavior**

Run: `pnpm exec vitest run tests/keyed-rows.test.ts tests/js-framework-benchmark-app.test.ts`

Expected: Newly exposed obligations either fail for a real gap or pass immediately because they characterize existing behavior. Tests that pass immediately are characterization coverage and must not be represented as TDD evidence for a source change.

- [ ] **Step 3: Fix correctness gaps only**

For any genuine failing semantic test, make the smallest runtime correction in `src/runtime/keyed-rows.ts`, rerun the single test, then the two targeted files. Do not introduce caches, pools, `tbody` replacement, async cleanup, or benchmark-only public APIs.

- [ ] **Step 4: Commit coverage and any justified correction**

```bash
git add tests/keyed-rows.test.ts tests/js-framework-benchmark-app.test.ts src/runtime/keyed-rows.ts
git commit -m "test: strengthen keyed-row semantic guardrails"
```

### Task 9: Profile Remaining Keyed-Row Candidates

**Files:**

- Modify if justified: `src/runtime/keyed-rows.ts`
- Modify if justified: `tests/keyed-rows.test.ts`
- Preserve: `benchmark/local-compare/results/**`

- [ ] **Step 1: Measure candidate groups in dependency order**

Run production action-only traces for `clearRows` plus `replaceAllRows`/`createManyRows`, then `partialUpdate`, then `swapRows`. Save each result and trace under a new run-scoped path. Compare `textContent`/`replaceChildren`, build phase geometry, callback/path cost, and `insertBefore`/supported native move primitives without editing the runtime first.

- [ ] **Step 2: Select or reject candidates**

Reject a candidate when its suspected operation is not a repeated dominant cost, when it changes observable semantics, or when the expected gain is below measurement resolution. Record the rejection in the local work log and close the issue as an evidence-backed no-change decision.

- [ ] **Step 3: For each selected candidate, perform a separate TDD cycle**

Write one failing semantic or instrumentation test, observe RED, implement one primitive change, observe GREEN, then run the identical before/after trace. Never combine clear, build, update, and swap changes in one experiment.

- [ ] **Step 4: Enforce guardrails**

Run local stable comparisons and check createRows, appendRows, nine-operation geomean, entry/source size, runHeap, runClearHeap, and runClearDomNodes. Reject any candidate exceeding the issue's 2% guardrail.

- [ ] **Step 5: Commit each accepted candidate separately**

Use operation-specific messages such as `perf: reduce keyed-row rebuild overhead`. Do not commit rejected experiments.

### Task 10: Documentation, Authoritative Runs, and Closure

**Files:**

- Modify: `benchmark/local-compare/README.md`
- Modify: `benchmark/web-framework/README.md`
- Update locally only: `docs.local/logs/2026-07-12/2026-07-12-003-resolve-all-open-issues.md`
- Move locally only: `docs.local/issues/open/*.md` to `docs.local/issues/closed/`

- [ ] **Step 1: Document the public contract in English**

Explain independent fresh-process runs, raw samples, balanced order, deterministic one-sided 95% upper bounds, status meanings, minimum run/sample counts, historical artifact handling, and run-scoped output.

- [ ] **Step 2: Verify documentation and commit**

Run: `pnpm exec vitest run tests/local-compare-report.test.ts tests/local-compare-validation.test.ts tests/web-framework-report.test.ts tests/web-framework-contract.test.ts tests/web-framework-fixtures.test.ts`

Then commit:

```bash
git add benchmark/local-compare/README.md benchmark/web-framework/README.md
git commit -m "docs: define authoritative benchmark rankings"
```

- [ ] **Step 3: Run final static and test verification**

Run in this order:

```bash
pnpm lint
pnpm build
pnpm test
```

Expected: all commands exit 0; package artifact tests run after build.

- [ ] **Step 4: Run authoritative local benchmarks**

Run at least five clean fresh-process production runs with 30 measured samples and 5 warmups through Port Registry, using distinct balanced run indices and new output files. Aggregate them with the v3 authority report. Preserve all result paths.

- [ ] **Step 5: Run authoritative web benchmarks**

Run at least five clean fresh-process full production runs through Port Registry. Confirm each framework stores 20 measured stream samples after 5 warmups and Tachyon evidence-route diagnostics pass. Aggregate/report the v4 authority state and preserve every result path.

- [ ] **Step 6: Perform lifecycle verification**

Release every Port Registry claim and inspect exact PIDs/arguments for surviving Vite, workerd, Chromium, benchmark, or agent-browser processes. Stop only verified task-owned processes with SIGTERM, recheck, and use SIGKILL only for a verified process that traps termination.

- [ ] **Step 7: Close supported issues locally**

For each issue, record whether closure came from implementation, design/mental-model evidence, measurement-only no-change, or an authoritative parity result. Leave any issue open if its acceptance criteria or required clean runs remain debt. Move supported files to `docs.local/issues/closed/` and finalize the Japanese work log without staging ignored files.

- [ ] **Step 8: Clean-context review and final handoff**

Provide the reviewer only the original request, acceptance criteria, final diff, relevant files, and fresh test/benchmark results. Resolve Must Fix findings, rerun affected validators, and report commits, classifications, moved issues, artifact paths, Security Specialist status, and stopped processes.
