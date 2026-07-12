# Evidence-Gated Performance Candidates Design

## Goal

Evaluate four follow-up performance candidates without forcing speculative optimizations into the runtime. Adopt only candidates that demonstrate a reproducible improvement under explicit correctness, compatibility, memory, source-size, and measurement guardrails.

The candidates are:

1. action-only and rendering-phase auxiliary metrics;
2. state-preserving keyed-row swaps using `moveBefore()` with a fallback;
3. Node adapter handler hoisting;
4. bounded template bind-target caching for bulk row creation.

The existing frame-complete operation metric and benchmark authority remain the primary ranking contract. Auxiliary metrics explain where time is spent; they do not replace the primary metric.

## Decision Model

Each candidate is developed and evaluated independently. A candidate begins with characterization and RED tests, proceeds to the smallest implementation that can exercise the hypothesis, and is retained only if its candidate-to-main comparison passes the candidate-specific adoption gate.

Rejected candidates are removed from tracked source. Their test observations, benchmark commands, raw artifacts, aggregate result, and rejection reason remain under `docs.local` so the same idea is not repeatedly rediscovered.

Candidate Tournament ratings determine evaluation order only. Correctness tests and benchmark validators are the authority.

## Evaluation Order

### 1. Measurement decomposition

Extend the local benchmark runner to record three views of each measured operation:

- action return: click dispatch through synchronous handler completion;
- rendering work: Style, Layout, and Paint duration attributed to the measured operation window;
- frame complete: the existing click-through-two-`requestAnimationFrame` duration.

The frame-complete value remains unchanged and continues to drive rankings. Auxiliary timing collection must not inject synchronous DOM reads, forced layout, additional animation frames, or framework-specific instrumentation into the measured page.

The preferred implementation uses browser tracing or `PerformanceObserver` data collected outside the action path. Any instrumentation requiring application hooks or benchmark-only runtime APIs is rejected.

Adopt the auxiliary metrics only when:

- frame-complete candidate/main median ratio remains within 1% for every operation;
- repeated samples distinguish script work from Style/Layout/Paint with stable units and explicit missing-data behavior;
- raw event data and derived summaries are stored and validated consistently;
- measurement overhead is framework-neutral.

### 2. Keyed-row `moveBefore()` swap

Use `ParentNode.moveBefore()` only when the concrete `tbody` exposes a callable implementation. Safari and older engines continue through `insertBefore()`.

The native path performs atomic state-preserving moves. The fallback retains the existing focus restoration behavior because traditional re-insertion can reset focus, iframe state, animation state, and selection state. A native call that throws `HierarchyRequestError` falls back to `insertBefore()`, matching the existing `runtime/list.ts` policy. Other exceptions propagate.

The swap algorithm must handle forward adjacent, reverse adjacent, distant, same-index, and out-of-range cases without self-insertion. Native and fallback paths preserve row identity, order, selection class, input value, delegated listeners, active element, text selection range, scroll position, and blur/focus event counts.

Adopt this candidate when either:

- supported Chromium demonstrates state preservation that the fallback cannot provide, with no performance, heap, or source-size regression; or
- candidate/main action-return or frame-complete ratio has a one-sided 95% upper bound below `1.00`.

State preservation is a valid improvement even when frame timing is statistically tied. The fallback must remain behaviorally equivalent for supported public semantics.

### 3. Node handler hoisting

`createNodeHandler()` currently constructs the static asset handler, Workers handler, and normalized observability object during request processing. The candidate moves immutable handler construction into `createNodeHandler()` while keeping request-scoped URL parsing, abort signals, request bodies, and response writing inside the returned handler.

The design treats the options object as configuration captured at handler creation. Nested route definitions and user callbacks retain their existing references; the candidate does not deep-clone options. The accepted semantics must be documented by characterization tests before implementation, including whether later top-level option reassignment was ever observable.

Security headers, static traversal rejection, static route precedence, observability adapter naming, request abort propagation, stream cancellation, backpressure, and response metadata must remain unchanged.

Adopt this candidate only when a no-delay Node handler benchmark shows a candidate/main one-sided 95% upper bound below `1.00`, while the scored stream metric and all adapter integration tests are non-regressing. A difference visible only inside the intentional 20ms stream delay is insufficient.

## 4. Bounded bind-target caching

Bulk row construction currently binds data into reusable template rows and clones completed chunks. The candidate may cache only the stable target nodes inside those reusable template rows. It must not retain live rows after insertion, create a row pool, add a parallel item array, or change the DOM-as-source-of-truth contract.

The cache is derived from template structure at chunk creation time and discarded whenever chunk geometry changes. The public `bind(row, item, index)` contract cannot be optimized internally because the callback may perform arbitrary DOM work. Therefore the candidate must first prove that a general, public mechanism can expose target resolution without benchmark-specific selectors or markup assumptions. If that cannot be done without widening the API or specializing for the fixture, the candidate is rejected before implementation.

An acceptable candidate must preserve arbitrary bind callbacks, non-divisible final chunks, external DOM mutation tolerance, row identity, selection reset, delegated listeners, and immediate garbage collection after clear or replace.

Adopt only when at least one of 10,000-row creation or full replacement has a candidate/main one-sided 95% upper bound below `1.00`, neither operation regresses, and ready/run/run-clear heap plus local/entry source size remain within 2% of main.

## Benchmark Comparison Contract

Candidate adoption uses clean, compatible, fresh-process comparisons from the same host and browser. Each candidate and main observation is stored as a separate run-scoped artifact. Measurement order is counterbalanced, and raw samples are the source of truth.

For local candidates, the evaluation uses the existing authority statistics at the candidate-versus-main layer. Full competitor ranking runs are required only after a candidate passes its narrower gate. For Node handler hoisting, a focused no-delay benchmark is added with the same raw-sample, order, manifest, and confidence-bound principles.

The following global rejection guards apply:

- any correctness or compatibility regression;
- invalid or missing raw evidence;
- candidate/main upper confidence bound at or above `1.00` when performance is the only claimed benefit;
- more than 2% regression in protected heap or source-size metrics;
- benchmark-specific runtime API, selector, or fixture branch;
- retained development server, browser, worker, or port claim after evaluation.

## Test Design

The coverage ledger includes these obligations:

1. the primary frame-complete metric is byte-for-byte and semantically unchanged;
2. auxiliary metrics have raw evidence, units, missing-data behavior, and summary validation;
3. `moveBefore()` native and fallback paths cover every index relation and preserve DOM state in real Chromium;
4. unsupported browsers never call `moveBefore()`;
5. Node handler hoisting preserves static, dynamic, streaming, security, observability, abort, and options-capture behavior across multiple requests;
6. bind-target experiments cannot specialize the public runtime for benchmark markup;
7. bulk construction retains count, content, index, chunk-boundary, selection, identity, heap, and source-size invariants;
8. every retained candidate has a reproducible positive benchmark gate;
9. every rejected candidate has a durable rejection artifact and no tracked implementation residue.

Vitest covers pure and integration behavior. Real Chromium tests cover active element, selection range, blur/focus events, scroll position, iframe or animation state where practical, and native/fallback swap paths. Port Registry wraps every process that binds a port, and all task-owned browsers and servers are explicitly stopped.

## Issue and Evidence Handling

Create one local open issue per runtime candidate and one measurement issue for auxiliary metrics. Each issue records its own coverage ledger, adoption gate, before/candidate artifact paths, decision, and commits. A rejected experiment closes as evidence-backed no-change only after the candidate code is removed and verification passes.

Durable evidence is stored under `docs.local/benchmark-evidence/2026-07-12-performance-candidates/`, outside the feature worktree. The work log records candidate order, RED/GREEN cycles, benchmark controls, results, retained commits, reverted experiments, review findings, and process cleanup.

## Security Review

The Node adapter candidate touches security-header and request lifecycle paths, so it receives a Security Specialist review even though it does not intentionally change a security policy. The review is recorded as `Must Fix / Should Fix / Notes`; any Must Fix blocks adoption.

## Completion Criteria

The task completes when all four candidates have an explicit evaluated disposition:

- adopted with passing correctness and benchmark gates; or
- rejected with durable evidence and no remaining candidate implementation.

The final branch passes targeted tests, lint, build, the full test suite, benchmark artifact validation, checksum verification, clean-context review, Security Specialist review for Node adapter changes, and process lifecycle checks.
