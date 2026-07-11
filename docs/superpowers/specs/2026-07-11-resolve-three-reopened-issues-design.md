# Three Reopened Issues Remediation Design

## Scope

This change closes the three issues reopened by the third verification pass:

- benchmark result provenance
- safe HTML minification and progressive route streaming
- standard app template whitespace policy type safety

The static asset containment and authoritative streaming metadata issues remain closed. Their regression tests must continue to pass.

## Benchmark provenance

Schema v2 results are authoritative only when every comparator-specific required field is structurally valid and available. A required value is invalid when it is missing, `null`, has the wrong type, or represents an unavailable runtime or dependency version. An empty dependency map is also invalid.

Each benchmark comparator owns a validator describing its required provenance and workload fields. The local comparison flow additionally validates that the baseline and candidate identities match the intended comparison inputs. Cross-repository HTML comparisons require equivalent host, CPU, runtime, dependency, and workload controls before making CPU-performance claims.

Successful reports display the verified identities, runtime, dependency versions, host controls, and workload controls used to establish compatibility. Failure reports continue to identify incompatible or invalid fields. Legacy results retain their current non-authoritative compatibility behavior.

## Safe HTML condensation

Compiler whitespace condensation uses semantic protected contexts rather than only a fixed tag allowlist. RCDATA and raw-text-like elements, including `title`, preserve their text. Foreign-content descendants under `xml:space="preserve"` also preserve whitespace until a nested `xml:space="default"` explicitly restores normal handling. Attribute-name and value matching follows XML rules where applicable.

Ordinary HTML text remains eligible for condensation. Tag normalization remains independent from template text condensation. The compiler, runtime helper, and generated output must agree on the policy boundary.

## Metadata-first progressive streaming

`renderRouteStream()` gains an explicit progressive body path. Routing, loaders, redirects, status, headers, cache policy, CSP, cookies, and `Vary` are resolved before the HTTP adapter commits metadata. After that commit point, the route body is consumed as an asynchronous iterable and forwarded without collecting the complete response in memory.

Existing buffered `render` callbacks remain unchanged. Progressive routes use a separate streaming callback so existing header and cache callbacks do not accidentally depend on a partially consumed body. The callback receives the same resolved route context needed to render the body. A stream failure after metadata commitment terminates the body with an error; it cannot replace the already committed status or headers. `HEAD` resolves the same metadata but does not consume or emit body chunks.

The previous loader-pending fallback is not an authoritative HTTP response and is not emitted before metadata resolution. This explicitly replaces that obsolete behavior while retaining genuine progressive delivery after metadata becomes authoritative.

## Whitespace policy type boundary

Public tag-normalization options accept the current `HtmlWhitespacePolicy` values. Direct legacy literals `"preserve"` and `"condense"` remain accepted for source compatibility. A variable typed as the complete `TemplateWhitespacePolicy` union is rejected because template text condensation and tag normalization are separate domains.

The boundary is enforced through literal-preserving generic option types rather than branding runtime strings. This avoids runtime migration and keeps ordinary literal calls unchanged. The same constraint applies to app document rendering, Vite integration, router rendering, and Workers, Node, and Lambda adapters.

Packaged type tests include positive legacy literal calls and negative `TemplateWhitespacePolicy` variable assignments for every public entry point. Public documentation describes the separate policy domains and the limited legacy-literal compatibility rule.

## Coverage model

The coverage ledger maps every acceptance criterion to deterministic tests. PICT generates bounded combinations across HTML context, whitespace policy, compilation target, whitespace shape, and preservation state. Impossible combinations are constrained in the model.

Bounded property tests use a recorded seed and a fixed case budget. They verify that protected text is invariant, `xml:space` inheritance and reset behave correctly, ordinary text is condensed only under the template policy, and generated server, client, and stream targets agree. Generated cases supplement rather than replace named regression tests for `title` and SVG.

Benchmark tests cover missing, `null`, unavailable, mismatched, and valid provenance. Streaming tests cover metadata-before-body ordering, multiple chunks, no whole-body buffering, delayed redirect, headers, cookies, `Vary`, `HEAD`, and post-commit failures. Type tests cover both source and packed-package declarations.

## Verification and security

Implementation follows red-green-refactor. Focused tests run before each fix, followed by lint, the full test suite, build, package, exports, size, production audit, packaged starter verification, browser hydration where affected, and the six-framework benchmark smoke.

Streaming and HTML changes receive a Security Specialist review recorded as Must Fix, Should Fix, and Notes. Any Must Fix blocks closure. Benchmark processes, browsers, listeners, and Port Registry claims are stopped and checked before completion.

The three local issue files move from `docs.local/issues/open` to `docs.local/issues/closed` only after all acceptance criteria and verification steps pass. Local issue files, coverage artifacts, and work logs are not included in public commits unless their directory policy explicitly requires it.
