# Four Open Issues Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the `agent-dag` skill to implement this plan task-by-task (it decides whether to use subagents and builds a Single-Writer Agent DAG). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close four open issues with fail-closed benchmark schemas, representative route-stream evidence, unambiguous whitespace policy types, and a documented/tested raw HTML stream contract.

**Architecture:** Decode and validate each benchmark's full runtime schema before comparison, then expose the exact verified controls. Route the Tachyon benchmark through `RouteDefinition.stream`, restrict tag whitespace options to `HtmlWhitespacePolicy`, and retain raw string streaming while documenting and property-testing explicit escaping. All source changes use RED-GREEN-REFACTOR and one writer.

**Tech Stack:** TypeScript, Vitest, parse5, Node streams, pnpm packaging, Playwright/Chromium, web-framework benchmark harness.

---

### Task 1: Extend the coverage ledger

**Files:**
- Modify: `.coverage-ledger/three-reopened-issues/coverage-ledger.md`
- Create: `.coverage-ledger/four-open-issues/coverage-ledger.md`

- [ ] **Step 1: Record benchmark and trust-boundary obligations**

Add `BENCH4-01` through `BENCH4-06`, `TYPE4-01` through `TYPE4-04`, and `TRUST-01` through `TRUST-05`. Map malformed decoded JSON, finite ratios, verified report identity, representative route fixture, installed-tarball negative probes, raw sink documentation, escaped attacker input, chunk order, and cancellation.

- [ ] **Step 2: Record bounded property campaigns**

Record a fixed seed and budgets of at least 256 benchmark JSON mutations and 256 attacker-text cases. Status remains `planned` until the commands succeed.

- [ ] **Step 3: Commit**

```bash
git add .coverage-ledger
git commit -m "test: model fourth issue coverage"
```

### Task 2: Validate streaming benchmark workload and measurements

**Files:**
- Modify: `benchmark/streaming-backpressure-compare.ts`
- Modify: `tests/streaming-backpressure-compare.test.ts`
- Create: `tests/benchmark-json-property.test.ts`

- [ ] **Step 1: Write named failing regressions**

Pass runtime-decoded objects with string `connections`, fractional or negative chunk controls, zero baseline denominators, `NaN`, and `Infinity`. Assert errors name the exact baseline or candidate field and no comparison object contains a non-finite ratio.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run tests/streaming-backpressure-compare.test.ts`

Expected: malformed controls are accepted or zero denominators produce non-finite ratios.

- [ ] **Step 3: Add benchmark-specific validators**

Define pure validators for positive finite integers, non-negative finite measurements, and positive ratio denominators. Validate both decoded envelopes before calling `compareBenchmarkEnvelopes()`.

```ts
const positiveInteger = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) > 0;

const positiveFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
```

Return or throw precise paths such as `baseline.workload.connections` and `candidate.measurements.peakQueuedBytes`.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm vitest run tests/streaming-backpressure-compare.test.ts`

Expected: all named cases pass.

- [ ] **Step 5: Add bounded malformed-JSON properties**

Use a deterministic seeded generator to mutate every required workload and measurement field with `null`, string, negative, fractional, zero, `NaN`, `Infinity`, missing, and valid boundary values. Assert every invalid case is rejected and every returned ratio is finite.

- [ ] **Step 6: Run properties and commit**

```bash
pnpm vitest run tests/benchmark-json-property.test.ts tests/streaming-backpressure-compare.test.ts
git add benchmark/streaming-backpressure-compare.ts tests/streaming-backpressure-compare.test.ts tests/benchmark-json-property.test.ts
git commit -m "fix: validate streaming benchmark schemas"
```

### Task 3: Complete local verified reporting

**Files:**
- Modify: `benchmark/local-compare/validation.ts`
- Modify: `benchmark/local-compare/aggregate.ts`
- Modify: `tests/local-compare-validation.test.ts`

- [ ] **Step 1: Write failing report regressions**

Assert valid `verifiedControls` contains Git commit, dirty state, working-tree hash, browser name/version, runtime, host, dependencies, and workload. Add malformed browser and malformed summary/auxiliary measurement cases decoded as `unknown`.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run tests/local-compare-validation.test.ts`

Expected: Git/browser fields are missing from the success report or malformed nested shapes pass.

- [ ] **Step 3: Validate and expose complete controls**

Add pure browser and measurement validators, retain the full verified Git and browser objects in `verifiedControls`, and print the same machine-readable object from the aggregator.

- [ ] **Step 4: Verify and commit**

```bash
pnpm vitest run tests/local-compare-validation.test.ts tests/benchmark-provenance.test.ts
git add benchmark/local-compare/validation.ts benchmark/local-compare/aggregate.ts tests/local-compare-validation.test.ts
git commit -m "fix: report complete benchmark provenance"
```

### Task 4: Route the benchmark fixture through the progressive API

**Files:**
- Modify: `benchmark/web-framework/fixtures/tachyon/server.ts`
- Modify: `tests/web-framework-fixtures.test.ts`
- Modify: `benchmark/web-framework/run-web-framework-benchmark.ts`

- [ ] **Step 1: Write a failing fixture contract test**

Assert the Tachyon fixture defines `/stream` with `stream: streamChunks`, includes it in the routes supplied to `createNodeHandler({ streaming: true })`, and does not call `writeNodeResponse(renderToResponse(streamChunks()), response)` from a custom server branch.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run tests/web-framework-fixtures.test.ts`

Expected: the fixture still contains the custom `/stream` bypass.

- [ ] **Step 3: Use `RouteDefinition.stream`**

Add a route:

```ts
{
  path: "/stream",
  render: () => "",
  stream: streamChunks,
}
```

Remove the manual URL branch and let every request flow through `routeHandler`. Preserve the existing delayed chunk generator.

- [ ] **Step 4: Record fixture identity**

Add a workload field identifying `tachyon-route-stream-node-adapter` so representative evidence is machine-readable.

- [ ] **Step 5: Verify and commit**

```bash
pnpm vitest run tests/web-framework-fixtures.test.ts tests/router-adapters.test.ts
git add benchmark/web-framework tests/web-framework-fixtures.test.ts
git commit -m "bench: exercise progressive route streaming"
```

### Task 5: Remove ambiguous legacy whitespace inputs

**Files:**
- Modify: `src/html-whitespace.ts`
- Modify: `src/app.ts`
- Modify: `src/vite.ts`
- Modify: `src/router.ts`
- Modify: `src/adapters/workers.ts`
- Modify: `src/adapters/node.ts`
- Modify: `src/adapters/lambda.ts`
- Modify: `tests/html-whitespace.test.ts`
- Modify: `tests/whitespace-policy-types.ts`
- Modify: `scripts/verify-whitespace-policy-types.mjs`
- Modify: `README.md`
- Modify: `docs/routing.md`

- [ ] **Step 1: Write failing source type probes**

Use `@ts-expect-error` for direct `"preserve"`/`"condense"`, literal-narrowed `TemplateWhitespacePolicy`, narrowed mutable variables, partial mixed unions, and `LegacyHtmlWhitespacePolicy` at app methods/helpers, Vite, router, Workers, Node, and Lambda. Keep positive `HtmlWhitespacePolicy` variables and current literals.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec tsc --noEmit --pretty false`

Expected: unused `@ts-expect-error` directives show legacy values are still accepted.

- [ ] **Step 3: Restrict public options**

Remove `CompatibleHtmlWhitespacePolicy` and generic legacy inference from public option containers and functions. Type every tag-normalization property directly as `HtmlWhitespacePolicy`. Keep deprecated runtime helper aliases only where they are not public tag-policy options.

```ts
export type TachyonAppDocumentOptions = {
  whitespace?: HtmlWhitespacePolicy;
  minify?: boolean;
};
```

Provide an explicitly named migration helper only if it accepts a dedicated legacy HTML compatibility type that cannot accept `TemplateWhitespacePolicy`; otherwise document the direct value mapping and require callers to choose the new literal themselves.

- [ ] **Step 4: Install and test the packed tarball**

Update `verify-whitespace-policy-types.mjs` to run `pnpm pack`, create a temporary consumer, install the tarball, and compile the same positive/negative probes using package exports rather than absolute `dist` paths.

- [ ] **Step 5: Update docs and runtime tests**

Replace legacy option examples with `preserve-tags`/`normalize-tags`. State the breaking migration explicitly and keep boolean deprecated aliases documented separately.

- [ ] **Step 6: Verify and commit**

```bash
pnpm build
pnpm verify:whitespace-types
pnpm vitest run tests/html-whitespace.test.ts tests/dx.test.ts
git add src tests/whitespace-policy-types.ts tests/html-whitespace.test.ts scripts/verify-whitespace-policy-types.mjs README.md docs/routing.md
git commit -m "fix: remove ambiguous whitespace policy inputs"
```

### Task 6: Document and property-test the trusted HTML stream contract

**Files:**
- Modify: `src/router.ts`
- Modify: `README.md`
- Modify: `docs/routing.md`
- Modify: `tests/router-advanced.test.ts`
- Create: `tests/router-stream-escaping-property.test.ts`

- [ ] **Step 1: Write failing documentation assertions**

Assert the API JSDoc and public docs state that chunks are raw HTML and adapters never escape them. Add a safe example using `escapeHtml(data)` and sanitizer guidance for intentionally accepted markup.

- [ ] **Step 2: Add bounded attacker-input properties**

Generate at least 256 seeded values containing tags, event attributes, malformed tags, entities, quotes, NUL/control characters, Unicode, and chunk splits. Stream `<p>${escapeHtml(value)}</p>`, parse the result, and assert the only element introduced by the application is the intended `p`; attacker text remains text content. Assert first-chunk ordering and pulled/unpulled cancellation remain unchanged.

- [ ] **Step 3: Verify RED**

Run: `pnpm vitest run tests/router-stream-escaping-property.test.ts`

Expected: documentation/source assertions fail before JSDoc and examples are added.

- [ ] **Step 4: Add the trust contract**

Update `RouteDefinition.stream` JSDoc, README security guidance, and routing documentation. Do not alter runtime escaping or buffering.

- [ ] **Step 5: Verify and commit**

```bash
pnpm vitest run tests/router-stream-escaping-property.test.ts tests/router-advanced.test.ts tests/router-security.test.ts
git add src/router.ts README.md docs/routing.md tests/router-advanced.test.ts tests/router-stream-escaping-property.test.ts
git commit -m "docs: define progressive stream HTML trust boundary"
```

### Task 7: Produce clean representative evidence

**Files:**
- Create: run-scoped JSON under `benchmark/web-framework/results/`
- Modify: `.coverage-ledger/four-open-issues/coverage-ledger.md`

- [ ] **Step 1: Commit every tracked source change**

Run `git status --short` and require no tracked or untracked task source files before benchmarking. Benchmark result output must be written only after provenance capture or be excluded from the dirty-tree calculation by the runner's existing sequence.

- [ ] **Step 2: Run the six-framework smoke from a clean commit**

Use OS-assigned ports through the benchmark harness. Run:

```bash
env -u PORT pnpm bench:web-framework:smoke
```

Expected: six fixtures succeed and the Tachyon workload identifies the route-stream adapter path. The result records clean Git metadata.

- [ ] **Step 3: Validate and preserve the run-scoped result**

Run a small JSON validation command or Vitest assertion proving schema v2, clean Git, non-null commit/tree hash, complete dependencies/runtime/host/browser/workload, and finite measurements. Never overwrite prior results.

- [ ] **Step 4: Update ledger and commit evidence**

```bash
git add benchmark/web-framework/results/<run-file>.json .coverage-ledger/four-open-issues/coverage-ledger.md
git commit -m "bench: record representative progressive stream evidence"
```

### Task 8: Security review, full verification, closure, merge, and push

**Files:**
- Create: `docs.local/logs/2026-07-11/2026-07-11-006-resolve-four-open-issues.md` in the repository root
- Move locally: four issue files from `docs.local/issues/open` to `closed`

- [ ] **Step 1: Run Security Specialist review**

Review raw stream sink documentation, escaping properties, benchmark trust, package installation, and migration behavior. Record Must Fix, Should Fix, and Notes. Resolve every Must Fix before continuing.

- [ ] **Step 2: Run full verification**

```bash
pnpm test
pnpm lint
pnpm build
pnpm verify:package
pnpm check:exports
pnpm check:size
pnpm audit --prod
pnpm verify:whitespace-types
pnpm verify:starters
```

Expected: all commands exit 0; record exact counts and pre-existing warnings.

- [ ] **Step 3: Perform clean-context review**

Provide only the original acceptance criteria, final diff, relevant files, and fresh test results. Resolve every Critical or Important finding.

- [ ] **Step 4: Close local issues and write the local log**

Append final evidence to each issue, move all four to `closed`, confirm the open directory is empty, and leave existing untracked `docs/issues/` untouched.

- [ ] **Step 5: Merge and push**

Fast-forward `fix/four-open-issues` into `main`, re-run focused tests and build on merged main, remove the worktree and branch, and push `main` to `origin/main`.
