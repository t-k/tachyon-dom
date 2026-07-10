# Resolve Five Open Issues Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the `agent-dag` skill to implement this plan task-by-task (it decides whether to use subagents and builds a Single-Writer Agent DAG). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five remaining issues by making template condensation, benchmark comparison, app policy propagation, streaming metadata, and static traversal coverage fail closed.

**Architecture:** Keep each boundary independent: compiler whitespace operates on the shared template tree, benchmark validation precedes comparison, app compilation receives a named compiler policy, streaming adapters receive only authoritative metadata, and static containment remains unchanged unless its new regression test fails. A single writer implements each vertical slice with a failing test, a minimal fix, targeted verification, and a commit.

**Tech Stack:** TypeScript, Vitest, Vite, Playwright, Node.js adapters, AWS Lambda adapters, Cloudflare Workers adapters, pnpm, OxLint, OxFmt.

---

### Task 1: Commit cross-platform static traversal coverage

**Files:**
- Modify: `tests/router-adapters.test.ts`

- [ ] **Step 1: Add literal and encoded backslash cases to the existing traversal table**

Add these entries beside the encoded slash traversal cases:

```ts
"/assets/..\\secret.txt",
"/assets/%2e%2e%5csecret.txt",
"/assets%5c%2e%2e%5csecret.txt",
```

Keep the existing assertions that every case returns 403 with body `Forbidden` and that the dynamic fetch handler is never called.

- [ ] **Step 2: Run the focused regression test**

Run:

```sh
pnpm vitest run tests/router-adapters.test.ts -t "rejects encoded static asset path traversal"
```

Expected: PASS. If a case fails, update only `staticAssetTraversalResponse()` path-separator handling in `src/adapters/node.ts` and rerun until all cases return 403.

- [ ] **Step 3: Commit the regression coverage**

```sh
git add tests/router-adapters.test.ts src/adapters/node.ts
git commit -m "test: cover backslash static traversal"
```

### Task 2: Preserve every supported raw or preformatted compiler context

**Files:**
- Modify: `tests/compiler.test.ts`
- Modify: `src/compiler/whitespace.ts`

- [ ] **Step 1: Write a failing protected-context matrix**

Add a test that compiles every protected element with `whitespace: "condense"` and verifies the shared server result and generated client/stream code preserve the newline:

```ts
it.each(["pre", "textarea", "script", "style", "xmp", "listing", "plaintext", "iframe", "noembed", "noframes"])(
  "preserves whitespace in the %s context for every compiler target",
  (tagName) => {
    const source = `<${tagName}>line one\n    line two</${tagName}>`;
    const result = compileTemplate(source, { whitespace: "condense" });
    if (!result.ok) throw new Error(result.error.message);

    expect(renderServerTemplate(result.value, {})).toContain("line one\n    line two");
    expect(result.value.client.templateHtml).toContain("line one\n    line two");
    expect(generateServerStreamModule(result.value)).toContain("line one\\n    line two");
  },
);
```

- [ ] **Step 2: Verify the new contexts fail before implementation**

Run:

```sh
pnpm vitest run tests/compiler.test.ts -t "preserves whitespace in the"
```

Expected: the six newly reported contexts fail because their newlines become spaces; the four existing contexts pass.

- [ ] **Step 3: Extend the conservative protected-element set**

Change `src/compiler/whitespace.ts` to:

```ts
const protectedTextElements = new Set([
  "iframe",
  "listing",
  "noembed",
  "noframes",
  "plaintext",
  "pre",
  "script",
  "style",
  "textarea",
  "xmp",
]);
```

Do not change condensation outside protected descendants.

- [ ] **Step 4: Run compiler and hydration regressions**

Run:

```sh
pnpm vitest run tests/compiler.test.ts tests/template-whitespace-production-hydration.test.ts
```

Expected: both files pass and production hydration still reuses the SSR element.

- [ ] **Step 5: Commit the compiler fix**

```sh
git add src/compiler/whitespace.ts tests/compiler.test.ts
git commit -m "fix: preserve raw template text contexts"
```

### Task 3: Reject incomplete benchmark schema-v2 artifacts

**Files:**
- Create: `benchmark/provenance-validation.ts`
- Modify: `benchmark/provenance.ts`
- Rename and modify: `benchmark/local-compare/aggregate.mjs` to `benchmark/local-compare/aggregate.ts`
- Modify: `package.json`
- Modify: `tests/benchmark-provenance.test.ts`

- [ ] **Step 1: Add failing missing-field and wrong-type tests**

Clone the valid fixture in `tests/benchmark-provenance.test.ts`, remove `provenance.runtime.node` from both sides, and assert:

```ts
expect(incomplete).toMatchObject({ compatible: false, legacyIncomplete: false });
expect(incomplete.invalidFields).toContain("baseline.provenance.runtime.node");
expect(incomplete.invalidFields).toContain("candidate.provenance.runtime.node");
```

Also set `workload.connections` to `undefined` on both sides and assert both required paths are invalid. Add one case with `logicalCpuCount: "8"` to prove structural type validation fails.

- [ ] **Step 2: Verify current comparison incorrectly accepts the fixtures**

Run:

```sh
pnpm vitest run tests/benchmark-provenance.test.ts
```

Expected: the new tests fail because two missing values compare equal.

- [ ] **Step 3: Implement the shared schema validator**

Create `benchmark/provenance-validation.ts` with a validator returning exact invalid paths:

```ts
export type BenchmarkValidation = { valid: true } | { valid: false; invalidFields: string[] };

export const validateBenchmarkEnvelope = (
  value: unknown,
  requiredValuePaths: readonly string[] = [],
): BenchmarkValidation => {
  const invalidFields = requiredBenchmarkFields
    .concat(requiredValuePaths)
    .filter((fieldPath) => !hasValidValueAtPath(value, fieldPath));
  return invalidFields.length === 0 ? { valid: true } : { valid: false, invalidFields };
};
```

Define validators for `schemaVersion`, benchmark name/version, captured timestamp, normalized command fields, git availability/commit/dirty/tree hash, Node/platform/arch/OS, hostname/CPU/count, dependencies, workload, and measurements. Nullable git values are valid only when `git.available === false`; otherwise commit, dirty, and tree hash must be concrete values.

- [ ] **Step 4: Make comparison fail closed before equality checks**

Extend `BenchmarkComparison` with `invalidFields: string[]`. Validate baseline and candidate using the union of `requiredEqualPaths` and `allowedDifferences`, prefix invalid paths with `baseline.` or `candidate.`, and return `compatible: false` when any schema-v2 field is invalid. Preserve `legacyIncomplete: true` only for non-v2 artifacts.

- [ ] **Step 5: Reuse validation in aggregation**

Convert the aggregator to TypeScript so it imports `validateBenchmarkEnvelope`. Validate every run with the aggregator control paths before reading workload or measurements. Update any package script or documentation invocation from `node .../aggregate.mjs` to `tsx .../aggregate.ts`.

- [ ] **Step 6: Run provenance and comparison tests**

Run:

```sh
pnpm vitest run tests/benchmark-provenance.test.ts tests/web-framework-report.test.ts
pnpm exec tsx benchmark/local-compare/aggregate.ts benchmark/local-compare/results/2026-07-10-keyed-validation-after.json
```

Expected: tests pass; the valid stored artifact is accepted; an incomplete temporary fixture is rejected with its missing path.

- [ ] **Step 7: Commit benchmark validation**

```sh
git add benchmark/provenance-validation.ts benchmark/provenance.ts benchmark/local-compare/aggregate.ts benchmark/local-compare/aggregate.mjs package.json tests/benchmark-provenance.test.ts
git commit -m "fix: reject incomplete benchmark provenance"
```

### Task 4: Apply template whitespace policy to standard applications

**Files:**
- Modify: `src/app.ts`
- Modify: `src/vite.ts`
- Modify: `src/cli.ts`
- Modify: `tests/dx.test.ts`
- Modify: `tests/tachyon-app-production-hydration.test.ts`

- [ ] **Step 1: Add failing direct-app policy tests**

Create a `defineApp()` fixture with formatted route source and `templateWhitespace: "condense"`, then assert `renderRoute()` contains no formatting newline. Create a temporary route directory and assert `loadRouteApp({ templateWhitespace: "condense" })` produces the same route HTML. Keep a preserve-default assertion.

- [ ] **Step 2: Verify the new option is rejected or ignored**

Run:

```sh
pnpm vitest run tests/dx.test.ts -t "template whitespace"
```

Expected: TypeScript or runtime assertions fail because `defineApp()` and `loadRouteApp()` do not pass compiler whitespace options.

- [ ] **Step 3: Thread the named compiler policy through app compilation**

Import `TemplateWhitespacePolicy` from `src/compiler/types.ts`. Add `templateWhitespace?: TemplateWhitespacePolicy` to `TachyonAppDefinition` and `TachyonAppPageFile`, and add it to `pagesFromRouteFiles()` options. Compile pages with:

```ts
const result = compileTachyonSfc(templateSource(page.template), {
  whitespace: page.templateWhitespace ?? definition.templateWhitespace ?? "preserve",
});
```

Ensure the renderer cache is scoped to the normalized page whose policy is fixed at app creation.

- [ ] **Step 4: Thread the policy through route loading and the generated starter**

Add `templateWhitespace?: TemplateWhitespacePolicy` to `TachyonRouteAppOptions`. Pass it to `pagesFromRouteFiles()` and `defineApp()`. Generate this standard configuration in `src/cli.ts`:

```ts
const templateWhitespace = "condense" as const;
const app = await loadRouteApp({
  lang: "en",
  routesDir: "src/routes",
  title: "Tachyon App",
  templateWhitespace,
});

export default defineConfig({
  plugins: [
    tachyonDom({ reactive: true, templateWhitespace }),
    tachyonApp(app, { appScript: "/src/client/main.ts" }),
  ],
});
```

- [ ] **Step 5: Extend packaged production hydration coverage**

Update the app production fixture to load formatted raw route source with `templateWhitespace: "condense"`. Assert SSR has condensed structure, hydration reuses the server element, click changes text, and keyed list insertion produces `A`, `B` without duplicate nodes.

- [ ] **Step 6: Run app, generator, and hydration tests**

Run:

```sh
pnpm vitest run tests/dx.test.ts tests/tachyon-app-production-hydration.test.ts tests/template-whitespace-production-hydration.test.ts
pnpm verify:starters
```

Expected: all tests and both generated starter entrypoint checks pass.

- [ ] **Step 7: Commit the app policy fix**

```sh
git add src/app.ts src/vite.ts src/cli.ts tests/dx.test.ts tests/tachyon-app-production-hydration.test.ts
git commit -m "fix: apply template whitespace in standard apps"
```

### Task 5: Commit authoritative streaming metadata before the body

**Files:**
- Modify: `src/router.ts`
- Modify: `tests/router-advanced.test.ts`
- Modify: `tests/router-adapters.test.ts`

- [ ] **Step 1: Add failing delayed metadata tests at the router boundary**

Create delayed GET and HEAD routes whose loader resolves after a timer and whose cache/headers functions return `no-store`, CSP, two cookies, and `Vary`. Add a delayed loader redirect. Assert the returned `RouteStreamResult.status` and `headers` already equal the final values before iterating chunks and that no fallback precedes redirect/error bodies.

- [ ] **Step 2: Add an adapter contract matrix**

Exercise Workers, Node, Lambda proxy, and Lambda streaming with delayed GET/HEAD cases. For each adapter assert the actual response has authoritative status, `Location`, `Cache-Control`, CSP, `Set-Cookie`, and `Vary`. Retain cancellation and backpressure assertions.

- [ ] **Step 3: Verify provisional metadata failures**

Run:

```sh
pnpm vitest run tests/router-advanced.test.ts tests/router-adapters.test.ts -t "streaming.*metadata|delayed.*streaming|authoritative"
```

Expected: delayed GET/HEAD cases expose status 200 and provisional private headers instead of the final metadata.

- [ ] **Step 4: Remove the non-authoritative zero-delay race**

Change `renderRouteStreamInternal()` to await `renderRouteInternal()` before creating `RouteStreamResult`. Build `status`, `headers`, head, resource hints, state, and body chunks from the same settled result. Keep `responseBody` handling for redirects and non-HTML responses. The safe result shape is:

```ts
const rendered = await renderRouteInternal(routes, request, streamingOptions);
if (!rendered.ok) return err(rendered.error);
const body = rendered.value.responseBody ?? rendered.value.html;
return ok({
  status: rendered.value.status,
  headers: rendered.value.headers,
  headHtml: rendered.value.headHtml,
  resourceHints: rendered.value.resourceHints,
  stateScript: rendered.value.stateScript,
  chunks: (async function* () {
    if (request.method !== "HEAD" && body) yield body;
  })(),
  final: Promise.resolve({
    status: rendered.value.status,
    headers: rendered.value.headers,
    headHtml: rendered.value.headHtml,
    resourceHints: rendered.value.resourceHints,
    stateScript: rendered.value.stateScript,
  }),
});
```

Do not emit a fallback before commit-critical metadata is known. Preserve the public `final` field for compatibility even though it now resolves immediately.

- [ ] **Step 5: Run router and all adapter suites**

Run:

```sh
pnpm vitest run tests/router-advanced.test.ts tests/router-adapters.test.ts tests/router-platform.test.ts
```

Expected: all metadata, CSRF, backpressure, cancellation, static route, and adapter cases pass. Update only obsolete early-fallback timing assertions to the authoritative-commit contract.

- [ ] **Step 6: Commit the streaming fix**

```sh
git add src/router.ts tests/router-advanced.test.ts tests/router-adapters.test.ts
git commit -m "fix: commit authoritative streaming metadata"
```

### Task 6: Verify, review, close issues, and integrate

**Files:**
- Modify: `README.md` or relevant public runtime documentation only where behavior changed
- Move: the five issue files from `docs.local/issues/open/` to `docs.local/issues/closed/` in the repository root
- Create: `docs.local/logs/2026-07-11/2026-07-11-NNN-resolve-five-open-issues.md` in the repository root

- [ ] **Step 1: Run formatter and lint**

```sh
pnpm exec oxfmt --write src tests benchmark package.json docs/superpowers
pnpm lint
```

Expected: no new lint errors or warnings.

- [ ] **Step 2: Run the complete deterministic verification set**

```sh
pnpm test
pnpm build
pnpm verify:package
pnpm check:exports
pnpm check:size
pnpm verify:starters
pnpm audit --prod
```

Expected: every command exits 0.

- [ ] **Step 3: Run bounded production smokes**

```sh
pnpm exec tsx benchmark/streaming-backpressure.ts --connections 2 --chunks 16 --chunk-bytes 4096 --drain-delay-ms 1 --label issue-close --output /tmp/tachyon-dom-stream-issue-close.json
pnpm exec tsx benchmark/web-framework/run-web-framework-benchmark.ts --smoke --output /tmp/tachyon-dom-web-framework-issue-close.json
```

Expected: real TCP queued bytes remain bounded and all six web-framework fixtures complete their production contract.

- [ ] **Step 4: Run required independent reviews**

Give the Security Specialist only the original acceptance criteria, final diff, relevant files, and exact test results. Record `Must Fix / Should Fix / Notes`. Give a separate clean-context reviewer the same inputs without writer reasoning. Fix every Must Fix and actionable correctness finding, then rerun targeted and full verification.

- [ ] **Step 5: Close the five local issues and write the Japanese work log**

Move each issue only after mapping all Acceptance Criteria to committed tests. Record commits, exact commands, results, benchmark provenance, review outcomes, remaining Should Fix items, and process cleanup in the root `docs.local` log. Do not touch the untracked public `docs/issues/` directory.

- [ ] **Step 6: Commit final public documentation changes**

```sh
git add README.md docs src tests benchmark package.json
git commit -m "docs: document safe rendering contracts"
```

Skip this commit when no tracked public documentation changed.

- [ ] **Step 7: Merge into main and verify the integrated tree**

From the repository root, merge `fix/resolve-five-open-issues` into `main` without rewriting unrelated work. Run `pnpm test` and `pnpm build` on main, confirm only the pre-existing untracked `docs/issues/` remains, and remove the worktree after verification.
