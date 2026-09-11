# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) while its pre-1.0 API remains experimental.

## [Unreleased]

### Fixed

- List region lookup no longer enters a `<slot>` or `<outlet>` insertion. `listRegionStartBetween()` and everything built on it (`listRegionStartAt()`, `ensureListRegion()`, the `runtime/list` and `runtime/list-text` adopters, a branch's direct `<for>`) step over an insertion as a whole, so a `<!--tachyon-for-->` pair inside server-inserted HTML is never counted as the parent template's list. Previously the parent's `<for>` adopted and rewrote the inserted list while its own rows stayed behind. An unterminated insertion makes the lookup return nothing rather than claim a region after it.
- A memo queued only because an upstream memo was queued recomputes only when a memo it reads actually changed. Downstream memos are queued to be checked, pull the memos they read first, and settle without running when every one recomputed to an equal value, so a memo that returns a fresh object and the effects behind it no longer run for an upstream change that made no difference. A memo notified by a signal, or by a memo whose value or failure state changed, is dirty and recomputes as before.
- A memo no longer observes a stale dependency while recomputing. Reading a queued memo recomputes that memo alone, and the memos it reads recompute first; previously a read drained the whole queued-memo list, so a memo could run in the middle of another memo's recomputation and read its old cache (`derived` at 11 while `source` was already 2). Reading a memo never runs an unrelated queued memo, so a failure of one memo can no longer surface through a read of another.
- A memo that threw keeps its failure. A second read, a dependent memo, or an effect that reads it receives the same error until a dependency changes and the recomputation succeeds; previously the memo handed out its last successful value after the first failure was reported.
- Measured client sizes grew with the memo state and the insertion-aware walkers: the browser entry (`createSignal` only) is 1237 bytes minified, the quick example 16692 bytes minified and 5772 bytes Brotli, `runtime/list` 15436 bytes minified. Budgets and baselines follow the measured sizes.
- Bindings after a `<slot>` or `<outlet>` are hydrated against the right nodes. Server, stream, and client output delimit every insertion with `<!--tachyon-outlet-->`/`<!--/tachyon-outlet-->` or `<!--tachyon-slot:name-->`/`<!--/tachyon-slot:name-->`, and hydration, text, class, event, conditional, and list path resolution all step over the inserted nodes the same way. Previously a slot filled with two elements made the next text binding update the second inserted element, and an empty slot failed hydration with a missing binding node. A `<slot>` or `<outlet>` inside an `<if>` branch or a `<for>` row leaves with the branch or row, and bindings after it inside the branch resolve to their own nodes both when the branch is adopted from the server and when it is created on the client. Snapshot tests of server output must include the markers.

## [0.3.0] - 2026-09-11

This release follows an external design review. The observable meaning of `untrack()`, `<for>` server output, and `<await>` changed; see Changed and the [region markers and reactivity migration guide](docs/migrations/region-markers-and-reactivity.md) before upgrading.

### Added

- Explain the cost decisions behind a template with `explainCompiledTemplate()` and `formatTemplateExplanation()` from `tachyon-dom/compiler`, and with `tachyon-dom explain <file> [--json]`: the runtime module each `<for>` and `<if>` region compiles to (`list-text` or `list`, `conditional-core` or `conditional`) with the reasons the lightweight module was not chosen, the runtime modules the client module imports, and the hydration diagnostics the compiler recorded.
- `detachFromEffectOwner(fn)` runs `fn` with no active effect and attaches the effects, resources, and cleanups it creates to the enclosing mount or root owner instead of the current effect run. It is the explicit form of the ownership escape `untrack()` used to perform implicitly.
- `<await pending="...">` names the HTML the stream target yields before awaiting. `fallback="..."` remains an alias with the same meaning; using both on one element is a compile error. The IR records both `pending` and `fallback`.
- Adopt the server-rendered route on client router start, so the first navigation does not re-render the page the server already produced, and the adopted history entry keeps a scroll key.
- Stability tiers in the [public API layers](docs/api.md): application, integration, and generated-only surfaces carry different compatibility promises, and the generated-only runtime entries are compatible only with the compiler version that produced the module.

### Changed

- Every `<for>` region is delimited by `<!--tachyon-for-->` and `<!--/tachyon-for-->` in server, stream, and client output, exactly as `<if>` regions are delimited by `<!--tachyon-if-->` and `<!--/tachyon-if-->`. Hydration adopts the rows between the markers instead of inferring them from element counts between static siblings. Any number of `<for>` and `<if>` regions can share a parent and sit next to whitespace, text, or static siblings; the "multiple direct dynamic regions" and "ambiguous conditional hydration region" diagnostics are gone, along with the wrapper elements they required. A `<for>` may be a direct child of an `<if>` branch. Both markers occupy no logical slot, so binding paths are unchanged; snapshot tests of server output must include the markers, and hand-written server HTML without them is not a supported hydration input. `runtime/list-path` is no longer imported by generated code and remains exported with a zero offset for one more release.
- `untrack(fn)` stops dependency tracking only. Effects, resources, and `onCleanup()` registrations created inside it belong to the enclosing effect run, exactly like those created outside it, and are released before that run repeats. Code that relied on `untrack()` to make inner work outlive the outer effect must use `detachFromEffectOwner()`.
- Reading a `createMemo()` accessor inside `batch()` or inside an effect run returns the value for the current signal state: queued memos recompute on read, in dependency order, at most once per flush. Ordinary effects still wait for the flush. A failure of the memo being read reaches the reader; a failure of another queued memo is reported by the flush that follows, never by an unrelated later one.
- The synchronous server target throws when `<await value={...}>` receives a Promise instead of rendering `[object Promise]`. The client target lowers `<await>` to a marker comment with no bindings, and `hydrate()` refuses a template that contains `<await>` because the server-rendered children would shift later siblings; `mount()` still works.
- A `<for>` placed directly inside a `<for>` row, or reached only through a transparent `<component>` directly under an `<if>` or a row, is a compile error. It previously nested its rows inside a sibling element or left the server rows unmanaged without a diagnostic.
- Server and stream output delimit every `<if>` region with `<!--tachyon-if-->` and `<!--/tachyon-if-->`, and the client template carries the same pair in place of the bare placeholder comment. A hidden branch renders the two markers, a visible branch renders them around its nodes. The end marker occupies no logical slot, so binding paths, hydration regions, and hand-written runtime paths still count an `<if>` as one node; only code that indexed raw `childNodes` past a server-rendered branch sees a different shape.
- The syntax specification separates the inline `<component name>` scope boundary from reusable `createTemplateComponent()` instances, gives `<outlet>` and `<slot>` a type, scope, update, owner, client, and trust contract, documents the per-target meaning of `<await>`, and states the target contract: a form supported by more than one target has the same meaning in each, and a target that cannot realize it reports a diagnostic.
- Measured client sizes grew with the marker-aware walkers: the browser entry (`createSignal` only) is 977 bytes minified, the quick example 15845 bytes minified and 5505 bytes Brotli, `runtime/list` 14984 bytes minified. Budgets and baselines follow the measured sizes.

### Fixed

- Hydrate `<if>` regions that whitespace text surrounds. The formatting text on either side of a hidden branch used to land in one text node, and a visible branch's own leading and trailing whitespace merged with its neighbours, so `hydrate()` reported a missing child or bound a later sibling to the wrong node. The region markers keep every text node separate, the structure check walks a region marker to marker, and adoption takes exactly the nodes between the markers, nested regions included.
- Keep later siblings aligned with a nested `<if>` that shares its parent: the region's live node count is now read from the DOM between its markers rather than from the count its last mount recorded.
- Declare `?client&mount-only` and `?client&hydrate-only` modules for the `.tachyon` and `.tachyon.html` extensions, so a template keeps its types when only its extension differs.

### Validation

- The hydration mutation campaign is re-anchored to the current source layout and extended with the review regression tests and a survivor test file: 573 mutants, raw score 89.18%, covered score 90.28%, with every remaining survivor classified by group in [the ledger](docs/hydration-mutation-testing.md).

## [0.2.0] - 2026-09-09

This is the first minor release since 0.1.8. The compiler script transform contract changed; see Changed below before upgrading a build integration.

### Added

- Generate mount-only client modules through `./Page.td?client&mount-only`. The hydration metadata, the `hydrate` entry, and the server shape-matching and adoption guards are left out of the bundle. The mode is exclusive with `hydrate-only` and with hydration chunks, and `hydrate()` rejects a mount-only module before reading or replacing server DOM.
- Omit the client entry from pages the compiler proves need no client work with `tachyonApp(app, { clientEntry: "when-required" })`. Any remaining client binding, hydration boundary, store, component boundary, or `<script setup>` keeps the entry. Add `clientEntryScope: "pages"` to declare an entry that only mounts or hydrates page modules; the default `"always"` keeps the entry because a shared entry may carry initialization a static page depends on.
- Remove constantly false `<if test={...}>` branches before the template IR is built, so the template HTML, SSR output, binding paths, hydration regions, and the runtime feature set all come from one reduced structure. Only literals and negations of literals are treated as constant; constantly true branches are kept so the DOM shape SSR adoption validates does not change.
- Give the generic keyed list and conditional runtimes generated-only entries whose descriptors require a reader on every value and a writer on every target: `mountGeneratedKeyedList`, `mountGeneratedConditional`, `mountGeneratedConditionalCore`, and `mountGeneratedTextKeyedList`. The expression-string descriptor form stays exported and unchanged for hand-written consumers.

### Fixed

- Stop merged SFC scopes from writing to their local store on reads. Getters that return fresh arrays or objects no longer re-run every binding that reads them, and reading an absent key no longer adds it to `Object.keys()` or `in` checks.
- Keep template assignments to merged scope keys visible and notifying: a write is compared against the value the binding currently sees rather than a stale override, and inspecting a merged scope no longer evaluates input getters.
- Preserve reactive props across generated SFC scopes and template-local stores when using `createTemplateComponent().update()`, without remounting or rerunning setup.
- Transform non-setup exports using syntax nodes, preserving string/comment contents and references to the original local scope identifiers.
- Preserve nested and deferred hydration ownership, rollback partially bound branches, and clear refs from their original containers on disposal.
- Preserve setup literals, runtime imports, strict-mode semantics, and indirect external scope references across compiler targets.

### Changed

- Specialize simple keyed lists and conditional branches, share reconciliation logic, and keep unused runtime features out of generated client bundles.
- Cache SFC script transforms by source revision with bounded retention, and share frozen empty transform results.
- Emit only the full setup scope from CLI and Vite entries. Those entries normalize an omitted scope to `{}` before calling the setup factory, so the narrowed no-input return never ran there and only added bytes. `transformSfcScript` now reports its policy as `scopeEmission`, and the dual factory stays an explicit opt-in for direct callers that pass `templateIdentifiers`.
- Compiler script transform results and binding arrays are now readonly and frozen. Copy before editing: `const editable = { ...result.value, setupBindings: [...result.value.setupBindings], exposedBindings: [...result.value.exposedBindings] };`.
- Separate cache benchmark transform timing from result bookkeeping and compare the same call sequences with the result cache bypassed.

### Validation

- Require the same commit's full CI workflow before preparing release artifacts: unit tests, three browsers, types, package contracts, clean consumers, starters, and bundle sizes.
- Cover real production SFC modules, component prop updates, deferred hydration, disposal, and packaged starter consumption.

### Security

- The built-in `sanitizeHtml()` remains intended for constrained HTML. Use an external sanitizer adapter for arbitrary untrusted HTML; this release does not expand the built-in sanitizer's guarantees.

## [0.1.8] - 2026-09-07

### Fixed

- Prevented SSR hydration from adopting an ambiguous static sibling when conditional branches use dynamic class/style bases or derived bindings.
- Preserved DOM identity, ownership, subscriptions, and cleanup when ambiguous hydration regions are rejected before binding.
- Preserved generated and text-only list boundaries across synchronous and asynchronous SSR paths.
- Stabilized conditional hydration diagnostics for direct, nested, and deep dynamic regions.

### Changed

- Kept lightweight conditional bundle boundaries while extending compiler-side shape checks for dynamic DOM attributes.

## [0.1.7] - 2026-09-06

### Fixed

- Isolated same-named stores across sibling components, component instances, conditional branches, and list rows while preserving owner cleanup and re-entry state.
- Preflighted SSR rows before binding and preserved adopted DOM when a later row is invalid.
- Rolled back eager binders and released interaction schedulers without retaining listeners or replaying events after disposal.
- Assigned generated binding diagnostics to stable source spans, removed diagnostics instrumentation from production output, and isolated anonymous hydration chunk identities.
- Measured representation candidates using real bundled decode and hydrate work, including no-op-safe benchmark metrics.

## [0.1.6] - 2026-08-27

### Added

- Added reproducible property-based testing with fast-check and local full-source mutation testing with StrykerJS, including coverage-ledger classification for security and stream lifecycle debt.

### Changed

- Replaced the unbounded internal stream-segment transition loop with finite phase fall-through while preserving framing, cancellation, cleanup, error, and terminal iterator behavior.

### Security

- Deduplicated case-insensitive head descriptor attributes with first-wins semantics before URL-policy validation, keeping SSR and client DOM behavior aligned and preventing later duplicate attributes from changing the validated effective value.

## [0.1.5] - 2026-08-15

### Added

- Added bounded progressive route layout and document composition with explicit `streamLayout()`, `fragmentDocument`, and `htmlDocument()` contracts across Workers, Node, and Lambda adapters.
- Added shared subtree ownership cleanup for nested conditional and keyed-list lifecycles, plus blocking clean-consumer and generated URL-policy release verification.

### Changed

- Unified URL attribute, head synchronization, meta refresh, redirect, and generated-code policy across compiler, server, client runtime, and built artifacts.
- Made buffered and streaming route results expose an explicit body kind while preserving pass-through and bodyless response metadata.
- Specialized generated text-only keyed lists so simple clients no longer bundle unused attribute, form, conditional, or URL-policy code.

### Fixed

- Preserved ancestor layouts, head/resource metadata, hydration state, backpressure, cancellation, HEAD/304 representation headers, HTML 404 content types, and trusted localhost handling across adapters.
- Accepted safe malformed-percent URLs, disposed nested reactive state in post-order, and contained bounded cleanup failures without masking primary route errors.

### Security

- Rejected script/style raw-text interpolation and incomplete trusted HTML fragments across server and compiler paths, including browser tokenizer edge cases and completed-fragment URL validation.
- Applied CSRF verification before unsafe route callbacks, aligned safe-method action dispatch, expanded URL/srcset/meta-refresh coverage, and made constant-time comparison fail closed when Web Crypto is unavailable.

## [0.1.4] - 2026-08-15

### Added

- Added safe deferred-data reads, bounded client loader caching, keyed virtual-list updates, and owner-aware reactive error boundaries.
- Added package, release, browser, hydration, and security regression contracts covering all public compiler, runtime, router, and adapter paths.

### Changed

- Made TypeScript, OXC, and language-server tooling optional peers while preserving cross-runtime HTML normalization; runtime-only installation size drops from approximately 36 MiB to 3.3 MiB.
- Made Brotli size validation tolerant of bounded encoder variation while retaining exact minified baselines and absolute budgets.

### Fixed

- Fixed hydration paths for empty text, implied table containers, SFC script elements, loop metadata, dynamic classes, refs, keyed rows, and virtualized rows.
- Preserved middleware response bytes, bodyless status semantics, malformed-path 400 responses, route parity diagnostics, form submission locking, and loader cache freshness across Workers, Node, and Lambda adapters.
- Restored public router examples, release history, and package repository metadata.

### Security

- Rejected unsafe raw-text interpolation, unquoted HTML interpolation, dangerous attributes, and unsafe URL schemes across compiler, client, buffered SSR, and streaming targets.
- Hardened forwarded protocol validation, secure session-cookie defaults, static dispatch authorization documentation, production source-map defaults, and adapter error boundaries.

## [0.1.3] - 2026-07-26

### Fixed

- Rechecked the npm tag immediately before publishing and published each release to its matching npm tag.

## [0.1.2] - 2026-07-26

### Changed

- Refreshed client layouts after query navigation and hardened release and package verification gates.

### Fixed

- Preserved request-body ownership across progressive, superseded, guarded, and terminal middleware paths.
- Kept generated form patterns frozen and aligned adapter, cookie, Vite, CLI, and runtime boundaries.

### Security

- Failed closed on malformed CSRF bodies and enforced form-key and action-body limits.
- Hardened request, cookie-signature, middleware authorization, and reconstructed-context boundaries.

## [0.1.1] - 2026-07-13

### Added

- Added reactive ownership with `createRoot()` and `onCleanup()`, including automatic ownership for effects, memos, resources, and generated component bindings.
- Added CI contracts for the browser-safe root entry and the complete counter/keyed-list client bundle, including exact minified and Brotli size tracking.
- Added focused getting-started, app/Vite, adapter, security, and whitespace migration guides.
- Added a clean, provenance-backed production benchmark snapshot and a clearer README benchmark summary.

### Changed

- Reduced the `tachyon-dom` root entry to browser-safe reactive and runtime APIs. Compiler, app, server, i18n, and Vite APIs must be imported from their documented subpaths.
- Reworked the README into a concise landing page with a quick example, abbreviated generated output, measured bundle sizes, benchmark context, and documentation links.
- Updated generated SFC imports to use compiler, runtime router, and server stream subpaths.
- Documented keyed-row events as listeners attached once per created target with handlers resolved from the current mutable row scope.

### Fixed

- Fixed braced attribute scanning for template literals, nested interpolation, comments, regular-expression literals, character classes, escaped slashes, and division expressions.
- Fixed nested lists and conditionals in later roots of multi-root keyed rows and conditional fragments.
- Prevented successful and failed compiler cache entries from being mutated by consumers.
- Ensured reactive and DOM cleanup continues after an individual cleanup callback throws.

### Security

- Replaced the request-scoped SSR README example with escaped `html` and `attr` helpers instead of interpolating query parameters directly into an HTML string.
- Clarified trusted HTML, streamed HTML, sanitizer, redirect, host, proxy, origin, form action, and CSRF boundaries in the security documentation.

## [0.1.0] - 2026-07-12

- Initial public release of the experimental HTML-first compiler, fine-grained runtime, SSR and streaming targets, router, adapters, Vite integration, CLI, and project initializer.

[Unreleased]: https://github.com/t-k/tachyon-dom/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/t-k/tachyon-dom/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/t-k/tachyon-dom/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/t-k/tachyon-dom/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/t-k/tachyon-dom/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/t-k/tachyon-dom/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/t-k/tachyon-dom/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/t-k/tachyon-dom/releases/tag/v0.1.0
