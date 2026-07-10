# Compiler-Aware HTML Whitespace Condensation Design

## Goal

Reduce formatting whitespace in real production SSR HTML without corrupting Tachyon hydration markers, text-binding anchors, raw-text elements, inline word boundaries that authors express explicitly, or streaming behavior. The implementation must affect the Token Tracker console production server path and must be measured against its real login document rather than only synthetic tag-spacing fixtures.

## Current Gap

`condenseHtmlWhitespace()` validates HTML with parse5 and normalizes whitespace only inside start and end tags. It deliberately copies text nodes byte-for-byte. This is a useful safe tag normalizer, but it does not reduce indentation and line breaks between elements. The current name and production-minification claims overstate its effect.

The Token Tracker console also bypasses this helper. It renders route fragments with `renderRoute()` using the default preserve behavior, wraps them with its own `documentHtml()` function, and returns the completed document without a final whitespace policy. Its production bundle therefore cannot benefit from Tachyon app generation defaults.

## Selected Architecture

Use two explicit layers with different guarantees.

### 1. Compiler-level template condensation

Add a target-neutral template whitespace policy:

```ts
type TemplateWhitespacePolicy = "preserve" | "condense";
```

The policy is applied to parsed static `TextNode` values before client, buffered server, and streaming server targets lower the template. All three targets therefore receive the same node structure and cannot disagree about binding paths.

The `condense` rules are:

- Preserve all text in `pre`, `textarea`, `script`, and `style` descendants.
- Preserve Tachyon-generated comments and hydration markers because the pass only transforms source `TextNode` values.
- Preserve same-line spaces exactly, including an author-written single space between inline elements.
- For a text node containing line-break formatting whitespace only, replace the complete run with one ASCII space. This removes indentation/newlines while retaining a word boundary.
- For a text node containing visible text, remove leading and trailing line-break indentation and collapse each internal line-break-plus-indentation run to one ASCII space.
- Preserve non-ASCII whitespace.
- Keep `preserve` as the default for compiler APIs and existing Vite use unless an application explicitly opts in.

The policy is explicit because CSS can make whitespace significant on elements other than the HTML raw-text set. The library must not claim byte-for-byte DOM equivalence for `condense`; it guarantees consistent client/server/stream lowering and preservation of explicitly authored same-line spaces.

Expose the policy through compiler entry points and `tachyonDom({ templateWhitespace: "condense" })`. Generated client, server, and stream modules use the same configured policy.

### 2. Document-shell compaction

Retain parse5-backed tag normalization as a separate operation named `normalizeHtmlTagWhitespace()`. Keep `condenseHtmlWhitespace()` and `minifyHtml()` as deprecated compatibility aliases until the next breaking release, but document that they normalize tag syntax only.

Application-owned document builders should avoid introducing formatting separators in production. The Token Tracker console will add an explicit document whitespace option and join its trusted shell segments with an empty string in production. Route HTML, head HTML, state scripts, and other injected fragments remain untouched by this shell operation; their whitespace is controlled by the compiler policy that produced them.

The console production path will:

1. compile `.td` templates with `templateWhitespace: "condense"`;
2. build `documentHtml()` with compact trusted shell separators;
3. leave development output preserved for readability;
4. return the compact completed document from `createHandleRequest()`.

Streaming routes remain unbuffered. No generic response-body minifier is introduced.

## Alternatives Rejected

### Generic post-render whitespace removal

Rejected because HTML text-node significance depends on raw-text contexts, inline word boundaries, CSS `white-space`, foreign content, comments, and hydration structure. A post-render pass cannot safely distinguish author intent and would either remain ineffective or repeat the destructive regular-expression implementation.

### Tag normalization only

Retained as a narrowly named helper but rejected as the solution to production indentation. It produces zero change for already-normalized tags, including the measured console login document.

### Console-only compact string construction

Useful for the outer shell but insufficient for route template indentation. It would improve one application without fixing Tachyon compiler output or client/server parity.

## API Compatibility

- Existing compiler behavior remains `preserve` by default.
- `tachyonDom()` gains `templateWhitespace?: TemplateWhitespacePolicy`.
- Direct compiler APIs gain an optional policy without changing existing call sites.
- `normalizeHtmlTagWhitespace()` becomes the accurate public helper name.
- Existing `condenseHtmlWhitespace()` and `minifyHtml()` remain aliases with deprecation documentation.
- Router `htmlWhitespace` is renamed or documented as tag normalization only; it must not claim template-text condensation.

## Testing and Coverage

The implementation follows TDD and records these obligations:

- A real indented list template loses line breaks and indentation under `condense` but remains unchanged under `preserve`.
- Explicit same-line spaces between inline elements remain present.
- `pre`, `textarea`, `script`, and `style` content remains byte-identical.
- Hydration markers and `<!---->` text separators remain present.
- Client, server, and stream outputs derive the same text-node structure.
- Streaming still flushes early and preserves backpressure and cancellation.
- Vite applies the policy to `?client`, `?server`, and `?stream` transforms.
- The console development document remains readable while production uses compact shell separators.
- The console production handler returns reduced login HTML and retains CSP nonce, hydration, event, dynamic-text, and keyed-list behavior.
- A production build test proves `dist/server/production.js` contains and uses the configured policy.

## Benchmark and Acceptance

Add a run-scoped benchmark using the actual Token Tracker login document inputs. Record:

- exact source revisions and dirty states for Tachyon DOM and Token Tracker;
- normalized command, Node version, dependency versions, and timestamp;
- raw, gzip, and Brotli bytes;
- newline count;
- transformation/build time;
- before and after DOM/hydration assertions.

Acceptance requires a non-zero reduction for the real login document in raw bytes and line count, successful production browser hydration and interactions, and no regression in existing package size, streaming, or security checks. Synthetic fixtures remain useful for edge coverage but cannot be the primary performance evidence.

## Deployment and Operations

The console dependency is a local link during development, so both repositories must be built in dependency order. Verification must remove stale output ambiguity:

1. install dependencies in both isolated worktrees;
2. build Tachyon DOM and verify its emitted `dist` contains the new compiler policy;
3. build the console against that worktree rather than the root checkout;
4. run the console production server or production handler test from the new bundle;
5. record artifact timestamps and Git revisions;
6. do not deploy or push unless separately requested.

All started servers and browser processes must be stopped after verification.
