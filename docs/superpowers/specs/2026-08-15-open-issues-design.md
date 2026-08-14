# Open Issue Remediation Design

## Status

Approved for implementation design on 2026-08-15.

## Problem

The 29 issue records under `docs.local/issues/open/` describe a mixture of security defects, implementation gaps, undocumented contracts, runtime lifecycle defects, package footprint problems, and fragile verification. None of the records is a duplicate or already satisfied by the current implementation.

Several issues share boundaries. HTML parser semantics affect compiler hydration paths, server rendering, and browser behavior. A native `Response` may pass through router middleware and three adapters. Reactive errors, keyed row ownership, refs, and virtual-list reuse share lifecycle rules. Addressing the reports as unrelated string or branch patches would leave equivalent paths inconsistent.

## Goals

- Resolve every open issue with an explicit implementation or documentation contract.
- Preserve existing public APIs when a safe compatible design is available.
- Fail closed at security boundaries instead of silently accepting ambiguous input.
- Keep client, direct server, generated server, stream, Workers, Node, and Lambda behavior consistent where they expose the same contract.
- Add coverage that observes browser parsing, raw bytes, clean package installation, resource bounds, and runtime lifecycle rather than relying only on output strings.
- Preserve benchmark history and compare performance changes under the same environment and corpus.
- Make each logical change independently reviewable and reversible.

## Non-goals

- Do not split the compiler and language server into a new published package in this change set.
- Do not make a coordinated major-version API redesign.
- Do not change static asset dispatch order until a dedicated pre-dispatch authorization phase has been designed.
- Do not add a new property-testing or formal-verification dependency unless deterministic regression coverage exposes a remaining gap.
- Do not modify unrelated untracked files under `docs/issues/`.

## Design principles

### Context-aware output policies

HTML escaping, URL validation, dangerous attribute rejection, raw-text handling, cookie validation, and proxy-header parsing must know the context in which a value will be interpreted. A generic string replacement or context-free `isSafeUrl()` boolean is not an adequate security boundary.

Shared policy primitives will provide consistent canonicalization and dangerous-name classification. Callers will still supply element, attribute, URL purpose, and origin policy because those allowlists differ by context.

### Cross-target parity

When a contract applies to multiple lowering or adapter paths, the same corpus will drive every path. Tests will cover interpreted server rendering, generated server rendering, generated streaming output, client mounting or hydration, Workers, Node, and Lambda as applicable.

### Observable runtime ownership

Effects, keyed rows, refs, form submissions, loader cache entries, and virtual-list rows require explicit ownership, disposal, and stale-completion rules. Errors must be delivered to an owner boundary or an unhandled-error channel after the scheduler drains; they must not disappear or abort unrelated work.

### Parser and transport oracles

HTML security and hydration tests will use a real parser or real browser DOM. Binary transport tests will compare bytes rather than decoded text. Package-footprint tests will install a packed tarball into a clean consumer rather than use workspace symlinks.

## Issue contracts

| Issue | Classification | Approved contract |
| --- | --- | --- |
| 001 | Implementation | Emit a stable comment anchor only for empty interpolated text. Replace it with a `Text` node during hydration and preserve existing non-empty output. |
| 002 | Security and implementation | Report a positioned compile error for ordinary interpolation inside `script` and `style`. Preserve static raw text and direct JSON users to the existing safe serialization path. |
| 003 | Implementation and mental model | Treat only the first top-level script after whitespace or comments as setup. Preserve scripts inside template content instead of silently dropping them, and document placement rules. |
| 004 | Security and implementation | Ignore forwarded protocol headers when `trustProxy` is false. When true, accept only one trimmed, case-normalized `http` or `https` value; return 400 for empty, invalid, or multi-valued input. |
| 005 | Security and implementation | Track HTML tokenizer state across the complete template literal. Preserve automatic quoting for direct `name=${value}` and reject interpolation into an already-started unquoted attribute value. Reject branded fragments in invalid contexts. |
| 006 | Security and implementation | Merge partial cookie options onto secure defaults and keep commit and destroy attributes symmetric. Reject `__Host-` and `__Secure-` configurations that violate prefix requirements. |
| 007 | Implementation | Preserve a middleware native `Response` in the internal result and maintain its status, headers, and bytes across buffered, streaming, Workers, Node, and Lambda paths. |
| 008 | Implementation | Normalize 204, 205, and 304 results to a null body at the router boundary and remove invalid length and transfer headers. Convert unexpected pre-header Node failures to a 500 response. |
| 009 | Implementation and mental model | Normalize common table tree-construction cases in the compiler AST. Produce a positioned diagnostic for forms such as foster parenting that cannot be normalized safely. Verify real-DOM binding paths. |
| 010 | Implementation and mental model | Produce a positioned compile error for hydration, component, or store metadata inside `for` until per-row ownership is supported. Never emit silently incomplete metadata or duplicate IDs. |
| 011 | Documentation | Replace the invalid README `createRouter` import and verify every public Markdown import against built exports. |
| 012 | Package design | Move compiler and language-server heavyweight dependencies to optional peers and development dependencies. Keep runtime-only installation lightweight and report missing package names and install commands when compiler entry points are used. Defer a package split to a future major version. |
| 013 | Security and implementation | Share one dangerous-attribute policy and produce compile errors for static or dynamic `on*`, `srcdoc`, `innerhtml`, and `outerhtml` across all targets. |
| 014 | Security and implementation | Share URL parsing and canonicalization while requiring element, attribute, purpose, and allowed-origin context in a Result-returning API. Do not publish a universal context-free safety boolean. |
| 015 | Security and mental model | Lock the existing static-route and asset precedence into adapter-parity tests and a dispatch diagram. A future protected-static option requires a separately designed pre-dispatch phase. |
| 016 | Security and implementation | Default production inline source maps to off while preserving explicit opt-in and the independent `onSourceMap` callback. |
| 017 | Performance and implementation | Bound the client loader cache with LRU semantics, a default maximum of 100 entries, and zero as disabled. Apply the same bound to navigation, prefetch, and hydration seeds. |
| 018 | Documentation and process | Add the missing 0.1.2 and 0.1.3 changelog entries and enforce a release-entry contract against the package version. |
| 019 | Security and implementation | Preserve malformed-path decoding as a generic 400 response instead of converting it to 404 or reflecting decoding details in public HTML. |
| 020 | Test utility | Correct the expected and received direction in route-parity diagnostics and audit equivalent helpers with table-driven coverage. |
| 021 | Performance test | Keep minified-byte checks exact. Allow Brotli variance up to the greater of 16 bytes or 1 percent while retaining an absolute budget and recording Node and zlib versions. |
| 022 | Runtime design | Catch failures per runner, drain the scheduler queue, and deliver errors to the nearest live owner boundary. Report ordered unhandled failures after draining and never swallow them. |
| 023 | Runtime implementation | Register keyed-list state cleanup with the root owner so effects created for later rows are disposed when the root is disposed. |
| 024 | Browser and runtime | Acquire a pending lock after successful form validation, reject additional submits while pending, preserve original disabled states, and use a generation guard against stale completion. |
| 025 | Performance and browser | Preserve keyed DOM identity and invoke an optional `updateItem(element, item, index)` hook for reused rows. Without the hook, document that rendered row output must be immutable or reactive. |
| 026 | Runtime implementation | Make ref setters return identity-guarded cleanup and register it for top-level, conditional, and list-generated refs. |
| 027 | Public API design | Add `readDeferredDataScriptResult()` to distinguish missing and invalid data with a Result. Make the existing helper a deprecated no-throw `T | undefined` wrapper. |
| 028 | Package metadata | Add the correct `repository.directory` to the create package and verify metadata across workspace packages. |
| 029 | Compiler and runtime | Escape dynamic base classes in server and stream targets and combine base-class updates with class-directive toggles in one class state across all targets. |

## Compatibility decisions

The design intentionally introduces compile-time diagnostics where the current behavior is unsafe or silently incomplete: dynamic `script` or `style` content, dangerous attributes, unsupported HTML tree-construction forms, and hydration metadata inside loops. These diagnostics replace behavior that cannot be made reliable without a larger syntax or ownership design.

Existing entry points remain whenever they can become safe without ambiguity. `readDeferredDataScript()` remains as a no-throw compatibility wrapper. Direct `name=${value}` HTML attributes retain automatic quoting. Static asset precedence remains unchanged. The runtime package keeps its current package name and export structure.

## Coverage obligations

| Area | Hard gate |
| --- | --- |
| Parser and XSS | Issues 002, 005, 013, and 014 use an HTML parser oracle, negative corpora, and target-parity assertions. |
| Bytes and status | Issue 007 compares invalid UTF-8 and binary payloads byte for byte. Issue 008 verifies null bodies for 204, 205, and 304 across adapters. |
| Real DOM | Issues 001, 009, 024, 025, and 029 use Playwright. Hydration tests observe initial SSR DOM and the post-hydration update separately. |
| Clean installation | Issue 012 builds and packs the package, installs the tarball into an empty consumer, and verifies runtime-only and compiler modes independently. |
| Runtime semantics | Issue 022 proves queue drain, boundary routing, retry, and unhandled reporting. Issue 024 proves rapid-submit and stale-completion behavior. Issue 025 proves identity and freshness independently. |
| Resource bounds | Issue 017 proves deterministic LRU eviction and issue 025 measures render or update counts in addition to elapsed time. |
| Release contract | Issues 011, 018, 021, and 028 add machine-checked documentation, release, size, and metadata contracts. |

Coverage may overlap because each scenario protects a different obligation. PICT, TLA+, Alloy, Dafny, property-based testing, and fuzzing are not required for the initial bounded parser corpus, adapter matrix, and lifecycle scenarios. If deterministic coverage exposes another input dimension, property-based testing will be proposed separately before adding a dependency.

## Benchmark policy

Before changing performance-sensitive paths, record a baseline with the same Node version, build mode, corpus, warmup, and iteration count used after the change. Create a new run-specific directory and never overwrite an existing result.

Benchmark gates apply to SFC parsing, server HTML tokenizer state, compiler tree normalization, package install footprint, loader-cache operations and heap growth, quick-example compression, and virtual-list update counts or timing. A meaningful unexplained regression stops implementation for a design review.

## Implementation sequence

1. Security boundaries: 002, 004, 005, 006, 013, 014, 016, and 019.
2. Transport and adapters: 007, 008, and 015.
3. Compiler and hydration: 001, 003, 009, 010, and 029.
4. Reactive runtime and browser interactions: 017, 022, 023, 024, 025, 026, and 027.
5. Documentation, package, release, and test utilities: 011, 012, 018, 020, 021, and 028.

Each issue or tightly coupled shared policy follows a red-green-refactor cycle and receives a focused commit after its relevant tests pass.

## Verification

Implementation is accepted only when:

- focused issue tests and all cross-target parity matrices pass;
- browser tests close every session and task-started process;
- clean-consumer package tests pass without workspace symlinks;
- applicable before and after benchmarks are recorded without overwriting historical results;
- `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm check:exports`, `pnpm check:size`, `pnpm check:browser-entry`, and `pnpm check:quick-example-size` exit successfully;
- a security review reports no Must Fix findings;
- a clean-context correctness review reports no blocking defect;
- each resolved issue file is moved from `docs.local/issues/open/` to `docs.local/issues/closed/` only after its acceptance criteria and broader regressions pass;
- the worktree contains no unintended changes and no task-started development server, browser, or MCP process remains.

## Implementation ownership

The main agent is the single source writer. Read-only specialists may inspect security, tests, benchmarks, and the final diff. Parallel source writers are not used because the compiler, renderer, router, adapters, and runtime share public contracts that require coordinated commits.
