# Resolve All Open Performance Issues Design

## Scope

Resolve all eight issues currently under `docs.local/issues/open/`. The work covers benchmark ranking authority, web-framework stream fixture parity, and six keyed-row hot-path investigations. An issue may close through a tested implementation change or through evidence that the current implementation is already the safest design and no candidate produces an authoritative improvement.

The untracked `docs/issues/` directory is user-owned and out of scope. Local issue moves, work logs, and run-scoped benchmark artifacts remain uncommitted according to repository policy.

## Classification

| Issue | Classification | Initial disposition |
| --- | --- | --- |
| 001 benchmark ranking authority | Implementation gap | Implement before accepting ranking claims from other issues |
| 002 partial update | Measurement followed by an implementation decision | Change runtime only if action-only evidence identifies a removable runtime cost |
| 003 far swap | Measurement followed by a design decision | Compare native move candidates without weakening identity or fallback semantics |
| 004 remove event path | Fixture implementation candidate | Evaluate together with issue 007 because both operations share one delegated handler |
| 005 clear subtree | Measurement followed by a design decision | Keep the minimal implementation if native subtree disposal dominates |
| 006 stream fixture parity | Fixture design and measurement gap | Restore scored parity while preserving a separate production-path evidence route |
| 007 selection | Measurement with correctness guardrails | Apply shared event improvements first; preserve non-selection classes |
| 008 replace and bulk build | Measurement followed by a design decision | Tune only when teardown/build phases and existing winning operations remain protected |

No issue is currently classified as documentation-only, duplicate, or already resolved.

## Execution Architecture

The implementation is dependency ordered and single-writer:

1. Establish benchmark authority in issue 001.
2. Restore stream fixture parity in issue 006 and connect its repeated stream samples to the authority contract.
3. Investigate issues 004 and 007 together because they share event routing.
4. Investigate issues 005 and 008 together because they share teardown and rebuild phases.
5. Investigate issue 002's callback and DOM traversal costs.
6. Investigate issue 003 with real-browser move instrumentation.
7. Run authoritative comparisons, preserve run-scoped artifacts, and close only issues supported by the resulting evidence.

Read-only exploration may be delegated, but source changes remain owned by the main writer. Each behavior change follows a RED, GREEN, REFACTOR cycle and receives a focused commit.

## Benchmark Authority Contract

Fresh benchmark processes are the independent statistical units. Samples within one process produce that run's statistic and are not treated as independent bootstrap observations. This avoids pseudo-replication while retaining raw samples for recomputation.

The new contract will:

- bump local and web benchmark contract versions while retaining historical artifacts as readable but non-authoritative;
- store a fresh-process run ID, seed, measured execution order, warmup count, measured sample count, and raw samples;
- generate deterministic balanced orders from a seed, covering early and late positions across the required run set;
- require clean and compatible provenance, at least five fresh-process runs, and workload-specific minimum sample counts;
- calculate candidate-to-best ratios per independent run and a deterministic one-sided 95% bootstrap upper bound;
- classify an upper bound below `1.00` as a reproducible win and at or below `0.99` as a meaningful win of at least 1%;
- report insufficient samples, incompatible provenance, unbalanced order, dirty trees, or high uncertainty as non-authoritative or inconclusive with reason codes;
- keep output files run-scoped and release browsers, servers, child processes, and port claims on every exit path.

Local stable measurements use at least 30 measured samples and 5 warmups per process. Web stream measurements use at least 20 measured samples and 5 warmups per process. Every measured stream sample must independently satisfy shell-before-done, separate downstream chunk arrival, and the minimum gap contract.

## Stream Fixture Parity

Every scored `/stream` fixture will represent one 20 ms deferred dependency, one 80-item payload, and one shell-to-done boundary. Tests will validate a shared workload manifest or response-level contract rather than relying only on source substrings.

Tachyon's current four-stage generator will move to a non-scored evidence route. That route must use the same public `RouteDefinition.stream`, router, Workers bridge, and Node bridge as the scored route. It retains multi-chunk completion, cancellation propagation, emitted-chunk accounting, RSS evidence, and backpressure coverage. Generic adapter behavior, Unicode handling, status, headers, CSP, cache, cookies, `Vary`, and `HEAD` behavior are not changed by the fixture repair.

## Keyed-Row Investigation Rules

The browser benchmark currently measures a click through two animation frames. Runtime or fixture changes require an action-only trace that separates event dispatch, JavaScript, DOM mutations, style/layout work, and frame waiting. A full-frame ranking alone is not sufficient evidence for a hot-path change.

Candidate changes must preserve:

- live DOM as the single source of row truth;
- row, `tbody`, focus, input value, selection, and delegated-listener identity where applicable;
- synchronous update, remove, clear, and rebuild semantics;
- non-selection classes during selection changes;
- fallback behavior across browser capabilities and realms;
- existing create/append performance, heap, retained DOM node, entry size, and source size guardrails.

Persistent row caches, row pools, `tbody` replacement, fixed parent-chain traversal, asynchronous cleanup, and benchmark-only public APIs are rejected unless new evidence invalidates the current constraints. If candidate primitives do not produce an authoritative improvement, the current implementation remains unchanged and the issue closes with the trace and comparison evidence.

## Coverage Strategy

The initial coverage uses table-driven Vitest tests and existing integration tests. Obligations include:

- authority rejection for dirty, incompatible, undersampled, fixed-order, and high-variance runs;
- deterministic order reproduction and balanced position coverage;
- deterministic bootstrap results for clear wins, ties, losses, and inconclusive distributions;
- stream workload parity, per-sample chronology, evidence-route completion, and cancellation;
- delegated remove/select classification for nested, text, non-element, and out-of-boundary targets;
- keyed-row indices, live mutation semantics, identity, focus, input state, selection uniqueness, synchronous clear, rebuild boundaries, and partial chunks;
- lifecycle cleanup and run-scoped output preservation.

Property-based testing, PICT, and formal models are deferred. They will be proposed only if table-driven tests or real-browser investigation exposes a state space that cannot be covered economically. Existing property tests for router escaping and adapter tests remain part of regression verification.

## Performance Evidence

Performance-sensitive changes require before and after artifacts produced with the same build mode, workload, environment, and measurement command. Existing result files are never overwritten. Smoke runs validate mechanics only and cannot establish a ranking.

Final ranking evidence requires at least five clean fresh-process runs under the new authority contract. Local and web results are evaluated separately. Keyed-row candidates must also keep the issue-specific 2% heap, size, or unaffected-operation guardrails. If environment or time prevents authoritative runs, affected issues remain open with the exact remaining coverage debt recorded.

## Error Handling and Lifecycle

Validation failures return explicit reason codes rather than silently emitting authoritative rankings. Runner cleanup remains in `finally` paths. Development servers and benchmark processes are started through the repository's Port Registry workflow, stopped by verified PID, and checked for surviving children. Browser sessions and port claims are explicitly released.

## Documentation and Closure

Public benchmark documentation is updated in English only where users need to understand the new contract. The Japanese local work log records classification, RED/GREEN evidence, candidate decisions, commands, benchmark artifact paths, process cleanup, and commits.

An issue moves from `docs.local/issues/open/` to `closed/` only when every acceptance criterion is covered by implementation, deterministic verification, an evidence-backed no-change conclusion, or explicitly documented out-of-scope debt accepted by the issue contract.

## Completion Criteria

- All eight issues have a final classification and closure basis.
- Behavior changes were preceded by observed failing tests.
- Relevant tests, `pnpm lint`, and `pnpm build` pass from fresh output.
- Required authoritative benchmark artifacts exist at new run-scoped paths.
- No agent-started server, browser, worker, or port claim remains.
- Source changes are split into coherent commits, while ignored local artifacts and user-owned files remain unstaged.
