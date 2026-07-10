# Compiler-Aware HTML Whitespace Condensation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the `agent-dag` skill to implement this plan task-by-task (it decides whether to use subagents and builds a Single-Writer Agent DAG). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make opt-in compiler whitespace condensation reduce real Token Tracker production login HTML while preserving Tachyon hydration/runtime contracts and keeping streaming unbuffered.

**Architecture:** Add one target-neutral `TemplateWhitespacePolicy` pass between parsing and IR generation, then expose it through direct/SFC/Vite compiler entry points. Keep parse5-backed tag normalization narrowly named and separate. Token Tracker enables the compiler policy, compacts only separators introduced by its trusted document shell, and records a provenance-bearing benchmark against the real login document.

**Tech Stack:** TypeScript, Tachyon DOM compiler IR, Vite 8, Vitest, Playwright, parse5, Node zlib/performance APIs, pnpm.

---

## File Structure

### Tachyon DOM

- Create `src/compiler/whitespace.ts`: target-neutral policy types and recursive TextNode transformation.
- Modify `src/compiler/types.ts`: export `TemplateWhitespacePolicy` and compile options.
- Modify `src/compiler/index.ts`: policy-aware cache key and pass placement before IR/client lowering.
- Modify `src/compiler/sfc.ts`: forward compiler options through SFC compilation.
- Modify `src/diagnostics.ts`: allow Vite to diagnose/compile with the selected policy.
- Modify `src/vite.ts`: expose `templateWhitespace` and apply it consistently to client/server/stream transforms.
- Modify `src/html-whitespace.ts` and `src/app.ts`: accurately name tag-only normalization while retaining deprecated aliases.
- Modify `tests/compiler.test.ts`, `tests/dx.test.ts`, and `tests/html-whitespace.test.ts`: unit, target parity, Vite, and compatibility coverage.
- Modify `README.md` and `docs/routing.md`: distinguish compiler condensation, tag normalization, buffered documents, and streaming.
- Add a run-scoped result under `benchmark/html-minification-results/` only after a clean final commit.

### Token Tracker Console

- Modify `apps/console/src/server/document.ts`: add an explicit shell whitespace policy; production compacts only builder-owned separators.
- Modify `apps/console/src/server/routes.ts`: select production shell compaction without post-processing injected route/state/head fragments.
- Modify `apps/console/vite.config.ts`: enable `tachyonDom({ templateWhitespace: "condense" })` for all `.td` targets.
- Modify `apps/console/tests/document.test.ts`: RED/GREEN coverage for readable development and compact production documents.
- Modify compiler/Vite and production tests under `apps/console/tests/`: prove route template newlines are reduced and production bundle behavior is active.
- Create `apps/console/benchmark/html-condensation.ts`: real login-document before/after metrics with provenance.
- Create `apps/console/benchmark/results/2026-07-10-login-production.json`: run-scoped final measurement.
- Create `docs/logs/2026-07-10/2026-07-10-011-console-html-condensation.md`: Japanese work log committed in the private repository.

## Task 1: Reopen the Coverage Contract and Establish Baselines

**Files:**
- Move locally: `/home/tk/work/tachyon-dom/docs.local/issues/closed/2026-07-10-safe-html-minification.md` to `/home/tk/work/tachyon-dom/docs.local/issues/open/2026-07-10-safe-html-minification.md`
- Create locally: `/home/tk/work/tachyon-dom/docs.local/logs/2026-07-10/2026-07-10-008-compiler-whitespace-condensation.md`
- Create: `/home/tk/work/reckona/token-tracker/.worktrees/console-html-condense/docs/logs/2026-07-10/2026-07-10-011-console-html-condensation.md`

- [ ] **Step 1: Reopen and amend the local issue**

Append a verification note stating that the parse5 implementation changes only tag syntax, the 3,359-byte/66-newline production login document was unchanged, console production bypasses the helper, and the issue is reopened until the real fixture shows a non-zero reduction.

- [ ] **Step 2: Install isolated worktree dependencies**

Run in Tachyon DOM:

```bash
pnpm install --offline
pnpm build
pnpm test
```

Expected: baseline build and 53-file test suite pass.

For the console worktree, temporarily point its local `tachyon-dom` dependency at `/home/tk/work/tachyon-dom/.worktrees/compiler-whitespace-condense`, run `pnpm install --lockfile=false`, then restore the committed relative dependency declaration before any commit.

Run:

```bash
pnpm test
pnpm build
```

Expected: console baseline tests/build pass or any pre-existing failure is recorded before source changes.

- [ ] **Step 3: Record the exact zero-effect reproduction**

Run current `condenseHtmlWhitespace()` against the console login document fixture and record raw bytes, newline count, and equality in both work logs. Expected baseline: output equals input for already-normalized tag syntax.

## Task 2: Add the Target-Neutral Compiler Whitespace Pass

**Files:**
- Create: `src/compiler/whitespace.ts`
- Modify: `src/compiler/types.ts`
- Modify: `src/compiler/index.ts`
- Test: `tests/compiler.test.ts`

- [ ] **Step 1: Write failing compiler policy tests**

Add tests that call the wished-for API:

```ts
const preserved = compileTemplate(source, { whitespace: "preserve" });
const condensed = compileTemplate(source, { whitespace: "condense" });
```

Assert:

```ts
expect(renderServerTemplate(preserved.value, scope)).toContain("\n    <li>");
expect(renderServerTemplate(condensed.value, scope)).not.toContain("\n");
expect(renderServerTemplate(condensed.value, scope)).toContain("</li> <li>");
```

Add separate cases proving same-line `<span>Hello </span><strong>world</strong>`, non-ASCII whitespace, and `pre`/`textarea`/`script`/`style` content remain unchanged.

- [ ] **Step 2: Run RED**

Run:

```bash
pnpm exec vitest run tests/compiler.test.ts -t "template whitespace"
```

Expected: FAIL because `compileTemplate` does not accept the policy and indentation remains unchanged.

- [ ] **Step 3: Implement the minimal recursive pass**

Define:

```ts
export type TemplateWhitespacePolicy = "preserve" | "condense";
export type CompileTemplateOptions = { whitespace?: TemplateWhitespacePolicy };
```

Implement `applyTemplateWhitespace(root, policy)` in `src/compiler/whitespace.ts`. Recursively clone elements, propagate a protected-context flag for `pre`, `textarea`, `script`, and `style`, and transform only unprotected TextNodes:

```ts
const lineBreakWhitespace = /[\t\f\r ]*\n[\t\f\r \n]*/g;

const condenseText = (value: string): string => {
  if (!value.includes("\n") && !value.includes("\r")) return value;
  return value
    .replace(/^[\t\f\r ]*(?:\r?\n)[\t\f\r \n]*/, "")
    .replace(/[\t\f\r \n]*(?:\r?\n)[\t\f\r \n]*$/, "")
    .replace(lineBreakWhitespace, " ");
};
```

If a whitespace-only formatting node would become empty, return one ASCII space so adjacent inline words do not concatenate. Preserve `start`/`end` source ranges on cloned nodes.

In `compileTemplate()`, include the policy in the cache key, parse once, apply the pass, then create IR and client lowering from the transformed root.

- [ ] **Step 4: Run GREEN and full compiler tests**

Run:

```bash
pnpm exec vitest run tests/compiler.test.ts
```

Expected: all compiler tests pass, including new policy tests.

- [ ] **Step 5: Commit**

```bash
git add src/compiler/whitespace.ts src/compiler/types.ts src/compiler/index.ts tests/compiler.test.ts
git commit -m "feat: condense template formatting whitespace"
```

## Task 3: Thread the Policy Through SFC and Vite Targets

**Files:**
- Modify: `src/compiler/sfc.ts`
- Modify: `src/diagnostics.ts`
- Modify: `src/vite.ts`
- Test: `tests/dx.test.ts`

- [ ] **Step 1: Write failing SFC/Vite parity tests**

Compile one indented `.td` fixture through `?client`, `?server`, and `?stream` using:

```ts
const plugin = tachyonDom({ templateWhitespace: "condense" });
```

Assert every generated target lacks the source newline indentation, retains hydration marker/separator generation, and contains an explicit same-line word separator.

- [ ] **Step 2: Run RED**

Run:

```bash
pnpm exec vitest run tests/dx.test.ts -t "template whitespace"
```

Expected: FAIL because `templateWhitespace` is absent or ignored.

- [ ] **Step 3: Implement option forwarding**

Add `templateWhitespace?: TemplateWhitespacePolicy` to `TachyonDomViteOptions`. Add an optional compile options parameter to `compileTachyonSfc()` and `diagnoseTachyonSfc()`. In the Vite transform, compile the diagnostic/template using:

```ts
diagnoseTachyonSfc(source, { whitespace: options.templateWhitespace ?? "preserve" });
```

Do not implement separate per-target whitespace rewriting; all targets must consume the same transformed `CompiledTemplate`.

- [ ] **Step 4: Run GREEN and build**

Run:

```bash
pnpm exec vitest run tests/dx.test.ts tests/compiler.test.ts
pnpm build
```

Expected: tests and TypeScript declaration build pass.

- [ ] **Step 5: Commit**

```bash
git add src/compiler/sfc.ts src/diagnostics.ts src/vite.ts tests/dx.test.ts
git commit -m "feat: configure template whitespace in vite"
```

## Task 4: Correct the Tag-Normalization API and Documentation

**Files:**
- Modify: `src/html-whitespace.ts`
- Modify: `src/app.ts`
- Modify: `tests/html-whitespace.test.ts`
- Modify: `README.md`
- Modify: `docs/routing.md`

- [ ] **Step 1: Write the compatibility test**

Assert:

```ts
expect(normalizeHtmlTagWhitespace(source)).toBe(expected);
expect(condenseHtmlWhitespace(source)).toBe(expected);
expect(minifyHtml(source)).toBe(expected);
```

Also assert that all three helpers leave inter-element indentation unchanged, making the compatibility guarantee explicit.

- [ ] **Step 2: Run RED**

Run:

```bash
pnpm exec vitest run tests/html-whitespace.test.ts -t "tag normalization"
```

Expected: FAIL because `normalizeHtmlTagWhitespace` is not exported.

- [ ] **Step 3: Add the accurate name and aliases**

Export `normalizeHtmlTagWhitespace()` as the implementation. Keep:

```ts
/** @deprecated Use normalizeHtmlTagWhitespace. */
export const condenseHtmlWhitespace = normalizeHtmlTagWhitespace;
/** @deprecated Use normalizeHtmlTagWhitespace. */
export const minifyHtml = normalizeHtmlTagWhitespace;
```

Update public English documentation so `templateWhitespace: "condense"` is the only feature advertised as reducing template indentation. State that streaming uses compiler-produced chunks and never buffers the completed response.

- [ ] **Step 4: Run tests and package checks**

Run:

```bash
pnpm exec vitest run tests/html-whitespace.test.ts tests/compiler.test.ts tests/dx.test.ts
pnpm build
pnpm check:exports
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/html-whitespace.ts src/app.ts tests/html-whitespace.test.ts README.md docs/routing.md
git commit -m "docs: distinguish template condensation from tag normalization"
```

## Task 5: Enable Compact Production HTML in Token Tracker

**Files:**
- Modify: `apps/console/src/server/document.ts`
- Modify: `apps/console/src/server/routes.ts`
- Modify: `apps/console/vite.config.ts`
- Test: `apps/console/tests/document.test.ts`

- [ ] **Step 1: Write failing console document tests**

Add:

```ts
const readable = documentHtml(baseInput, { whitespace: "preserve" });
const compact = documentHtml(baseInput, { whitespace: "compact" });
expect(readable).toContain("\n");
expect(compact).not.toContain("</head>\n<body");
expect(compact).toContain(baseInput.body);
```

Add a test asserting `createHandleRequest()` selects compact shell output under the production environment without changing CSP nonce, state script, or route body bytes.

- [ ] **Step 2: Run RED**

Run from `apps/console`:

```bash
pnpm exec vitest run tests/document.test.ts -t "compact"
```

Expected: FAIL because `documentHtml` has no policy and always joins with newline.

- [ ] **Step 3: Implement trusted-shell compaction**

Add:

```ts
export type DocumentWhitespacePolicy = "preserve" | "compact";
export type DocumentOptions = { whitespace?: DocumentWhitespacePolicy };
```

Build the existing trusted segment array unchanged, then join with `options.whitespace === "compact" ? "" : "\n"`. Do not transform `headHtml`, `resourceHints`, `headerHtml`, route body, state script, or module script strings.

In `routes.ts`, pass `compact` only in production. In `vite.config.ts`, use:

```ts
tachyonDom({ templateWhitespace: "condense" })
```

- [ ] **Step 4: Run GREEN**

Run:

```bash
pnpm exec vitest run tests/document.test.ts
pnpm test
```

Expected: document and complete console tests pass.

- [ ] **Step 5: Commit in Token Tracker**

```bash
git add apps/console/src/server/document.ts apps/console/src/server/routes.ts apps/console/vite.config.ts apps/console/tests/document.test.ts
git commit -m "feat: 本番HTMLの空白を縮約"
```

## Task 6: Prove the Console Production Compiler Path

**Files:**
- Modify or create test under: `apps/console/tests/production-html.test.ts`
- Modify: `apps/console/tests/document.test.ts` if fixture helpers are shared

- [ ] **Step 1: Write a failing production build test**

Build the console into a temporary output directory using its real Vite config and the Tachyon DOM worktree dependency. Load or execute the production handler and request `/login`. Assert:

```ts
expect(html).not.toMatch(/\n\s+</);
expect(html).toContain("tachyon-hydrate:");
expect(html).toContain("<!---->");
```

Parse before/after documents and verify required marker IDs, CSP nonce attributes, form controls, and translated login strings remain present.

- [ ] **Step 2: Run RED**

Run:

```bash
pnpm exec vitest run tests/production-html.test.ts
```

Expected: FAIL before the console policy is wired or when a stale Tachyon dist is used.

- [ ] **Step 3: Build dependency order explicitly**

Run Tachyon `pnpm build`, verify `dist/compiler/whitespace.js` exists and emitted Vite declarations contain `templateWhitespace`, then build the console. Ensure the console worktree resolves `tachyon-dom` to `/home/tk/work/tachyon-dom/.worktrees/compiler-whitespace-condense`, not the stale root dist.

- [ ] **Step 4: Run GREEN and production browser coverage**

Run:

```bash
pnpm exec vitest run tests/production-html.test.ts
pnpm e2e --grep "login|hydration"
```

Expected: production HTML assertion and relevant browser scenarios pass. Stop every server/browser process after the run.

- [ ] **Step 5: Commit**

```bash
git add apps/console/tests/production-html.test.ts
git commit -m "test: 本番HTML縮約経路を固定"
```

## Task 7: Benchmark the Real Login Document

**Files:**
- Create: `apps/console/benchmark/html-condensation.ts`
- Create after clean commit: `apps/console/benchmark/results/2026-07-10-login-production.json`
- Modify: `apps/console/package.json`
- Test: add a small schema/compatibility test if benchmark utilities are extracted

- [ ] **Step 1: Write the benchmark contract test**

Require schema version, both repository revisions/dirty states, command/runtime/dependency provenance, fixture identity, raw/gzip/Brotli bytes, newline counts, duration, and semantic assertions. Reject dirty or missing provenance for the saved authoritative result.

- [ ] **Step 2: Run RED**

Run:

```bash
pnpm exec vitest run tests/html-condensation-benchmark.test.ts
```

Expected: FAIL because the benchmark runner/schema does not exist.

- [ ] **Step 3: Implement the runner**

Use the real login `documentHtml()` inputs and actual compiled login route fragment. Record `Buffer.byteLength`, `gzipSync`, `brotliCompressSync`, newline count, and repeated transformation/build time. Include Git metadata for both repositories and dependency versions. Save rather than overwrite a run-scoped JSON file.

- [ ] **Step 4: Produce clean before/after evidence**

Run the baseline from the pre-fix revisions and candidate from clean final revisions with identical fixture/build mode/iterations. Acceptance:

```ts
candidate.rawBytes < baseline.rawBytes
candidate.newlineCount < baseline.newlineCount
semanticAssertions.every((assertion) => assertion.passed)
```

- [ ] **Step 5: Commit runner, then clean result**

```bash
git add apps/console/benchmark/html-condensation.ts apps/console/tests/html-condensation-benchmark.test.ts apps/console/package.json
git commit -m "bench: login HTML縮約を計測"
# Run from the clean commit, then:
git add apps/console/benchmark/results/2026-07-10-login-production.json
git commit -m "bench: login HTML縮約結果を記録"
```

## Task 8: Final Verification, Security Review, and Integration

**Files:**
- Update: both work logs
- Move locally after acceptance: `docs.local/issues/open/2026-07-10-safe-html-minification.md` to `docs.local/issues/closed/`

- [ ] **Step 1: Run Tachyon DOM verification**

```bash
pnpm test
pnpm build
pnpm lint
pnpm verify:package
pnpm check:exports
pnpm check:size
pnpm audit --prod
```

Expected: all commands exit 0; only documented baseline warnings may remain.

- [ ] **Step 2: Run Token Tracker console verification**

```bash
bash scripts/check-console.sh
bash scripts/console-e2e.sh
bash scripts/check-file-size.sh
bash scripts/check-no-emoji.sh
```

Expected: all commands exit 0 and all processes terminate.

- [ ] **Step 3: Obtain required independent reviews**

Run a clean-context correctness review against the original acceptance criteria and a Security Specialist review for CSP nonce, hydration state, raw text, malformed HTML fallback, and production deployment boundaries. Any Security Must Fix blocks integration.

- [ ] **Step 4: Update coverage and logs**

Mark obligations covered only with exact test/result paths. Record revisions, commands, metrics, review results, stopped processes, and any non-blocking debt.

- [ ] **Step 5: Merge in dependency order**

First fast-forward the Tachyon feature branch into local Tachyon `main`. Then update/rebuild the console worktree against that main revision, fast-forward its feature branch into local Token Tracker `main`, and rerun the production smoke. Do not push or deploy without a separate request.

- [ ] **Step 6: Clean worktrees**

After both merges and final verification, remove the two clean worktrees and delete merged feature branches. Preserve unrelated root changes and the existing untracked Tachyon `docs/issues/` directory.
