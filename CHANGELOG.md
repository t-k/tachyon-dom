# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) while its pre-1.0 API remains experimental.

## [Unreleased]

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

[Unreleased]: https://github.com/t-k/tachyon-dom/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/t-k/tachyon-dom/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/t-k/tachyon-dom/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/t-k/tachyon-dom/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/t-k/tachyon-dom/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/t-k/tachyon-dom/releases/tag/v0.1.0
