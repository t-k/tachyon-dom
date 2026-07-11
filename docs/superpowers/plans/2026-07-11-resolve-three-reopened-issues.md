# Three Reopened Issues Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the `agent-dag` skill to implement this plan task-by-task (it decides whether to use subagents and builds a Single-Writer Agent DAG). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three reopened issues by enforcing authoritative benchmark provenance, preserving semantic HTML whitespace while restoring progressive route bodies, and separating template and tag whitespace policy types.

**Architecture:** Keep shared provenance structure validation in `benchmark/provenance-validation.ts` and layer benchmark-specific required paths and identities at each comparator. Track compiler preservation as inherited semantic state, add a metadata-first `stream` route callback without changing buffered `render`, and enforce legacy whitespace compatibility through literal-preserving generic option types. Use named regressions plus PICT-generated combinations and bounded deterministic properties.

**Tech Stack:** TypeScript, Vitest, parse5, PICT, pnpm, OxLint/OxFmt, Node Web Streams and AsyncIterable.

---

### Task 1: Create the coverage ledger and generated HTML matrix

**Files:**

- Create: `.coverage-ledger/three-reopened-issues/coverage-ledger.md`
- Create: `.coverage-ledger/three-reopened-issues/html-whitespace.pict`
- Create: `.coverage-ledger/three-reopened-issues/html-whitespace-cases.tsv`
- Create: `.coverage-ledger/three-reopened-issues/html-whitespace-cases.md`

- [ ] **Step 1: Record specifications and obligations**

Write obligations `BENCH-01` through `BENCH-05`, `HTML-01` through `HTML-06`, `STREAM-01` through `STREAM-06`, and `TYPE-01` through `TYPE-04`. Map each acceptance criterion from the three issue files to a named regression, generated case, property, packaged typecheck, or verification command. Mark PICT as `executed` only after Step 3 succeeds.

- [ ] **Step 2: Write the pairwise model**

```text
Context: ordinary, title, pre, svg_text, math_text, foreign_object
Policy: preserve, condense
Target: client, server, stream
Whitespace: newline_indent, crlf_indent, spaces_only, inline_spaces
XmlSpace: absent, preserve, default

IF [Context] <> "svg_text" AND [Context] <> "math_text" THEN [XmlSpace] = "absent";
IF [Context] = "title" OR [Context] = "pre" THEN [XmlSpace] = "absent";
```

- [ ] **Step 3: Generate and render PICT cases**

Run:

```bash
pict .coverage-ledger/three-reopened-issues/html-whitespace.pict /o:2 > .coverage-ledger/three-reopened-issues/html-whitespace-cases.tsv
python3 /home/tk/.agents/skills/coverage-ledger/scripts/pict_tsv_to_markdown.py .coverage-ledger/three-reopened-issues/html-whitespace-cases.tsv > .coverage-ledger/three-reopened-issues/html-whitespace-cases.md
```

Expected: exit 0 and a non-empty TSV containing all five columns.

- [ ] **Step 4: Commit the executable coverage artifacts**

```bash
git add .coverage-ledger/three-reopened-issues
git commit -m "test: model reopened issue coverage"
```

### Task 2: Reject incomplete benchmark provenance

**Files:**

- Modify: `tests/benchmark-provenance.test.ts`
- Modify: `benchmark/provenance-validation.ts`
- Modify: `benchmark/provenance.ts`

- [ ] **Step 1: Write failing schema-v2 regressions**

Add tests that compare two otherwise identical envelopes after setting `workload.iterations = null`, `provenance.runtime.node = null`, or `provenance.dependencies.tsx = { version: null, reason: "not found" }`. Assert `compatible === false` and assert both baseline and candidate invalid-field paths. Keep the existing legacy-envelope assertion unchanged.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run tests/benchmark-provenance.test.ts`

Expected: FAIL because null required values and unavailable dependency versions currently pass validation.

- [ ] **Step 3: Add availability-aware required-path validation**

Introduce comparator-supplied required validators rather than treating mere presence as validity. Use positive integers for iteration controls, non-empty strings for identities, typed arrays for implementation sets, and available dependency records whose versions are non-empty strings. Keep nullable Git fields valid in the base schema when `git.available === false`; comparison authority continues to reject unavailable Git metadata separately.

```ts
export type BenchmarkRequiredField = {
  path: string;
  validate: (value: unknown) => boolean;
};

export const availableDependencies = (value: unknown): boolean =>
  isRecord(value) &&
  Object.keys(value).length > 0 &&
  Object.values(value).every((dependency) => isRecord(dependency) && nonEmptyString(dependency.version));
```

- [ ] **Step 4: Verify GREEN and existing compatibility**

Run: `pnpm vitest run tests/benchmark-provenance.test.ts tests/streaming-backpressure-compare.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/benchmark-provenance.test.ts benchmark/provenance-validation.ts benchmark/provenance.ts
git commit -m "fix: reject unavailable benchmark provenance"
```

### Task 3: Validate benchmark identities and report verified controls

**Files:**

- Create: `benchmark/local-compare/validation.ts`
- Create: `tests/local-compare-validation.test.ts`
- Modify: `benchmark/local-compare/aggregate.ts`
- Modify: `benchmark/streaming-backpressure-compare.ts`
- Modify: `benchmark/html-minification.ts`

- [ ] **Step 1: Write failing local-comparison tests**

Test a pure `validateLocalCompareRuns()` function with valid artifacts, mismatched `workload.candidate`, a candidate missing or duplicated in `workload.implementations`, mismatched `workload.baseline`, a baseline missing or duplicated in implementations, empty or duplicate implementations, and wrong benchmark name. Assert invalid identity paths and a verified summary containing runtime, dependencies, host, and workload.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run tests/local-compare-validation.test.ts`

Expected: FAIL because the module and pure validator do not exist.

- [ ] **Step 3: Implement comparator-specific validation**

Move local required validators into `validation.ts`, validate `benchmark.name === "local-compare"`, require distinct non-empty baseline and candidate identities, require each to appear exactly once in a non-empty unique implementation list, and compare both identities across every run. Return a `Result` containing typed runs and a machine-testable verified-controls object.

- [ ] **Step 4: Print verified controls before measurements**

Update the aggregate report to print baseline and candidate identities, Git tree identity, Node/platform/CPU controls, dependency versions, and workload controls after validation succeeds. Apply the same benchmark-specific required-field pattern to streaming, including subject Git availability, commit, tree hash, and precise structural error paths. Treat HTML minification as a same-process algorithm comparison, not a revision comparison: remove the arbitrary baseline-revision claim and report the two algorithm identities plus current checkout provenance and workload.

- [ ] **Step 5: Verify GREEN**

Run: `pnpm vitest run tests/local-compare-validation.test.ts tests/benchmark-provenance.test.ts tests/streaming-backpressure-compare.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add benchmark/local-compare benchmark/streaming-backpressure-compare.ts benchmark/html-minification.ts tests/local-compare-validation.test.ts
git commit -m "fix: verify benchmark identities and controls"
```

### Task 4: Preserve semantic compiler whitespace

**Files:**

- Modify: `tests/compiler-whitespace.test.ts`
- Create: `tests/compiler-whitespace-property.test.ts`
- Modify: `src/compiler/whitespace.ts`

- [ ] **Step 1: Write named failing regressions**

Add exact-output tests for `<title>line one\n  line two</title>`, `<svg><text xml:space="preserve">one\n  two</text></svg>`, inherited SVG preservation, and `<g xml:space="default">` reset. Exercise client, server, and stream compilation targets.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run tests/compiler-whitespace.test.ts`

Expected: FAIL for `title` and SVG preservation.

- [ ] **Step 3: Implement inherited preservation state**

Replace the boolean recursion parameter with a state describing protected HTML text, foreign-content namespace, and XML-space inheritance. Add `title` to protected text elements. In SVG and MathML descendants only, read a static literal `xml:space` attribute case-sensitively: `preserve` enables preservation, `default` disables inherited XML preservation, and absent inherits the parent state. Dynamic expression values, unknown values, spread-derived values, and case variants do not change compile-time state. `foreignObject` returns descendants to HTML context. Protected HTML elements remain protected regardless of XML reset.

```ts
type WhitespaceContext = {
  protectedHtmlText: boolean;
  foreignContent: "html" | "svg" | "math";
  xmlSpace: "default" | "preserve";
};
```

- [ ] **Step 4: Verify GREEN**

Run: `pnpm vitest run tests/compiler-whitespace.test.ts`

Expected: PASS.

- [ ] **Step 5: Add bounded property coverage**

Implement a deterministic seeded generator with a fixed budget of at least 128 cases. Generate context, newline form, indentation width, policy, and target combinations. Assert protected content is byte-identical, ordinary newline indentation condenses under `condense`, `preserve` is invariant, and all three targets agree for static templates. Include the seed and failing case index in assertion messages.

- [ ] **Step 6: Run the bounded properties**

Run: `pnpm vitest run tests/compiler-whitespace-property.test.ts`

Expected: PASS with a fixed case count.

- [ ] **Step 7: Commit**

```bash
git add src/compiler/whitespace.ts tests/compiler-whitespace.test.ts tests/compiler-whitespace-property.test.ts
git commit -m "fix: preserve semantic template whitespace"
```

### Task 5: Add metadata-first progressive route bodies

**Files:**

- Modify: `src/router.ts`
- Modify: `src/adapters/workers.ts`
- Modify: `tests/router-advanced.test.ts`
- Modify: `tests/router-adapters.test.ts`
- Modify: `tests/workers-binding-types.ts`

- [ ] **Step 1: Write failing progressive-stream regressions**

Define a route with buffered `render` plus a `stream` async generator that yields `"first"`, waits on a test-controlled promise, then yields `"second"`. Assert `renderRouteStream()` resolves authoritative status and headers before starting body iteration, the first chunk is observable before the second is released, and `renderRoute()` still uses buffered `render`. Add `HEAD`, redirect, middleware/loader response, 404, CSRF rejection, and loader-error coverage proving the stream callback is not started. Add synchronous callback throw, throw before first yield, throw after first yield, pulled cancellation, and unpulled cancellation tests.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run tests/router-advanced.test.ts tests/router-adapters.test.ts`

Expected: FAIL because `RouteDefinition.stream` is absent and the current implementation emits one buffered chunk.

- [ ] **Step 3: Separate route preparation from body rendering**

Extract the loader/action/match and metadata computation needed by both buffered and streaming paths. Add:

```ts
export type RouteChunkSource = AsyncIterable<string>;

export type RouteDefinition<Data = unknown, ActionResult = unknown> = {
  // existing fields
  stream?: (context: RouteContext<Data, ActionResult>) => RouteChunkSource;
  render: (context: RouteContext<Data, ActionResult>) => string | Promise<string>;
};
```

Also add `stream` to `RouteModule`, forward it from `routeFromModule()`, and add a bindings-aware `stream` signature to `WorkersRouteDefinition`. Streaming uses the deepest route's callback after loaders and metadata are resolved. Header/cache contexts use an empty outlet for progressive routes and this behavior is documented in the public type comment. Nested buffered layouts are applied only when no progressive callback exists; avoid inventing streaming layout composition in this change.

- [ ] **Step 4: Forward chunks without buffering**

Invoke the callback after metadata preparation but do not call `next()` until the consumer pulls `chunks`. A synchronous callback failure is handled by the existing error boundary and may produce an authoritative 500. For `HEAD` and non-success route outcomes, return an empty async iterable without invoking the callback. Let iteration errors reject without appending error HTML or exception text. Own the underlying iterator explicitly so `return()` propagates exactly once for both pulled and unpulled cancellation and does not begin the next chunk's work.

- [ ] **Step 5: Verify GREEN and metadata regressions**

Run: `pnpm vitest run tests/router-advanced.test.ts tests/router-adapters.test.ts tests/router-security.test.ts tests/workers-binding-types.ts`

Expected: PASS, including delayed redirects, CSP, multiple Set-Cookie, Vary, and no-store cases.

- [ ] **Step 6: Commit**

```bash
git add src/router.ts src/adapters/workers.ts tests/router-advanced.test.ts tests/router-adapters.test.ts tests/workers-binding-types.ts
git commit -m "feat: stream route bodies after metadata commit"
```

### Task 6: Enforce the whitespace policy type boundary

**Files:**

- Modify: `src/html-whitespace.ts`
- Modify: `src/app.ts`
- Modify: `src/vite.ts`
- Modify: `src/router.ts`
- Modify: `src/adapters/workers.ts`
- Modify: `src/adapters/node.ts`
- Modify: `src/adapters/lambda.ts`
- Create: `tests/whitespace-policy-types.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write failing source and package type tests**

Compile snippets that pass direct `"preserve"` and `"condense"` literals and `HtmlWhitespacePolicy` variables to app object methods, standalone app helpers, Vite, router, Workers, Node, and Lambda APIs. Compile negative snippets with `TemplateWhitespacePolicy` and `LegacyHtmlWhitespacePolicy` variables plus `@ts-expect-error`; assert TypeScript reports an unused directive before the fix and no diagnostic after the boundary is enforced. Repeat against the packed package declarations.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run tests/whitespace-policy-types.test.ts`

Expected: FAIL because a `TemplateWhitespacePolicy` variable is currently assignable.

- [ ] **Step 3: Add a literal-preserving compatibility type**

```ts
export type CompatibleHtmlWhitespacePolicy<Value extends HtmlWhitespacePolicyInput> =
  TemplateWhitespacePolicy extends Value ? never : Value;
```

Make each public option container and every public function or object-method call signature that accepts it generic with a `const` type parameter defaulting to `HtmlWhitespacePolicy`. Type the property as `CompatibleHtmlWhitespacePolicy<Value>`. Verify inference independently for app helpers, `TachyonApp` methods, Vite, router, Workers, Node, and Lambda because a single non-generic boundary can either reject legacy literals or re-admit the wide union. Runtime normalization remains unchanged.

- [ ] **Step 4: Update public documentation**

Document that template whitespace controls text nodes, tag normalization controls syntax inside tags, direct legacy literals are accepted only for compatibility, and values intended to cross API boundaries should use `HtmlWhitespacePolicy`.

- [ ] **Step 5: Verify GREEN and package declarations**

Run: `pnpm vitest run tests/whitespace-policy-types.test.ts tests/html-whitespace.test.ts tests/dx.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src README.md tests/whitespace-policy-types.test.ts
git commit -m "fix: separate template and tag whitespace types"
```

### Task 7: Run security review and focused integration verification

**Files:**

- Create: `docs.local/logs/2026-07-11/2026-07-11-004-three-reopened-issues.md` in the repository root, not the worktree
- Modify: `.coverage-ledger/three-reopened-issues/coverage-ledger.md`

- [ ] **Step 1: Run focused verification**

Run:

```bash
pnpm vitest run tests/benchmark-provenance.test.ts tests/local-compare-validation.test.ts tests/compiler-whitespace.test.ts tests/compiler-whitespace-property.test.ts tests/router-advanced.test.ts tests/router-adapters.test.ts tests/router-security.test.ts tests/whitespace-policy-types.test.ts
pnpm lint
pnpm build
```

Expected: all commands exit 0.

- [ ] **Step 2: Perform Security Specialist review**

Review semantic HTML preservation, post-commit stream failures, authoritative metadata timing, CSP, cookies, cache headers, and `HEAD`. Record findings under `Must Fix`, `Should Fix`, and `Notes`. Fix and re-run focused tests for every Must Fix before continuing.

- [ ] **Step 3: Update the ledger and local work log**

Mark obligations with exact test or command evidence. Record PICT case count, property seed and budget, commits, security findings, benchmark results, and cleanup state. Do not stage the ignored local log.

- [ ] **Step 4: Commit tracked ledger updates**

```bash
git add .coverage-ledger/three-reopened-issues/coverage-ledger.md
git commit -m "docs: record reopened issue coverage"
```

### Task 8: Complete full verification and close local issues

**Files:**

- Move locally: `docs.local/issues/open/2026-07-10-benchmark-result-provenance.md`
- Move locally: `docs.local/issues/open/2026-07-10-safe-html-minification.md`
- Move locally: `docs.local/issues/open/2026-07-11-standard-app-template-whitespace-policy-not-applied.md`

- [ ] **Step 1: Run repository verification**

Run:

```bash
pnpm test
pnpm lint
pnpm build
pnpm check:package
pnpm check:exports
pnpm check:size
pnpm audit --prod
pnpm verify:starters
pnpm bench:web-framework:smoke
```

Expected: every command exits 0; record exact test and benchmark counts.

- [ ] **Step 2: Verify packaged entrypoints and browser hydration**

Run the existing packaged starter verification and real Chromium hydration checks used in the previous verification log. Claim and release any required port through Port Registry. Stop the browser and all child processes after completion.

- [ ] **Step 3: Check cleanup and repository state**

Confirm no task-owned server, browser, listener, child process, or Port Registry claim remains. Run `git status --short --branch`, `git diff --check`, and inspect every task commit.

- [ ] **Step 4: Close issues only after evidence is complete**

Move the three ignored local issue files from `open` to `closed`, append verification evidence to each, and confirm `docs.local/issues/open` contains no unresolved task issue. Preserve the existing untracked `docs/issues/` directory unchanged.

- [ ] **Step 5: Merge into main**

From the repository root, merge `fix/three-reopened-issues` into `main` with a non-interactive fast-forward when possible. Re-run the focused smoke on merged main and record the final main commit in the local work log.
