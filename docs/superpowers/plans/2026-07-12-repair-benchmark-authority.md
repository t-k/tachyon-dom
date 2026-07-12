# Benchmark Authority Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the `agent-dag` skill to implement this plan task-by-task (it decides whether to use subagents and builds a Single-Writer Agent DAG). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make benchmark authority reproducible from durable raw samples, require complete deterministic position cycles, and re-audit the performance issue closures using newly captured evidence.

**Architecture:** Shared authority helpers own deterministic statistics, canonical artifact hashing, and complete-cycle validation. Local and web validators regenerate run plans from seed/run index, recompute summaries from raw samples, and fail closed before aggregate code calculates ratios. Benchmark runners emit self-verifying manifests, while root-workspace `docs.local` stores durable copies and issue evidence.

**Tech Stack:** TypeScript, Vitest, Node.js crypto/process APIs, Playwright benchmark runners, OxLint/OxFmt, pnpm.

---

### Task 1: Reopen authority-dependent issues and establish the coverage ledger

**Files:**
- Move: `docs.local/issues/closed/2026-07-12-001-benchmark-ranking-statistical-authority.md` to `docs.local/issues/open/2026-07-12-001-benchmark-ranking-statistical-authority.md`
- Move: `docs.local/issues/closed/2026-07-12-006-web-framework-stream-complete-fixture-parity.md` to `docs.local/issues/open/2026-07-12-006-web-framework-stream-complete-fixture-parity.md`
- Modify: `docs.local/issues/closed/2026-07-12-002-keyed-rows-partial-update-hot-path.md`
- Modify: `docs.local/issues/closed/2026-07-12-003-keyed-rows-far-swap-hot-path.md`
- Modify: `docs.local/issues/closed/2026-07-12-004-keyed-rows-remove-event-hot-path.md`
- Modify: `docs.local/issues/closed/2026-07-12-005-keyed-rows-clear-subtree-hot-path.md`
- Modify: `docs.local/issues/closed/2026-07-12-007-keyed-rows-select-semantics-preserving-hot-path.md`
- Modify: `docs.local/issues/closed/2026-07-12-008-keyed-rows-replace-and-bulk-build-profile.md`
- Create: `docs.local/logs/2026-07-12/2026-07-12-005-repair-benchmark-authority.md`

- [ ] **Step 1: Move issues 001 and 006 back to open in the root workspace**

Use `apply_patch` so ignored local issue history is explicit. Add a reopening note stating that stored aggregates are unauditable because raw artifacts are missing and raw/summary contradictions were accepted.

- [ ] **Step 2: Amend the no-change closure contract for issues 002–005, 007, and 008**

Record all four required facts: runtime cost was not dominant, no safe measurable runtime change was identified, forced wins would require benchmark-specific or semantics-weakening changes, and durable evidence is required. Mark the evidence-path obligation pending until Task 8.

- [ ] **Step 3: Write the coverage ledger in the work log**

Map obligations `AUTH-RAW-LOCAL`, `AUTH-RAW-WEB`, `AUTH-ORDER-LOCAL`, `AUTH-ORDER-WEB`, `AUTH-MANIFEST`, `AUTH-DURABLE`, and `ISSUE-AUDIT` to the tests and evidence tasks below. Property testing and fuzzing are `not_applicable`; deterministic fixtures cover the bounded schedule and canonical digest contracts.

- [ ] **Step 4: Confirm local-only files remain ignored**

Run: `git status --short --ignored docs.local`
Expected: issue and log changes appear only as ignored entries and are not staged.

### Task 2: Make raw statistics shared and authoritative

**Files:**
- Modify: `benchmark/shared/statistical-authority.ts`
- Test: `tests/statistical-authority.test.ts`

- [ ] **Step 1: Write failing tests for deterministic median and trimmed mean**

Add tests that require exported `median([40, 20, 30]) === 30`, even-count median interpolation, and `trimmedMean([10, 10, 11, 12, 200], 0.2) === 11` while rejecting empty, non-finite, or invalid-trim inputs.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run tests/statistical-authority.test.ts`
Expected: FAIL because the statistic helpers are not exported or do not validate inputs.

- [ ] **Step 3: Implement validated shared helpers**

Export `median(values)` and `trimmedMean(values, trimFraction)`. Both copy their input, reject invalid samples, and return deterministic numbers without consulting stored summaries.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm vitest run tests/statistical-authority.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add benchmark/shared/statistical-authority.ts tests/statistical-authority.test.ts
git commit -m "feat: derive authority statistics from raw samples"
```

### Task 3: Repair local raw-sample aggregation

**Files:**
- Modify: `benchmark/local-compare/aggregate-report.ts`
- Modify: `benchmark/local-compare/validation.ts`
- Test: `tests/local-compare-report.test.ts`
- Test: `tests/local-compare-validation.test.ts`

- [ ] **Step 1: Write RED tests for contradictory local summaries**

Create seven-run fixtures whose raw candidate values recompute to `21` but whose stored `trimmedMean` is `9`. Assert validation rejects the exact summary field and assert aggregate ratios cannot become `meaningful-win` from the forged summary.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run tests/local-compare-report.test.ts tests/local-compare-validation.test.ts`
Expected: the forged artifact is accepted or produces the forged winning ratio.

- [ ] **Step 3: Recompute local summaries from `values`**

Use the workload's `trimFraction` and shared `trimmedMean`. Validation compares the recomputed value to stored `trimmedMean` with a deterministic relative/absolute tolerance. `buildAuthoritativeScenarioRows` computes candidate and competitor values only from raw arrays.

- [ ] **Step 4: Verify GREEN and existing malformed-sample behavior**

Run: `pnpm vitest run tests/local-compare-report.test.ts tests/local-compare-validation.test.ts`
Expected: PASS, including NaN, undersampling, and forged-summary cases.

- [ ] **Step 5: Commit**

```bash
git add benchmark/local-compare/aggregate-report.ts benchmark/local-compare/validation.ts tests/local-compare-report.test.ts tests/local-compare-validation.test.ts
git commit -m "fix: recompute local authority from raw samples"
```

### Task 4: Repair web raw-sample aggregation

**Files:**
- Modify: `benchmark/web-framework/report.ts`
- Test: `tests/web-framework-report.test.ts`

- [ ] **Step 1: Convert the known contradictory fixture into a RED regression**

Keep raw `complete` samples at `21` and stored `streamCompleteMs` at `19.8`. Assert `analyzeWebStreamRuns` returns `ok: false` with a summary-mismatch reason. Add a separate valid fixture whose stored value is the raw median and verify its ratio is calculated from raw samples.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run tests/web-framework-report.test.ts`
Expected: the contradictory fixture is still accepted.

- [ ] **Step 3: Recompute web completion medians**

Use shared `median(metric.streamSamples.map(sample => sample.complete))`, reject stored-summary mismatches, and calculate candidate and competitor ratios from recomputed medians only.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm vitest run tests/web-framework-report.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add benchmark/web-framework/report.ts tests/web-framework-report.test.ts
git commit -m "fix: recompute web authority from stream samples"
```

### Task 5: Require deterministic complete position cycles

**Files:**
- Modify: `benchmark/shared/statistical-authority.ts`
- Modify: `benchmark/local-compare/run-plan.ts`
- Modify: `benchmark/local-compare/validation.ts`
- Modify: `benchmark/web-framework/workload.ts`
- Modify: `benchmark/web-framework/report.ts`
- Test: `tests/statistical-authority.test.ts`
- Test: `tests/local-compare-validation.test.ts`
- Test: `tests/web-framework-report.test.ts`

- [ ] **Step 1: Write RED schedule tests**

Assert six local runs fail; seven deterministic runs cover every implementation position exactly once; eight runs fail as an incomplete trailing cycle; a manually biased rotation fails; and an order altered after plan creation fails seed/run-index regeneration. Add equivalent seven-framework web tests. Add scenario tests for early/late count and mean-position limits.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run tests/statistical-authority.test.ts tests/local-compare-validation.test.ts tests/web-framework-report.test.ts`
Expected: partial and forged schedules currently pass.

- [ ] **Step 3: Implement complete-cycle helpers**

Add shared helpers that verify `runCount % itemCount === 0`, regenerate every order with `balancedOrder`, and require each item exactly once per position per cycle. Local validation regenerates implementation and scenario plans using `createLocalRunPlan`; web validation uses `createWebRunPlan`. Scenario distribution additionally checks early/late balance and mean position around the global center.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm vitest run tests/statistical-authority.test.ts tests/local-compare-validation.test.ts tests/web-framework-report.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add benchmark/shared/statistical-authority.ts benchmark/local-compare/run-plan.ts benchmark/local-compare/validation.ts benchmark/web-framework/workload.ts benchmark/web-framework/report.ts tests/statistical-authority.test.ts tests/local-compare-validation.test.ts tests/web-framework-report.test.ts
git commit -m "fix: require complete benchmark position cycles"
```

### Task 6: Add self-verifying artifact manifests

**Files:**
- Create: `benchmark/shared/artifact-manifest.ts`
- Modify: `benchmark/local-compare/run-local-compare.ts`
- Modify: `benchmark/local-compare/validation.ts`
- Modify: `benchmark/web-framework/run-web-framework-benchmark.ts`
- Modify: `benchmark/web-framework/report.ts`
- Test: `tests/artifact-manifest.test.ts`
- Test: `tests/local-compare-validation.test.ts`
- Test: `tests/web-framework-report.test.ts`

- [ ] **Step 1: Write RED digest and process-identity tests**

Require canonical key ordering, a stable SHA-256 excluding `manifest.sha256`, rejection after any raw-sample mutation, rejection of duplicate `(pid, processStartedAt)` identities, and acceptance of separately signed fixtures.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run tests/artifact-manifest.test.ts tests/local-compare-validation.test.ts tests/web-framework-report.test.ts`
Expected: FAIL because manifests are absent.

- [ ] **Step 3: Implement canonical signing and verification**

Create pure helpers `createArtifactManifest(value, processIdentity)` and `verifyArtifactManifest(value)`. Canonical JSON recursively sorts object keys, preserves array order, and omits only the digest field. Runners capture `process.pid` and an ISO process-start timestamp once, assemble the complete envelope, sign it, then write it.

- [ ] **Step 4: Integrate fail-closed validation**

Local and web authority validation reject missing/invalid digests and duplicate process identities before schedule or ratio analysis.

- [ ] **Step 5: Verify GREEN**

Run: `pnpm vitest run tests/artifact-manifest.test.ts tests/local-compare-validation.test.ts tests/web-framework-report.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add benchmark/shared/artifact-manifest.ts benchmark/local-compare/run-local-compare.ts benchmark/local-compare/validation.ts benchmark/web-framework/run-web-framework-benchmark.ts benchmark/web-framework/report.ts tests/artifact-manifest.test.ts tests/local-compare-validation.test.ts tests/web-framework-report.test.ts
git commit -m "feat: sign benchmark authority artifacts"
```

### Task 7: Update the public benchmark contract documentation

**Files:**
- Modify: `benchmark/local-compare/README.md`
- Modify: `benchmark/web-framework/README.md`

- [ ] **Step 1: Document raw authority and complete cycles**

State that raw arrays are authoritative, summaries are verified derivatives, local requires complete seven-run cycles, web requires complete framework-position cycles with a minimum of seven runs, orders are regenerated from seed/run index, and manifests are verified before aggregation.

- [ ] **Step 2: Verify documentation against executable constants and tests**

Run: `rg -n "five|5 runs|seven|raw|manifest|seed|run index" benchmark/local-compare/README.md benchmark/web-framework/README.md`
Expected: no stale five-run authority claim and all repaired contract elements are described.

- [ ] **Step 3: Commit**

```bash
git add benchmark/local-compare/README.md benchmark/web-framework/README.md
git commit -m "docs: define auditable benchmark authority"
```

### Task 8: Run fresh authority benchmarks and preserve durable evidence

**Files:**
- Create locally: `/home/tk/work/tachyon-dom/docs.local/benchmark-evidence/2026-07-12-authority-repair/local/*.json`
- Create locally: `/home/tk/work/tachyon-dom/docs.local/benchmark-evidence/2026-07-12-authority-repair/web/*.json`
- Create locally: `/home/tk/work/tachyon-dom/docs.local/benchmark-evidence/2026-07-12-authority-repair/local-aggregate.txt`
- Create locally: `/home/tk/work/tachyon-dom/docs.local/benchmark-evidence/2026-07-12-authority-repair/web-aggregate.txt`
- Create locally: `/home/tk/work/tachyon-dom/docs.local/benchmark-evidence/2026-07-12-authority-repair/SHA256SUMS`
- Modify locally: `docs.local/logs/2026-07-12/2026-07-12-005-repair-benchmark-authority.md`

- [ ] **Step 1: Claim benchmark ports and run seven fresh local processes**

Use `portctl.py run --` for every port-binding command. Execute run indices `0..6` with a fixed new seed, unique run IDs, production mode, five warmups, and thirty measured samples. Never resume an interrupted process as an authority run.

- [ ] **Step 2: Copy every completed local artifact immediately to root evidence storage**

After each run, verify its manifest and copy it to the durable root path before starting the next run.

- [ ] **Step 3: Run seven fresh web processes and copy each artifact immediately**

Use run indices `0..6`, fixed seed, unique run IDs, five warmups, twenty stream samples, and the same commit/tree/runtime/host/browser/dependency controls.

- [ ] **Step 4: Aggregate only the durable copies**

Run both aggregate CLIs against the root evidence paths. Save stdout to `local-aggregate.txt` and `web-aggregate.txt`. A rejected run is replaced by a new full process and retained separately as diagnostic evidence.

- [ ] **Step 5: Write evidence checksums and reproduction metadata**

Generate `SHA256SUMS` for raw JSON and aggregate text. Record exact commands, commit, tree digest, runtime, browser, start/end times, and interruption history in the work log.

- [ ] **Step 6: Release ports and verify process cleanup**

Release all claims, inspect exact benchmark/Vite/Chromium child processes, and stop only verified task-owned PIDs. Confirm no task-owned process remains.

### Task 9: Re-audit and close or retain issues from durable evidence

**Files:**
- Move or modify locally: `docs.local/issues/open/2026-07-12-001-benchmark-ranking-statistical-authority.md`
- Move or modify locally: `docs.local/issues/open/2026-07-12-006-web-framework-stream-complete-fixture-parity.md`
- Modify locally: `docs.local/issues/closed/2026-07-12-00{2,3,4,5,7,8}-*.md`
- Modify locally: `docs.local/logs/2026-07-12/2026-07-12-005-repair-benchmark-authority.md`

- [ ] **Step 1: Audit 001 and 006 against their repaired acceptance criteria**

Close 001 only if contradictory artifacts are rejected and durable raw files reproduce the published aggregates. Close 006 if semantic parity remains verified and the valid authority result is recorded, regardless of whether it is a win or statistical tie. Otherwise leave the issue open with the exact unmet criterion.

- [ ] **Step 2: Audit every no-change closure**

Replace pending evidence paths with durable trace/benchmark paths where evidence exists. Reopen any issue whose four-part no-change contract is not supported.

- [ ] **Step 3: Record the final issue matrix**

For each issue list classification, acceptance outcome, durable evidence, authority status, and open/closed decision in the work log.

### Task 10: Final verification and clean-context review

**Files:**
- Verify: `benchmark/shared/statistical-authority.ts`
- Verify: `benchmark/shared/artifact-manifest.ts`
- Verify: `benchmark/local-compare/validation.ts`
- Verify: `benchmark/local-compare/aggregate-report.ts`
- Verify: `benchmark/web-framework/report.ts`
- Verify: `tests/statistical-authority.test.ts`
- Verify: `tests/artifact-manifest.test.ts`
- Verify: `tests/local-compare-validation.test.ts`
- Verify: `tests/local-compare-report.test.ts`
- Verify: `tests/web-framework-report.test.ts`
- Modify locally: `docs.local/logs/2026-07-12/2026-07-12-005-repair-benchmark-authority.md`

- [ ] **Step 1: Run targeted authority tests**

Run: `pnpm vitest run tests/statistical-authority.test.ts tests/artifact-manifest.test.ts tests/local-compare-validation.test.ts tests/local-compare-report.test.ts tests/web-framework-report.test.ts tests/web-framework-contract.test.ts`
Expected: PASS.

- [ ] **Step 2: Run repository verification**

Run: `pnpm lint && pnpm build && pnpm test`
Expected: lint exits zero with only documented pre-existing warnings, build succeeds, and all tests pass.

- [ ] **Step 3: Re-run both aggregates from durable evidence**

Expected: both accept all seven runs, reproduce saved output, and report confidence values derived from raw samples.

- [ ] **Step 4: Request a clean-context review**

Provide only the original review requirements, design acceptance criteria, final diff, relevant files, test output, and durable aggregate paths. Resolve all Critical or Important findings before completion.

- [ ] **Step 5: Commit any review fixes and finalize the work log**

Use focused commits. Do not stage `docs.local`, generated benchmark results, `.codex`, or the user's untracked `docs/issues/`.
