# Tachyon DOM

Tachyon DOM is a small TypeScript UI runtime started from the hot paths in `js-framework-benchmark`. The first implementation focuses on keyed row workloads: bulk creation, replacement, partial text updates, row selection, swap, removal, append, and clear.

The core idea is to keep a static DOM template and bind dynamic fields directly into reusable template chunks before cloning. That gives the benchmark path the same mechanical advantages as the fastest vanilla implementations while keeping the API reusable outside a single hand-written table.

## Current Target

The initial runtime optimizes:

- chunked row creation with detached `tbody` replacement
- direct `Text.nodeValue` writes for dynamic fields
- local selected-row class changes
- `insertBefore` swaps for keyed row movement
- `textContent = ""` clears

Byte weight is intentionally secondary for now. The runtime is split so benchmark-specialized code can remain separate from future general-purpose modules.

## Compiler Direction

The framework direction is HTML-first syntax with Solid-style fine-grained reactivity and Marko-style separated server/client compiler targets. The first compiler slice lives in `tachyon-dom/compiler` and can:

- parse a single-root HTML-like template
- extract `{expr}` text bindings
- extract `class:name={expr}` class bindings
- extract `on:event={handler}` event bindings
- extract `<for each={items} key={item.id}>` keyed list boundaries
- extract `<store count={initialCount}/>` store tags without adding DOM nodes
- record `hydrate:id={islandId}` hydration boundaries for server/client handoff
- record `<component name="Panel" prop={value}>` transparent component boundaries with props and local stores
- generate `<await value={promise} then="name">` streaming fragments in the server stream target
- render an escaped server string for the same template
- generate a chunk-yielding streaming server target as a separate compiler output
- generate client code that imports only the runtime helper modules it needs
- optionally generate fine-grained client bindings through `tachyon-dom/runtime/signal`

The fixed syntax surface is documented in [`docs/syntax-spec.md`](docs/syntax-spec.md).

Routing is documented in [`docs/routing.md`](docs/routing.md), and runtime modules are summarized in [`docs/runtime.md`](docs/runtime.md).

The compiler output is intentionally close to the current direct DOM runtime: static markup stays static, dynamic text/class/event slots are recorded as explicit paths, and generated client code can import subpath helpers such as `tachyon-dom/runtime/text`.

The first server streaming adapter, `tachyon-dom/server/stream`, accepts sync or async HTML chunks and adapts them to `ReadableStream<Uint8Array>` or `Response` without building a single full HTML string first.

The first list runtime path, `tachyon-dom/runtime/list`, preserves keyed row elements across updates, moves reused elements into order, patches text/class bindings, removes stale rows, and keeps event handlers current through a mutable row scope. Row events are delegated through the list container so reused rows do not need one listener per row.

## Routing

Routing is provided as a separate layer instead of being baked into the template compiler. The server router in `tachyon-dom/router` supports static routes, `:param` routes, wildcard routes, nested layouts through `outlet`, route loaders, form actions, auth guards, 404/error boundaries, head descriptor rendering, route hydration state scripts, trusted HTML responses, backend HTML sanitization helpers and adapters, CSRF guards, signed cookie sessions, middleware, observability hooks, deferred data helpers, CSP nonce propagation, resource hints, streaming finalization, build manifests, typed href builders, route preload plans, and route type generation. The client router in `tachyon-dom/runtime/router` supports same-origin link interception, History API navigation, `popstate`, abortable route loaders/actions, action-driven revalidation, loader cache/prefetch/invalidation, Vite route HMR revalidation, scroll-to-top hooks, focus restoration, navigation announcements, title updates, and 404/error rendering.

The Vite integration also exposes `tachyonDomRoutes()` for a `virtual:tachyon-dom/routes` module. It emits a manifest plus lazy dynamic imports, which keeps route modules split into separate chunks.

During Vite dev server runs, `tachyonDom()` logs simple request lines such as `GET / 200 4ms` through Vite's logger. Query strings are omitted by default to avoid leaking tokens or other sensitive parameters. Disable request logs with `tachyonDom({ requestLog: false })`, pass `requestLog: { logger }` to route messages to a custom sink, or set `requestLog: { includeQuery: true }` when query strings are explicitly useful.

Server adapters live in `tachyon-dom/adapters` for Node and Cloudflare Workers-style runtimes, with optional static asset serving and security header merging. `tachyon-dom/runtime/form` includes progressive form enhancement, and `tachyon-dom/runtime/hydrate` includes boundary mismatch diagnostics for SSR tests and development builds.

## Security Notes

`sanitizeHtml(markup)` has a small built-in allowlist sanitizer for constrained, already-simple backend HTML. Do not rely on the default sanitizer for arbitrary untrusted HTML. For user-generated or third-party markup, pass a vetted adapter through `createHtmlSanitizer()`/`sanitizeHtml(..., { adapter })`, such as a DOMPurify-backed sanitizer in the target runtime.

The Node adapter derives request URLs from `Host` and `X-Forwarded-Proto`. Only use those headers behind a trusted proxy or edge that normalizes them; otherwise validate the host/proto boundary before routing.

## Commands

```sh
pnpm install
pnpm test
pnpm build
pnpm lint
pnpm bench:local
pnpm bench:local:full
pnpm bench:local:gate
pnpm bench:local:smoke
```

The package CLI also exposes:

```sh
tachyon-dom compile view.tachyon.html --target client --out view.js
tachyon-dom routes src/routes --out route-manifest.json
tachyon-dom dev --host 127.0.0.1 --port 5173
tachyon-dom preview --host 127.0.0.1 --port 4173
```

`pnpm bench:local` starts a temporary Vite server, measures Tachyon DOM against local copies of the keyed vanilla benchmark implementations in Playwright Chromium, prints ratio tables, and writes JSON results under `benchmark/local-compare/results/`.

`pnpm bench:local:full` runs the same comparison with extra warmup and measured iterations for noisier performance investigations.

`pnpm bench:local:smoke` runs the same local comparison with one warmup and one measured iteration for feature-PR checks.

`pnpm bench:local:gate` runs the local comparison with operation and memory regression thresholds.

The local benchmark prints row-operation timings plus auxiliary metrics for startup, JS heap usage, DOM node counts, and local source size. JSON output also keeps per-run values with mean, median, min, max, and p95.

## Example

```sh
pnpm example:web
```

Open `http://127.0.0.1:5173/examples/web/` to try the browser example. It shows the compiled SSR preview, hydrate boundary markers, store updates, keyed list updates, stream chunks, and generated client module shape in one page.

```sh
pnpm example:stream
```

The CLI example in `examples/store-hydrate-stream.ts` prints the streamed SSR HTML for the same store/hydrate/streaming slice.

`examples/router.ts` shows nested route rendering with a loader, route head tags, and route hydration state.
