# Open Issue Remediation Design

## Goal

Resolve the nineteen open issues with explicit public contracts, regression coverage, safe defaults, and semantically valid benchmarks. Breaking API changes are permitted for this release.

## Scope and delivery order

The work is delivered as five independently reviewable batches. Each batch adds failing regression tests before production changes and is committed separately.

1. Security contracts: trusted error-boundary HTML, memory-session identifier rotation, session-aware CSRF verification, safe cache defaults, signed-cookie expiry and revocation boundaries, and canonical static-asset containment.
2. Application and routing contracts: safe CLI generation, a generated starter that consumes SFC modules, filesystem route discovery and registration, duplicate and missing route handling, route-level not-found behavior, and Workers invocation bindings.
3. Runtime lifecycle and termination: action cancellation, reactive resources, keyed-row numeric validation, and adapter backpressure.
4. Type and diagnostics pipeline: synchronized per-template module types and semantic source ranges.
5. Benchmark validity: request-time dynamic SSR and demand-observable streaming fixtures.

## Security contracts

Plain error-boundary fallback strings are text. Intentional markup requires the existing trusted `ClientHtml` brand, a `Node`, or a `DocumentFragment`; the boundary shares the router rendering contract rather than retaining a separate `innerHTML` path.

Memory sessions distinguish an existing server-side identifier from an untrusted cookie value. Committing an unknown identifier creates a fresh identifier. An explicit regeneration operation supports login and privilege changes without adopting attacker-controlled identifiers.

CSRF verification becomes request-aware. Route render options accept a verifier that receives the current request and route context, allowing callers to compare a submitted token with the current session while retaining no shared mutable token state. A static token is removed rather than presented as session protection.

Route cache policy is private by default. Shared caching requires an explicit `mode: "public"`; identity-dependent handlers must provide an intentional cache-key and `Vary` policy.

Signed cookie sessions acquire authenticated absolute expiry with an injectable clock and support one primary signing key plus bounded verification keys. Stateless revocation remains impossible without server-side state, so the API and documentation explicitly direct logout-sensitive applications to a session version or server-side store.

Static assets reject dotfile segments by default and serve only files whose canonical real path remains beneath the canonical root. A request denied as a sensitive asset path does not fall through to a dynamic route.

## Application and routing contracts

The CLI preflights every managed output before writing. Default conflicts return a structured error and make no writes; a deliberate force mode reports every overwritten path. `add page` uses the same route discovery model as the generated starter, so a newly added route is immediately reachable and command output names its URL.

The generated starter imports a compiled SFC module instead of passing a raw SFC source string through `compileTemplate`. The module-provided scope is its only page scope source.

Application route normalization reports every duplicate path and output filename. Unknown routes return an explicit not-found result and status rather than silently rendering home. Route-level `NotFound` becomes a defined nearest-boundary contract; if no matching boundary exists, the global handler remains the final fallback.

Workers route context carries request-scoped, generic platform bindings separately from validated string environment values. Middleware, loaders, actions, rendering, headers, and cache callbacks receive the same invocation bindings, while Node and Lambda retain their platform-specific types.

## Runtime contracts

Client actions retain their controllers. Router disposal always aborts them; a newer navigation or submission prevents stale action completion from revalidating or redirecting. Caller signals are composed with the router-owned signal.

`createResource` tracks its accessor source, schedules a reload when it changes, ignores stale completions, and disposes its tracking effect. This preserves the documented signal-driven API.

Keyed-row operation counts, chunk counts, and strides require finite positive integers before DOM mutation. Rejection messages identify the invalid parameter.

Node waits for `drain` before reading further source chunks and cancels the source on close or error. Lambda exposes a bounded wait-for-drain capability. Workers use demand-driven `pull()` and return the underlying iterator on cancellation.

## Type and diagnostics contracts

Template analysis is the only source of generated `.td` declarations. Vite, build, and typecheck consume per-file declaration data derived from the same SFC parser and invalidate it when a template changes. Scope fields preserve inferred script export types.

Parser and IR nodes retain source offsets for directive tags, attributes, and expressions. Diagnostic conversion maps those ranges consistently through CLI, Vite, test helpers, the language server, and SFC template offsets.

## Benchmark contracts

The web-framework dynamic scenario performs request-time route matching and parameter-dependent rendering for at least two identifiers. The streaming scenario emits an early shell followed by a deliberately delayed payload through each framework's production stream path. Fixture validation rejects precomputed exact-route responses for these scenarios and records multiple chunk arrival times.

The adapter backpressure benchmark uses a fixed large payload, a throttled downstream, and fixed concurrency and chunking. Every run records source pulls, queued bytes, peak RSS, and completion time. Existing result files remain untouched; corrected measurements use new run-scoped files.

## Testing and compatibility

Each public behavior has a focused Vitest regression test that fails against the baseline. Cross-boundary behavior uses the real adapter or generated starter path. Security boundaries receive at least two independent checks where practical: direct unit coverage and adapter or end-to-end coverage. Benchmark changes preserve the existing measurements as historical artifacts while making corrected rankings explicitly non-authoritative until rerun.
