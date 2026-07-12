# Benchmark Authority Repair Design

## Goal

Restore the local and web benchmark authority contracts so every published aggregate can be reproduced from durable raw evidence, then audit the performance issue closures against the repaired authority.

Runtime optimization experiments such as `moveBefore()`, Node handler hoisting, bind-target caching, and action-only metrics are out of scope. They may be evaluated only after the authority is trustworthy again.

## Current Failure

The local aggregate validates the shape of `measurements.summaries[*].values` but computes authoritative ratios from the stored `trimmedMean`. The web aggregate validates `streamSamples` but computes ratios from the stored `streamCompleteMs`. A malformed or edited artifact can therefore contain valid raw samples and a contradictory summary while still receiving an authoritative status.

The current five-run minimum is also insufficient to place all seven local implementations in every execution position. The balance check permits partial rotations whose position counts differ by at most one, even when an implementation never experiences some positions. Scenario order has the same class of weakness. Saved `seed` and `runIndex` values are not used to reproduce and verify the recorded orders.

Finally, the ten raw authority artifacts referenced by the issue closure log were stored only in an ignored feature worktree and were removed with that worktree. The previously reported confidence values are therefore not auditable and must not be treated as final.

## Authority Data Model

Raw samples are the source of truth. Stored summaries remain in the artifact for diagnostics and human-readable reports, but authority validation recomputes them and rejects any mismatch outside a small deterministic floating-point tolerance.

For local operation measurements, the validator and aggregate recompute the configured trimmed mean from every `values` array. The per-run candidate-to-best-competitor ratio uses only these recomputed values. Sample counts are derived from the same arrays.

For web stream measurements, the validator and aggregate recompute the median completion time from `streamSamples[*].complete`. The per-run Tachyon-to-best-competitor ratio uses only those recomputed medians. Stored `streamCompleteMs` must match the recomputed median.

Each authority artifact records a manifest containing:

- an artifact SHA-256 computed over a canonical representation that excludes the digest field itself;
- the Git commit and working-tree digest already captured by provenance;
- the process ID and process start timestamp;
- the authority seed and run index;
- the actual implementation, scenario, or framework orders.

The aggregate verifies the digest before using the artifact. Process metadata is evidence of fresh-process execution, while unique run IDs and process-start pairs prevent the same execution from being counted twice.

## Run and Order Contract

The local benchmark requires at least seven independent runs because there are seven implementations. An authoritative seven-run set must form a complete cyclic position schedule: every implementation appears exactly once in every position. The recorded implementation order for each run must exactly match the deterministic order regenerated from its seed and run index.

There are nine scenarios. Seven runs cannot give every scenario every position, so scenario order is validated using the deterministic regenerated schedule plus explicit distribution constraints:

- the recorded order exactly matches the seed/run-index plan;
- no scenario's position counts differ by more than one;
- each scenario's early-half and late-half counts differ by at most one, with the center position tracked separately;
- each scenario's mean position remains within a fixed tolerance of the global center.

The web benchmark uses the same principle. Its minimum run count is the number of compared frameworks or seven, whichever is greater. Every recorded framework order must match the deterministic schedule regenerated from the authority seed and run index, and a minimum set must cover every framework position exactly once.

Extra runs are accepted only in complete schedule cycles. This prevents a partial trailing cycle from reintroducing position bias.

## Validation and Error Handling

Validation remains fail-closed. An aggregate returns no ranking or confidence status when any artifact has:

- invalid, missing, or non-finite raw samples;
- a stored summary inconsistent with its raw samples;
- a missing or invalid manifest digest;
- duplicate run or process identity;
- an order inconsistent with seed and run index;
- an incomplete position cycle or biased scenario distribution;
- incompatible commit, tree, runtime, host, browser, dependencies, build mode, or workload controls.

Errors identify the exact run and field so rejected artifacts remain useful diagnostics.

## Durable Evidence

Authority artifacts are generated in the benchmark result directories and copied before cleanup to a durable root-workspace evidence directory under `docs.local/benchmark-evidence/2026-07-12-authority-repair/`. The directory contains:

- seven or more local raw artifacts;
- seven or more web raw artifacts;
- aggregate output for each benchmark;
- a SHA-256 manifest listing every evidence file;
- the exact commands and environment controls required to reproduce the run.

`docs.local` remains ignored, but the evidence survives feature-worktree removal because it is rooted in the primary workspace. The committed benchmark documentation describes the authority contract without embedding machine-specific results.

## Issue Audit

Issues 001 and 006 are reopened before implementation because their authority evidence is invalid or missing.

Issues 002 through 005, 007, and 008 retain their evidence-backed no-change conclusions only after their acceptance criteria are amended to permit closure when all of the following are demonstrated:

- the runtime operation is not the dominant measured cost;
- a safe runtime change with a measurable expected benefit was not identified;
- benchmark-specific APIs, persistent live-row caches, or semantic weakening would be required to force a win;
- the supporting trace and benchmark evidence has a durable path.

If repaired evidence does not satisfy those conditions, the corresponding issue returns to open. Issue 006 may close on restored semantic parity and a valid authority result; it does not require a forced performance win when the comparison is statistically tied. Issue 001 closes only after both local and web authority validators reject contradictory summaries and the new raw artifacts reproduce the published aggregates.

## Test Design

Tests follow red-green-refactor and cover these obligations:

1. Local aggregation recomputes trimmed means from raw values.
2. Local validation rejects a stored trimmed mean that contradicts raw values.
3. Web aggregation recomputes stream completion medians from raw samples.
4. Web validation rejects a stored stream completion summary that contradicts raw samples.
5. Authority rejects six local runs and any incomplete position cycle.
6. Authority rejects a position-biased rotation that previously passed the max-minus-min check.
7. Authority rejects implementation, scenario, and framework orders that do not match the regenerated seed/run-index plan.
8. Authority rejects biased scenario early/late placement or mean position.
9. Authority rejects duplicate process identities and invalid artifact digests.
10. Authority accepts a complete deterministic seven-run fixture and produces ratios derived only from raw samples.

Existing compatibility, sample-shape, chronology, stream-gap, dirty-tree, and workload-control tests remain in force.

## Verification

Implementation verification consists of targeted benchmark contract tests, the full Vitest suite, lint, and build. Final benchmark verification requires fresh local and web authority runs, successful aggregation from the durable copies, digest verification, and process cleanup checks. No previous five-run confidence value is reused.

The final report distinguishes simple median rankings from authority confidence results and links every reported value to its durable raw evidence path.
