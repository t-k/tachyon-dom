# Security Mutation-Debt Test Design

## Goal

Strengthen the tests around four security and trust-boundary modules whose mutation report still contains meaningful surviving or uncovered mutants. The change must improve observable security contracts rather than add assertions that only mirror implementation details or inflate the mutation score.

## Context

The forced mutation baseline classified 17,244 mutants across 71 source files. The four modules selected for this change currently account for the following historical results:

| Source | Killed | Survived | Timeout | No coverage |
| --- | ---: | ---: | ---: | ---: |
| `src/constant-time.ts` | 31 | 7 | 1 | 0 |
| `src/head-policy.ts` | 27 | 3 | 1 | 0 |
| `src/stream-segments.ts` | 55 | 10 | 6 | 0 |
| `src/redirect-policy.ts` | 47 | 9 | 0 | 2 |

These figures are historical evidence only because the report was produced in a previous worktree and may include incremental state. Fresh target-specific runs from the implementation checkout will establish the authoritative before-and-after classifications.

## Scope

This change will add or strengthen tests for:

- constant-time comparison type boundaries and partial digest failure;
- head attribute-name grammar boundaries and event-handler filtering;
- async stream composition lifecycle, cancellation, and terminal behavior;
- redirect parsing, origin configuration, scheme restrictions, and protocol-relative paths.

The implementation will be tests-only unless a new test exposes a production defect. If that occurs, implementation will pause for root-cause analysis and a separate security review before any source change.

This change will not:

- alter URL compatibility behavior;
- require every equivalent or unreachable mutant to be killed;
- make assertions about private call order or exact internal algorithms;
- add module replacement, dependency mocks, or timer-based liveness checks;
- expand the mutation target beyond the four selected modules;
- establish a repository-wide mutation-score threshold.

## Candidate Evaluation

Three approaches were evaluated using security-contract strength, predicted non-equivalent mutant detection, determinism, Stryker runtime, and maintenance clarity.

| Candidate | Description | Weighted result |
| --- | --- | ---: |
| Deterministic contracts | Directly test observable boundaries and lifecycle transitions | 90.2 |
| Property state models | Add bounded generated state models for head and stream behavior | 86.1 |
| Layered public surfaces | Repeat contracts through unit, SSR, client, and router layers | 78.8 |
| Selected hybrid | Deterministic contracts, one bounded head-name property, and existing redirect public-surface tables | 91.5 |

The selected hybrid avoids the runtime and maintenance cost of a generated stream state machine while retaining useful generated coverage for the compact head attribute-name grammar. Existing public redirect tests provide an appropriate integration layer without duplicating every unit scenario through SSR and client surfaces.

## Test Design

### Constant-time comparison

Tests will require:

- a non-string operand to be rejected even when its string representation equals the other operand, such as `"undefined"` and `undefined`;
- failure of only the left digest operation to resolve to `false` without throwing;
- failure of only the right digest operation to resolve to `false` without throwing;
- unavailable Web Crypto to continue resolving to `false`.

The partial-failure fixture will provide the smallest valid `SubtleCrypto.digest` behavior needed to select which call rejects. It will not assert the number or ordering of property reads. Capability changes between repeated `globalThis.crypto` accesses are excluded because they would bind the contract to environment access ordering rather than comparison semantics.

### Head attribute policy

Fixed examples will verify that an invalid leading character, an invalid trailing character, and a valid sentinel attribute are classified independently.

A bounded fast-check property will generate a valid attribute-name core and inject a forbidden character at either boundary. The result must omit the malformed name while retaining a valid sentinel. A second bounded dimension will exercise ASCII case variants of the `on` prefix and require their removal.

The property will use at most 64 generated cases under the repository's fixed seed. It will construct boundary cases directly and will not duplicate the production regular expression in the generator or predicate.

### Stream segment composition

Deterministic fixtures will verify:

- a valid async iterator without `return()` can be closed safely;
- direct `next()` calls produce `before`, source values, `after`, and the terminal result in exact order;
- repeated `next()` calls after completion remain terminal and do not touch the source again;
- wrapper `return()` resolves to `{ done: true, value: undefined }`;
- repeated wrapper cancellation closes a closeable source at most once;
- cancellation after natural source completion does not close the source again;
- composed iteration with a return-less source completes without throwing.

The finite source fixture will throw if accessed after its expected terminal transition. This provides fail-fast detection for loop-bound and state-transition mutants that could otherwise consume the mutation timeout. The assertions will target observable iterator behavior, not private phase names.

### Redirect policy

Existing validator and public redirect-path tables will be expanded to require:

- a leading `//` to be rejected as protocol-relative;
- `/safe//` to remain allowed because only a leading double slash is unsafe under the current compatibility contract;
- `allowExternal: true` with no configured origin or an empty origin list to fail closed;
- registered HTTP and HTTPS origins to be allowed;
- FTP to be rejected even if its origin is supplied;
- an unregistered origin to be rejected;
- malformed absolute URLs such as `https://[` to be rejected without throwing.

Shared table cases will be preferred where the current tests already verify parity across validator, router, and form handling. Tests will not change `/safe//` compatibility merely to kill an `startsWith` mutant.

## Coverage Obligations

The coverage ledger will track these obligations:

- `M-SEC-CT-01`: non-string operands never become equal through coercion;
- `M-SEC-CT-02`: either digest operation may fail independently and comparison fails closed;
- `M-SEC-HEAD-01`: forbidden leading or trailing attribute-name characters are rejected;
- `M-SEC-HEAD-02`: ASCII case variants of event-handler attributes are rejected;
- `M-SEC-STREAM-01`: return-less async iterators remain valid composition sources;
- `M-SEC-STREAM-02`: framing, source, suffix, and terminal transitions are exact and stable;
- `M-SEC-STREAM-03`: completion and cancellation close a source at most once;
- `M-SEC-REDIRECT-01`: protocol-relative and malformed destinations fail closed;
- `M-SEC-REDIRECT-02`: external redirects require an allowed HTTP or HTTPS origin;
- `M-SEC-REDIRECT-03`: redirect decisions agree across existing public handling paths.

Overlap between direct and public-path tests is intentional only when the layers can fail independently. Generated and example-based tests will otherwise have distinct obligations.

## Equivalent and Unreachable Mutants

Mutation score alone will not determine success. A remaining mutant may be classified as equivalent or unreachable only when its observable behavior is explained in the coverage ledger.

Expected candidates include:

- replacing `Math.max` with `Math.min` in the byte comparison, because unequal lengths already make the accumulated difference non-zero and equal lengths make the bounds identical;
- changing `<` to `<=` in the byte loop, because the extra iteration compares two out-of-range values normalized to zero;
- emptying a catch block whose only explicit behavior is returning `undefined` at the end of the function;
- stream state assignments whose removal reaches the same externally terminal path due to an independent completion flag;
- defensive head-policy branches that cannot be produced by the sanitizer's returned keys.

Tests will not use proxy traps, environment access sequencing, module replacement, or assertions against private state solely to distinguish these candidates. Fresh Stryker results may disprove an equivalence assumption; any such result will be investigated and the ledger updated.

## TDD and Implementation Sequence

Each contract group will follow red, green, and refactor:

1. add one focused failing test or property;
2. demonstrate that it kills its intended mutant in a target-specific Stryker run;
3. confirm it passes against the original source;
4. refactor fixtures only after the contract is demonstrated;
5. commit the coherent test group before moving to the next module.

Because production behavior is not expected to change, the red phase is primarily the selected mutant rather than the unmodified implementation. Every added test must pass against the original source and must have an identified non-equivalent mutant or independent coverage obligation.

## Mutation Validation

Each source will receive a fresh isolated Stryker run with:

- `--force` and a single source target;
- fixed fast-check seed and run count;
- concurrency of one for deterministic attribution;
- separate JSON and incremental output files;
- Vitest related-test selection rather than a manually incomplete test list.

The validator will compare mutants by source, mutator, location, and replacement. A tests-only change must preserve the mutant signature set. The following transitions are improvements:

- `Survived` to `Killed`;
- `NoCoverage` to `Killed`;
- `Timeout` to `Killed`.

The following are hard failures:

- any existing `Killed` mutant becoming `Survived`, `NoCoverage`, or `Timeout`;
- any new `Timeout`;
- `Pending`, `RuntimeError`, `CompileError`, or invalid zero-mutant output;
- a claimed improvement that cannot be attributed to an added test through `killedBy`.

An existing `Timeout` that remains a timeout will be retained as known liveness debt and reported separately from killed mutants.

## Verification

Focused tests will run twice with the same explicit fast-check seed before mutation validation. Final verification will include:

```bash
pnpm test:property
pnpm test
pnpm lint
pnpm build
git diff --check
```

Target-specific mutation reports will then be compared with fresh target-specific baselines. A full repository mutation run is not required for this focused tests-only change because each changed obligation maps to one of the four isolated sources and the complete run takes approximately 30 minutes. The final report will list target-level outcomes and the remaining equivalent, unreachable, timeout, and genuine test-debt classifications.

A Security Specialist review and a clean-context correctness review are required before integration. Any Must Fix security finding blocks completion. At the end of every mutation command, Stryker and Vitest process IDs and arguments will be checked so no worker process remains orphaned.

## Success Criteria

- Every listed coverage obligation has a deterministic example or bounded property.
- Meaningful targeted survivors and no-coverage mutants are killed or explicitly retained with evidence.
- No previously killed target mutant regresses and no new timeout appears.
- Tests do not duplicate implementation regexes, private state names, or environment access order.
- Existing redirect compatibility, including `/safe//`, remains unchanged.
- Property, normal, lint, build, and diff checks pass.
- Security and correctness reviews contain no unresolved Must Fix finding.
- No Stryker or Vitest process remains after verification.
