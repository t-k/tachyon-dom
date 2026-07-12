# Evidence-Gated Performance Candidates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the `agent-dag` skill to implement this plan task-by-task (it decides whether to use subagents and builds a Single-Writer Agent DAG). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evaluate action/rendering metrics, keyed-row `moveBefore()`, Node handler hoisting, and bounded bind-target caching, retaining only candidates that pass correctness and reproducible improvement gates.

**Architecture:** Measurement decomposition lands first because it supplies candidate-specific evidence without replacing frame-complete rankings. Each runtime candidate is developed in an isolated commit, compared against its parent, and either retained or reverted while durable evidence remains in the root workspace. Shared authority statistics and signed run-scoped artifacts remain the source of truth.

**Tech Stack:** TypeScript, Vitest, Playwright/Chromium, Chrome tracing, Node.js HTTP adapters, OxLint/OxFmt, pnpm.

---

### Task 1: Create candidate issues, work log, and evidence layout

**Files:**
- Create locally: `docs.local/issues/open/2026-07-12-009-local-action-rendering-metrics.md`
- Create locally: `docs.local/issues/open/2026-07-12-010-keyed-rows-move-before.md`
- Create locally: `docs.local/issues/open/2026-07-12-011-node-handler-hoisting.md`
- Create locally: `docs.local/issues/open/2026-07-12-012-keyed-rows-bind-target-cache.md`
- Create locally: `docs.local/logs/2026-07-12/2026-07-12-006-evidence-gated-performance-candidates.md`
- Create locally: `docs.local/benchmark-evidence/2026-07-12-performance-candidates/README.md`

- [ ] **Step 1: Write four source-aware issues**

Each issue records the candidate hypothesis, source evidence, semantics invariants, candidate/main confidence gate, heap/source-size limits, and explicit adopted/rejected terminal states.

- [ ] **Step 2: Write the coverage ledger**

Use obligations `METRIC-PRIMARY`, `METRIC-AUX`, `SWAP-NATIVE`, `SWAP-FALLBACK`, `NODE-SEMANTICS`, `NODE-PERF`, `BIND-GENERALITY`, `BIND-PERF`, and `CLEANUP`. Property/fuzz/model tools are `not_applicable` because bounded table tests and real-browser checks cover the relevant state space.

- [ ] **Step 3: Record baseline behavior**

Record the initial full-suite timeout, focused 26/26 pass in 1.33s, and unchanged full-suite 63 files/697 tests pass. Do not modify the unrelated release test.

### Task 2: Add action-return and rendering-phase measurement contracts

**Files:**
- Modify: `benchmark/local-compare/run-local-compare.ts`
- Modify: `benchmark/local-compare/report.ts`
- Modify: `benchmark/local-compare/validation.ts`
- Test: `tests/local-compare-report.test.ts`
- Test: `tests/local-compare-validation.test.ts`
- Test: `tests/local-compare-runner-contract.test.ts`

- [ ] **Step 1: Write RED tests for auxiliary raw samples**

Require every operation summary to retain the existing frame values plus raw `actionReturnMs`, `styleMs`, `layoutMs`, and `paintMs` arrays with the same measured sample count. Reject non-finite values, missing arrays, and contradictory derived summaries.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run tests/local-compare-report.test.ts tests/local-compare-validation.test.ts tests/local-compare-runner-contract.test.ts`
Expected: FAIL because auxiliary phase samples are absent.

- [ ] **Step 3: Implement out-of-band phase collection**

Keep the existing click-to-two-frames expression unchanged. Collect trace events around each measured iteration from the runner/CDP side, derive synchronous action-return and Style/Layout/Paint durations, and store raw values plus units. Missing trace categories produce an explicit zero only when the trace window was valid; an invalid window rejects the sample.

- [ ] **Step 4: Verify GREEN**

Run the focused tests and confirm all pass without application hooks or runtime API changes.

- [ ] **Step 5: Commit**

```bash
git add benchmark/local-compare/run-local-compare.ts benchmark/local-compare/report.ts benchmark/local-compare/validation.ts tests/local-compare-report.test.ts tests/local-compare-validation.test.ts tests/local-compare-runner-contract.test.ts
git commit -m "feat: record local benchmark rendering phases"
```

### Task 3: Gate measurement overhead

**Files:**
- Modify locally: `docs.local/benchmark-evidence/2026-07-12-performance-candidates/metrics/*`
- Modify locally: `docs.local/logs/2026-07-12/2026-07-12-006-evidence-gated-performance-candidates.md`

- [ ] **Step 1: Capture instrumented and uninstrumented fresh-process runs**

Use Port Registry, counterbalanced order, identical production workload, and separate run-scoped files. Store every artifact directly in the root workspace.

- [ ] **Step 2: Evaluate the gate**

Retain instrumentation only if all frame-complete operation median ratios stay within `0.99..1.01`, raw phase arrays validate, and the phase decomposition distinguishes script from rendering work. Otherwise revert Task 2 and close issue 009 as rejected.

- [ ] **Step 3: Commit the retained contract or the clean revert disposition**

Never retain a partial metric implementation after a failed gate.

### Task 4: Implement real-browser keyed-row state tests

**Files:**
- Create: `tests/keyed-rows-browser.test.ts`
- Modify: `tests/keyed-rows.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write RED native/fallback browser scenarios**

Cover forward adjacent, reverse adjacent, distant, same, and invalid swaps. Assert order, identity, selected class, input value, `activeElement`, selection range, scroll position, and blur/focus event counts. Exercise a native `moveBefore` path and a forced fallback path.

- [ ] **Step 2: Verify RED**

Run the focused Chromium suite through Port Registry. Expected: current `insertBefore` path cannot satisfy the native-state-preservation scenario without manual focus and does not expose native/fallback move counts.

- [ ] **Step 3: Preserve existing jsdom coverage**

Keep unit tests for external DOM mutation, selected identity, and fallback behavior; browser tests add state coverage rather than replacing unit coverage.

### Task 5: Evaluate keyed-row `moveBefore()`

**Files:**
- Modify: `src/runtime/keyed-rows.ts`
- Modify: `tests/keyed-rows.test.ts`
- Modify: `tests/keyed-rows-browser.test.ts`
- Modify locally: `docs.local/benchmark-evidence/2026-07-12-performance-candidates/move-before/*`

- [ ] **Step 1: Implement the minimal native helper**

Feature-detect callable `tbody.moveBefore`. Use it for atomic moves; catch only `HierarchyRequestError` and fall back. Keep manual focus restoration only on fallback. Reduce reverse-adjacent swapping to one move and avoid self-insertion.

- [ ] **Step 2: Verify correctness GREEN**

Run jsdom and Chromium swap suites. Both native and fallback paths must pass all state assertions.

- [ ] **Step 3: Capture candidate/main benchmark evidence**

Compare swap action-return and frame-complete raw samples in counterbalanced fresh processes. Record heap and source-size guardrails.

- [ ] **Step 4: Adopt or reject**

Adopt if native Chromium state preservation improves without regression, or performance upper95 is below `1.00`; require heap/source-size non-regression. If rejected, revert the source/test implementation but retain browser characterization that applies to current behavior.

- [ ] **Step 5: Commit the disposition**

Use `feat: preserve keyed row state during native moves` when adopted, or a docs/local-only rejection record when removed.

### Task 6: Characterize Node handler construction semantics

**Files:**
- Modify: `tests/router-adapters.test.ts`
- Create: `benchmark/node-handler/run-node-handler-benchmark.ts`
- Create: `benchmark/node-handler/aggregate.ts`
- Test: `tests/node-handler-benchmark.test.ts`

- [ ] **Step 1: Write RED multi-request tests**

Fix static route precedence, static traversal rejection, security headers, observability adapter name, abort/cancel propagation, streaming metadata, and top-level options capture across multiple requests.

- [ ] **Step 2: Write RED benchmark-contract tests**

Require raw no-delay samples, warmups, run ID, seed, run index, candidate/main order, manifest, compatible controls, and confidence-bound aggregate output.

- [ ] **Step 3: Implement the focused benchmark harness**

Measure handler creation separately from no-delay request handling. Do not include an intentional stream delay or network server unless the integration path requires it.

- [ ] **Step 4: Commit characterization and harness**

```bash
git add tests/router-adapters.test.ts benchmark/node-handler tests/node-handler-benchmark.test.ts
git commit -m "test: characterize node handler construction"
```

### Task 7: Evaluate Node handler hoisting

**Files:**
- Modify: `src/adapters/node.ts`
- Modify: `tests/router-adapters.test.ts`
- Modify locally: `docs.local/benchmark-evidence/2026-07-12-performance-candidates/node-handler/*`

- [ ] **Step 1: Hoist immutable helpers at factory creation**

Create the static asset handler, normalized observability, and Workers handler once in `createNodeHandler()`. Keep request URL/body/abort and response work request-scoped.

- [ ] **Step 2: Verify adapter GREEN**

Run router adapter and benchmark-contract tests, including multiple request, cancellation, backpressure, security header, and options-capture scenarios.

- [ ] **Step 3: Run Security Specialist review**

Record `Must Fix / Should Fix / Notes`. Any Must Fix rejects adoption until resolved.

- [ ] **Step 4: Capture candidate/main no-delay runs**

Use fresh processes and counterbalanced order. Adopt only when upper95 is below `1.00` and scored web smoke plus adapter tests do not regress.

- [ ] **Step 5: Commit or revert**

Commit `perf: hoist node adapter handlers` only after the gate; otherwise restore `src/adapters/node.ts` and retain evidence locally.

### Task 8: Determine whether bind-target caching is generalizable

**Files:**
- Modify: `tests/keyed-rows.test.ts`
- Modify locally: `docs.local/issues/open/2026-07-12-012-keyed-rows-bind-target-cache.md`

- [ ] **Step 1: Write adversarial bind characterization**

Cover arbitrary nested markup, attribute/class/form writes, bind callbacks that retain a template-row child during the callback, chunk geometry changes, partial chunks, and external live-row mutation.

- [ ] **Step 2: Evaluate API feasibility before source edits**

Reject any design requiring fixture selectors, known column indices, a new benchmark-only callback, or cached live rows. Record whether stable template targets can be exposed without changing the public bind contract.

- [ ] **Step 3: Stop or proceed**

If no general mechanism exists, close issue 012 as rejected with no runtime patch. If feasible, continue to Task 9.

### Task 9: Evaluate bounded bind-target caching if feasible

**Files:**
- Modify if Task 8 passes feasibility: `src/runtime/keyed-rows.ts`
- Modify if Task 8 passes feasibility: `tests/keyed-rows.test.ts`
- Modify locally: `docs.local/benchmark-evidence/2026-07-12-performance-candidates/bind-targets/*`

- [ ] **Step 1: Write the RED cache lifecycle tests**

Require cache creation with chunk geometry, invalidation on geometry change, no references to inserted live rows, and correct partial-chunk content.

- [ ] **Step 2: Implement only the bounded template cache**

Cache stable nodes inside reusable template rows and discard them with the chunk. Do not add live-row or item arrays.

- [ ] **Step 3: Capture bulk candidate/main runs**

Measure 10,000-row creation and full replacement with raw samples. Record create/append, ready/run/run-clear heap, local source size, and entry size.

- [ ] **Step 4: Adopt or reject**

Require upper95 below `1.00` for createMany or replace, no regression in the other, and all heap/size changes below 2%. Revert tracked candidate code on failure.

### Task 10: Final issue audit, verification, and review

**Files:**
- Move locally: `docs.local/issues/open/2026-07-12-009-*.md` through `012-*.md` to `docs.local/issues/closed/`
- Modify locally: `docs.local/logs/2026-07-12/2026-07-12-006-evidence-gated-performance-candidates.md`
- Create locally: `docs.local/benchmark-evidence/2026-07-12-performance-candidates/SHA256SUMS`

- [ ] **Step 1: Record each candidate disposition**

For each candidate state adopted/rejected, exact commits or revert, raw evidence, confidence result, correctness result, and guardrail result.

- [ ] **Step 2: Verify checksums and process cleanup**

Run `sha256sum -c`, confirm no Port Registry claims, and inspect task-owned server/browser/worker processes by exact path and arguments.

- [ ] **Step 3: Run repository verification**

Run: `pnpm lint && pnpm build && pnpm test`
Expected: lint exit zero with only documented pre-existing warnings, build success, all tests pass.

- [ ] **Step 4: Run clean-context review**

Provide the original request, adoption gates, final diff, candidate dispositions, test results, Security Specialist result, and durable evidence paths. Resolve every Critical or Important finding.

- [ ] **Step 5: Finalize tracked commits**

Do not stage `docs.local`, benchmark results, `.codex`, or the user's `docs/issues/`.
