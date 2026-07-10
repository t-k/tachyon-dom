# Open Issue Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the `agent-dag` skill to implement this plan task-by-task (it decides whether to use subagents and builds a Single-Writer Agent DAG). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the nineteen open issues with secure public contracts, real regression coverage, and valid measurements.

**Architecture:** Keep one single writer in the isolated worktree. Deliver five dependency-ordered batches: security, application/routing, runtime, compiler/type tooling, and benchmark semantics. Every behavior change follows a focused RED test, minimal production change, targeted GREEN verification, and a focused commit.

**Tech Stack:** TypeScript, Vitest, Vite, Node/Workers/Lambda adapters, Playwright/autocannon benchmark runner.

---

## Coverage Ledger

| Obligation | Risk | Primary proof | Secondary proof | Status |
| --- | --- | --- | --- | --- |
| Plain error fallback is text; trusted HTML is explicit | DOM XSS | `runtime-error-boundary` unit test | Security review | planned |
| Unknown memory ID cannot become authenticated | Session fixation | `router-security` rotation test | Custom ID generator test | planned |
| Omitted cache mode cannot share identity data | Data disclosure | router cache policy test | adapter response test | planned |
| CSRF token cannot cross sessions | Cross-session replay | two-session router action test | concurrent-request test | planned |
| Signed cookie has enforced expiry and documented revocation boundary | Replay after logout | injectable-clock test | key rotation test and docs check | planned |
| Asset path stays inside canonical root | File disclosure | symlink/dotfile test | fetch-adapter non-fallthrough test | planned |
| CLI conflicts make no partial change | Data loss | seeded add/init test | force output test | planned |
| Starter route is a real SFC and new pages resolve | Broken onboarding | Vite starter smoke test | generated scope change test | planned |
| App paths are unique and unknown paths are explicit | Soft 404 | duplicate and unknown-path tests | SSR status test | planned |
| Route module NotFound selects nearest valid boundary | Dead API | nested/wildcard route test | adapter 404 status test | planned |
| Workers callbacks receive typed invocation bindings | Platform integration | callback matrix adapter test | Node/Lambda typecheck | planned |
| Actions abort and stale results cannot win | Stale navigation | deferred submit tests | dispose and caller-signal tests | planned |
| Keyed-row controls terminate before mutation | Main-thread freeze | invalid-number tests | benchmark gate | planned |
| Resource source changes reload data | Stale UI | deferred accessor test | stale-result test | planned |
| Adapters obey downstream demand | Unbounded memory | Node/Workers/Lambda drain tests | throttled-client measurement | planned |
| `.td` declaration data stays synchronized | Unsound TypeScript | Vite/typecheck temp-project test | stale output removal test | planned |
| Semantic errors identify the offending range | Misleading diagnostics | compiler and LSP range tests | SFC offset test | planned |
| Dynamic and stream benchmark scenarios are semantic peers | Invalid ranking | fixture contract tests | new run-scoped smoke result | planned |

## Optional Verification Suggestions

- **PICT, medium:** derive combinations for session state, token provenance, expiry, key rotation, and cache mode. It would generate a matrix under `.coverage-ledger/`; status: `suggested_pending_approval`.
- **Small TLA+ model, medium:** model action submit/navigate/dispose ordering and prove a stale action cannot become the winner. It would create a bounded state-machine artifact; status: `suggested_pending_approval`.
- **Property-based numeric validation, medium:** generate invalid keyed-row numeric values and assert no DOM mutation; status: `suggested_pending_approval`.

These tools are not required to start the focused regression suite and will not run without separate approval.

## Batch 1: Security contracts

### Task 1: Share the trusted client HTML contract

**Files:** Modify `src/runtime/router.ts`, `src/runtime/error-boundary.ts`; test `tests/runtime-error-boundary.test.ts`.

- [ ] Write `renders ordinary fallback markup as text` and `renders rawHtml fallback as markup` tests.
- [ ] Run `pnpm vitest run tests/runtime-error-boundary.test.ts`; expect the plain-string assertion to fail because an `img` element is created.
- [ ] Extract the `ClientHtml` brand and renderer branch into a shared runtime helper, render strings through `textContent`, and accept only branded HTML, `Node`, or `DocumentFragment` as markup.
- [ ] Re-run the focused test and commit `fix: require trusted error boundary html`.

### Task 2: Rotate unknown memory-session identifiers

**Files:** Modify `src/cookies.ts`, `docs/routing.md`; test `tests/router-security.test.ts`.

- [ ] Add a deterministic-ID test that commits authenticated data after `sid=attacker-id` and proves the returned cookie has a different identifier.
- [ ] Run the focused security test; expect the attacker ID to restore authenticated data.
- [ ] Track identifier provenance internally, generate a new ID on commit for untrusted IDs, and expose `regenerateSession()` for explicit login or privilege rotation.
- [ ] Verify the focused test, normal restore, logout, and custom ID tests; commit `fix: rotate untrusted memory session ids`.

### Task 3: Make route cache sharing explicit

**Files:** Modify `src/router.ts`, `docs/routing.md`; test `tests/router-platform.test.ts`.

- [ ] Add a cache-policy test for `{ maxAge: 60 }` and a cookie-dependent loader response.
- [ ] Run it; expect `Cache-Control` to contain `public`.
- [ ] Make omitted mode private, require `mode: "public"` for shared caching, and document cache key and `Vary` obligations.
- [ ] Run focused platform tests and commit `fix: default route caching to private`.

### Task 4: Bind CSRF verification to the current request

**Files:** Modify `src/security.ts`, `src/router.ts`, `docs/routing.md`; test `tests/router-security.test.ts`.

- [ ] Add two-session and concurrent-request action tests using distinct session cookies and a request-aware verifier.
- [ ] Run them; expect token A to be accepted for session B with the static-token API.
- [ ] Replace static router CSRF configuration with a request-local verifier and constant-time submitted-token comparison; thread the route context without mutating handler options.
- [ ] Run router security and Node/Workers/Lambda adapter tests; commit `fix: bind csrf verification to each request`.

### Task 5: Add signed-cookie lifetime and key-ring boundaries

**Files:** Modify `src/cookies.ts`, `docs/routing.md`; test `tests/router-security.test.ts`.

- [ ] Add injectable-clock expiry, copied-cookie replay-after-destroy, and primary-plus-verification-key tests.
- [ ] Run the expiry test; expect the replayed signed cookie to restore data after its configured expiration.
- [ ] Sign an envelope with expiry and key identity, verify against a bounded key ring, reject expired envelopes, and document that arbitrary revocation requires server-side state.
- [ ] Run focused security tests and commit `feat: add signed cookie expiry and key rotation`.

### Task 6: Enforce canonical static asset containment

**Files:** Modify `src/adapters/node.ts`, `docs/routing.md`; test `tests/router-platform.test.ts`, `tests/router-adapters.test.ts`.

- [ ] Add direct and nested outside-root symlink tests, dotfile tests, `.well-known` policy tests, and fetch-adapter non-fallthrough tests.
- [ ] Run them; expect the symlink target to be served.
- [ ] Resolve and compare canonical root/file paths, deny dot segments by default, and keep rejection distinct from not-found fallthrough.
- [ ] Run focused adapter tests and commit `fix: contain static assets by canonical path`.

## Batch 2: Application and routing contracts

### Task 7: Preflight all CLI generator conflicts

**Files:** Modify `src/cli.ts`, `README.md`; test `tests/dx.test.ts`.

- [ ] Add seeded conflict tests for `add page` and every starter managed file, asserting byte-for-byte no change and no new directory on default failure.
- [ ] Run them; expect overwrite behavior.
- [ ] Build one output manifest before `mkdir` or `writeFile`, return a structured conflict Result, and add explicit `--force` output listing overwritten paths.
- [ ] Run DX tests and commit `fix: make cli generators conflict-safe`.

### Task 8: Unify starter SFC loading and filesystem route discovery

**Files:** Modify `src/app.ts`, `src/cli.ts`, `src/vite.ts`, and shared route-path code; test `tests/dx.test.ts`.

- [ ] Add a real generated-starter Vite test for `GET /` returning `Welcome`, then add `settings/profile/page.td` and verify `/settings/profile/`.
- [ ] Run it; expect the raw SFC multi-root failure and missing added route.
- [ ] Use one route-file manifest convention for `index`, `[id]`, `[...slug]`, URL slash handling, and output names; have starter loading consume the SFC-aware compilation and its single scope source.
- [ ] Run DX and Vite integration tests and commit `fix: make generated pages routable sfc modules`.

### Task 9: Reject app conflicts and model explicit not-found results

**Files:** Modify `src/app.ts`, `src/vite.ts`, `src/cli.ts`, `README.md`; test `tests/dx.test.ts`.

- [ ] Replace first-match duplicate tests with duplicate normalized-path and duplicate-output tests; add unknown SSR/Vite path status coverage.
- [ ] Run them; expect a home document with 200 or silent first-match selection.
- [ ] Return or throw an explicit configuration error containing all conflicts and return an explicit not-found result instead of root fallback.
- [ ] Run focused tests and commit `fix: reject app conflicts and soft 404s`.

### Task 10: Activate nearest route-module NotFound boundaries

**Files:** Modify `src/router.ts`, `docs/routing.md`; test `tests/router-advanced.test.ts`, `tests/router-server.test.ts`, `tests/router-adapters.test.ts`.

- [ ] Add nested prefix, dynamic parent, wildcard, global fallback, and adapter status tests.
- [ ] Run them; expect only global not-found rendering.
- [ ] Preserve the best failed route branch, select the nearest matching boundary, and retain global fallback when no boundary applies.
- [ ] Run router and adapter tests and commit `fix: render route module not-found boundaries`.

### Task 11: Thread typed Workers invocation bindings

**Files:** Modify `src/router.ts`, `src/adapters/workers.ts`, `src/adapters/node.ts`, `src/adapters/lambda.ts`, `docs/routing.md`; test `tests/router-adapters.test.ts` and type tests.

- [ ] Add a Workers binding object test that reads the same value from middleware, loader, action, render, headers, cache, and resources.
- [ ] Run it; expect `undefined` in route context.
- [ ] Add a generic request-scoped `bindings` field separate from string `env`, define precedence, and keep Node/Lambda platform context types specific.
- [ ] Run adapter tests, build, and commit `feat: expose workers invocation bindings to routes`.

## Batch 3: Runtime lifecycle and termination

### Task 12: Define client action cancellation ownership

**Files:** Modify `src/runtime/router.ts`, `README.md`; test `tests/router-client.test.ts`.

- [ ] Add dispose-abort, newer-action-wins, navigation-wins, redirect, error, and caller-signal composition tests using deferred real actions.
- [ ] Run them; expect stale actions to revalidate or redirect.
- [ ] Retain active action controllers and submission generations; abort them on dispose and invalidate stale completions before side effects.
- [ ] Run focused router-client tests and commit `fix: abort stale client actions`.

### Task 13: Validate keyed-row numeric controls before mutation

**Files:** Modify `src/runtime/keyed-rows.ts`, `docs/runtime.md`; test `tests/keyed-rows.test.ts`.

- [ ] Add table-driven invalid `chunks`, `count`, and `stride` tests for zero, negatives, `NaN`, infinity, and fractions, asserting unchanged DOM.
- [ ] Run them; expect non-terminating or unchecked behavior.
- [ ] Validate positive finite integers before any rebuild/build/update mutation and use stable `TypeError` messages.
- [ ] Run focused tests and `pnpm bench:local:gate`; commit `fix: validate keyed row numeric controls`.

### Task 14: Make accessor resources reactive

**Files:** Modify `src/runtime/signal.ts`, `docs/runtime.md`; test `tests/runtime-signal.test.ts`.

- [ ] Add a changing-accessor deferred-fetch test proving automatic reload and stale-result suppression.
- [ ] Run it; expect only the initial fetch.
- [ ] Create and own a tracking effect for accessor sources, preserve version suppression, and expose or document disposal ownership.
- [ ] Run focused signal tests and commit `fix: react to resource accessor changes`.

### Task 15: Respect adapter backpressure

**Files:** Modify `src/adapters/node.ts`, `src/adapters/workers.ts`, `src/adapters/lambda.ts`; test `tests/router-adapters.test.ts`.

- [ ] Add Node drain, close/error while waiting, Workers demand/cancel, and Lambda bounded-strategy tests.
- [ ] Run them; expect source reads beyond the first saturated write.
- [ ] Await Node drain before the next read, make Workers streams demand-driven with iterator return on cancel, and model Lambda drain capability explicitly or document its bounded limitation.
- [ ] Run focused adapter tests and a new throttled-client benchmark result; commit `fix: honor streaming backpressure`.

## Batch 4: Compiler and template type pipeline

### Task 16: Preserve semantic diagnostic source spans

**Files:** Modify `src/compiler/types.ts`, `src/compiler/parser.ts`, `src/compiler/ir.ts`, `src/diagnostics.ts`, `src/compiler/sfc.ts`, `src/language-server.ts`; test `tests/compiler.test.ts`, `tests/dx.test.ts`, `tests/language-server.test.ts`.

- [ ] Add failing directive, binding expression, nested directive, and SFC-template range tests.
- [ ] Run them; expect line 1 column 1 and fixed-width LSP end ranges.
- [ ] Carry start/end spans through parser and IR, select the smallest relevant semantic span, and map it through diagnostics and SFC offsets.
- [ ] Run compiler, DX, and LSP tests and commit `fix: report semantic diagnostic source ranges`.

### Task 17: Synchronize per-template module declarations

**Files:** Modify `src/app.ts`, `src/cli.ts`, `src/vite.ts`, `src/tachyon-html.d.ts`, `README.md`; test `tests/dx.test.ts`.

- [ ] Add a temporary Vite project test that changes `.td` identifiers and script export types, then typechecks current declarations without manual per-file typegen.
- [ ] Run it; expect generic ambient types or stale declarations.
- [ ] Reuse SFC analysis for a single declaration generator, define output ownership and stale-file cleanup, wire it into dev/build/typecheck, and retain ambient declarations only as fallback.
- [ ] Run DX tests and build and commit `feat: synchronize template module declarations`.

## Batch 5: Benchmark semantic parity

### Task 18: Make benchmark fixtures prove dynamic SSR and streaming

**Files:** Modify `benchmark/web-framework/fixtures/**`, `benchmark/web-framework/run-web-framework-benchmark.ts`; test `tests/web-framework-fixtures.test.ts`, `tests/web-framework-report.test.ts`.

- [ ] Add fixture-contract tests for two dynamic product IDs, shell-before-completion chunks, and result contract version isolation.
- [ ] Run them; expect precomputed Tachyon responses and one-chunk stream fixtures.
- [ ] Make all fixtures render parameters at request time, emit a common early shell plus delayed completion through production streams, and reject fixtures/results that do not meet the contract version.
- [ ] Run fixture/report tests and commit `fix: require semantic parity in web benchmarks`.

### Task 19: Record new benchmark evidence and close issues

**Files:** New run-scoped files under ignored benchmark results; move local files from `docs.local/issues/open/` to `docs.local/issues/closed/`; update `docs.local/logs/`.

- [ ] Use the port registry before benchmark server startup, run the existing smoke commands with fixed build mode, and confirm all child processes stop.
- [ ] Save before/after results under separate timestamped run directories without replacing prior files.
- [ ] Run `pnpm lint`, `pnpm test`, `pnpm build`, applicable benchmark gates, Security Specialist review, and a clean-context correctness review.
- [ ] Commit only tracked source, tests, and public docs; do not stage `docs.local`, ignored results, or `.codex` artifacts.

## Final verification

- [ ] `pnpm lint`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] `pnpm bench:local:gate` after keyed-row changes
- [ ] `pnpm bench:web-framework:smoke` after fixture parity changes
- [ ] Security Specialist report in `Must Fix / Should Fix / Notes` form
- [ ] Verify every issue file has moved from local `open` to `closed` only after its acceptance tests pass

## Issue-to-task mapping

| Open issue | Task |
| --- | --- |
| `error-boundary-trusted-html-contract` | 1 |
| `memory-session-id-fixation` | 2 |
| `route-cache-safe-default` | 3 |
| `session-bound-csrf-verification` | 4 |
| `signed-cookie-session-expiry-and-revocation` | 5 |
| `static-asset-canonical-containment` | 6 |
| `cli-generator-conflict-safety` | 7 |
| `generated-starter-raw-sfc-regression` | 8 |
| `add-page-route-registration` | 8 |
| `define-app-route-conflicts-and-soft-404` | 9 |
| `route-module-not-found-dead-api` | 10 |
| `workers-route-env-bindings` | 11 |
| `client-action-abort-lifecycle` | 12 |
| `keyed-rows-numeric-validation` | 13 |
| `resource-accessor-reactivity` | 14 |
| `streaming-adapter-backpressure` | 15 |
| `semantic-diagnostic-source-ranges` | 16 |
| `automatic-template-module-types` | 17 |
| `web-framework-benchmark-semantic-parity` | 18 |
