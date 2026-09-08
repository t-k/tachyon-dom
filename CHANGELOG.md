# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) while its pre-1.0 API remains experimental.

## [Unreleased]

The next candidate is prepared below and has not been published.

## [0.2.0-rc.1] - Unreleased

Candidate artifacts are for local verification only. Replace Unreleased with the release date when approving publication.

### Fixed

- Stop merged SFC scopes from writing to their local store on reads. Getters that return fresh arrays or objects no longer re-run every binding that reads them, and reading an absent key no longer adds it to `Object.keys()` or `in` checks.
- Preserve reactive props across generated SFC scopes and template-local stores when using `createTemplateComponent().update()`, without remounting or rerunning setup.
- Transform non-setup exports using syntax nodes, preserving string/comment contents and references to the original local scope identifiers.
- Preserve nested and deferred hydration ownership, rollback partially bound branches, and clear refs from their original containers on disposal.
- Preserve setup literals, runtime imports, strict-mode semantics, and indirect external scope references across compiler targets.

### Changed

- Specialize simple keyed lists and conditional branches, share reconciliation logic, and keep unused runtime features out of generated client bundles.
- Cache SFC script transforms by source revision with bounded retention, and share frozen empty transform results.
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
