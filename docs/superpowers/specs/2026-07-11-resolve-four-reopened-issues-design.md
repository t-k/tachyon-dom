# Four Open Issues Remediation Design

## Scope

This change closes four open issues:

- benchmark result provenance and schema validation
- representative performance evidence for progressive route streaming
- semantic separation of template and tag whitespace policies
- the progressive route stream trusted HTML contract

Existing HTML semantic preservation, authoritative metadata, cancellation, generated starter, and adapter regressions must remain green.

## Benchmark validation and reporting

Every authoritative benchmark comparator validates decoded runtime data rather than trusting TypeScript declarations. The streaming-backpressure comparator owns a complete workload and measurement schema. Connection counts, chunk counts, byte sizes, and timing controls must be finite integers in their documented ranges. Measurements used as ratio denominators must be finite and strictly positive; other byte and count measurements must be finite and non-negative. Invalid inputs fail before ratio calculation, so JSON serialization cannot silently turn `Infinity` or `NaN` into `null`.

The local comparison validator continues to validate baseline and candidate identities and additionally includes the verified Git commit, dirty state, working-tree hash, browser identity, runtime, host, dependencies, and workload in its machine-readable success report. Nested browser and measurement shapes receive benchmark-specific structural validation.

Bounded property tests generate malformed decoded JSON values, including strings, nulls, negative values, zero denominators, non-finite values, missing fields, and valid boundary values. Named regressions remain for important failures and report contents.

## Representative progressive streaming benchmark

The Tachyon web-framework fixture uses `RouteDefinition.stream` through the Node adapter with `streaming: true`. It no longer bypasses the router through a fixture-specific `/stream` response branch. The stream callback emits the existing delayed multi-chunk response so the common contract continues to measure first-byte timing and completion without whole-body buffering.

A production smoke is generated from a clean committed source tree. The run-scoped result records authoritative provenance and explicitly identifies the route-stream adapter path. Dirty or unavailable provenance remains non-authoritative. Existing benchmark results are not overwritten.

## Whitespace policy type separation

Tag-normalization APIs accept only `HtmlWhitespacePolicy`, whose values are `"preserve-tags"` and `"normalize-tags"`. Direct legacy `"preserve"` and `"condense"` inputs are removed from app, Vite, router, Workers, Node, and Lambda tag-normalization options.

This compatibility break is necessary because TypeScript narrows `const policy: TemplateWhitespacePolicy = "condense"` to the same structural literal type as a direct legacy call. The type system cannot distinguish the value's origin while accepting that literal. Callers that intentionally migrate an old HTML policy must use an explicit conversion helper returning `HtmlWhitespacePolicy`; template policies are never accepted by that helper's input type.

Source tests and tests against an actually installed package tarball cover direct legacy literals, literal-narrowed template constants, control-flow-narrowed mutable variables, partial mixed unions, `HtmlWhitespacePolicy` variables, and every public app, Vite, router, Workers, Node, and Lambda boundary.

## Progressive stream trusted HTML contract

`RouteDefinition.stream` continues to return `AsyncIterable<string>`. Each chunk is a trusted raw HTML sink and adapters do not escape, sanitize, or reinterpret it. The JSDoc adjacent to the API states this explicitly and warns against direct interpolation of untrusted values.

The public routing documentation and README show two deliberate paths:

- escape untrusted text with `escapeHtml()` before interpolation;
- pass intentionally accepted markup through a vetted sanitizer before yielding it.

The change does not automatically escape complete HTML chunks and does not introduce buffering. Bounded attacker-input property tests generate tags, attributes, entities, control characters, and chunk boundary combinations. Parsing the documented escaped output must not create attacker-controlled element nodes. Tests also retain progressive ordering and cancellation behavior.

## Coverage and verification

The Coverage Ledger maps all acceptance criteria to named regressions, bounded properties, installed-package type probes, benchmark smoke evidence, or explicit non-authoritative outcomes. Property tests use recorded seeds and fixed budgets.

Implementation follows red-green-refactor with scoped commits. Final verification includes the full Vitest suite, lint, build, package artifacts, exports, size, production audit, installed-tarball type verification, both generated starters with real Chromium, and the six-framework production smoke from a clean tree.

Benchmark and trusted HTML changes receive a Security Specialist review recorded as Must Fix, Should Fix, and Notes. Any Must Fix blocks closure. Task-owned servers, browsers, child processes, listeners, and Port Registry claims are stopped before completion.

The four local issue files move from `docs.local/issues/open` to `closed` only after all acceptance criteria pass. The completed branch is merged into `main` and pushed to `origin/main`, as requested. Existing untracked `docs/issues/` content remains untouched.
