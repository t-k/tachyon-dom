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

The first list runtime path, `tachyon-dom/runtime/list`, preserves keyed row elements across updates, moves reused elements into order, patches text/class bindings, removes stale rows, and keeps event handlers current through a mutable row scope. Event listeners are attached once per created row target. Reused rows retain their listeners while handlers are resolved from the current mutable row scope.

## App Layer

`tachyon-dom/app` provides a small app definition layer for examples and applications that should not need duplicated `main.ts`, `ssr.ts`, and HTML entry files. Define pages once, render SSR documents from the same definition, and let the Vite preset serve generated HTML in development and emit normalized HTML in production. With no option, development preserves tag formatting while production normalizes it. An explicit `htmlWhitespace` policy applies identically in both modes; legacy JavaScript values use the same runtime mapping, and invalid values fail during plugin creation before a server starts. The deprecated `minifyHtml` boolean also applies to both modes when explicitly set, while `htmlWhitespace` takes precedence:

Create a starter app with:

```sh
npm create tachyon-dom@latest my-app
pnpm create tachyon-dom my-app
```

```ts
import { defineApp } from "tachyon-dom/app";
import { tachyonApp, tachyonDom } from "tachyon-dom/vite";

export const app = defineApp({
  pages: [
    {
      path: "/",
      fileName: "index.html",
      template: "<section><h1>{title}</h1></section>",
      scope: { title: "Home" },
    },
  ],
});

export default {
  plugins: [tachyonDom({ reactive: true }), tachyonApp(app)],
};
```

Route-local template conventions are available through `pagesFromRouteFiles()`: `src/routes/index/page.td` maps to `/`, `src/routes/counter/page.td` maps to `/counter/`, `[id]` maps to `:id`, and `[...slug]` maps to a named wildcard. Generated starters keep these pages in `src/routes.generated.ts`; `tachyon-dom add page settings/profile` updates that registry, so the new URL is available to the app, Vite, tests, and SSR without a manual import.

`defineApp()` rejects every duplicate normalized route and output filename before compilation or serving. Path aliases such as `/`, `/index.html`, `/guide`, and `/guide/` share their normalized route keys. `renderAppDocument()` throws for an unknown path instead of falling back to home. SSR adapters should use `renderAppResponse()`, which returns `{ status, html }`; missing routes retain status 404 and render either the configured `notFound` page or the built-in not-found document.

`examples/full-app` is a multi-page browser example with SSR initial HTML for every page, a persistent layout, client-side routing, counters, keyed lists, forms, settings, and compiler/stream diagnostics. Run it with `pnpm example:full-app`, then open the Vite dev server root. Source pages are route-local `.td` templates, and the example Vite config generates dev/build HTML entries instead of keeping `index.html` files in source. Production output is available with `pnpm example:full-app:build`; the example config builds every generated page entry and safely condenses HTML tag syntax during build.

Use `tachyonDom({ templateWhitespace: "condense" })` when formatting newlines and indentation in directly imported `.td` templates should be reduced. Standard applications that compile raw route source must pass the same `templateWhitespace` value to `defineApp()` or `loadRouteApp()`. The compiler applies this opt-in policy to one shared template tree before client, buffered server, and streaming server generation. It preserves same-line spaces, non-ASCII whitespace, hydration markers, text-binding separators, RCDATA and raw-text-like elements including `title`, and inherited `xml:space="preserve"` content in SVG and MathML. A static `xml:space="default"` resets foreign-content preservation, and `foreignObject` returns to HTML whitespace rules. Formatting runs that contain line breaks become a single ASCII space, so applications whose CSS makes arbitrary whitespace significant should retain the default `"preserve"` policy.

`normalizeHtmlTagWhitespace()` is a separate, parse5-validated helper that changes whitespace inside tag syntax only and copies every text node and comment byte-for-byte. The older `condenseHtmlWhitespace()`, `minifyHtml()`, `minify`, and `minifyHtml` names remain deprecated compatibility aliases. App `whitespace: "normalize-tags"`, Vite app `htmlWhitespace: "normalize-tags"`, and router `htmlWhitespace: "normalize-tags"` perform tag normalization only; they do not reduce inter-element indentation. `HtmlWhitespacePolicy` is deliberately distinct from compiler `TemplateWhitespacePolicy`, and tag-normalization options accept only `"preserve-tags" | "normalize-tags"`. Migrate the removed legacy option literal `"preserve"` to `"preserve-tags"` and `"condense"` to `"normalize-tags"`; deprecated boolean and helper aliases remain available separately. A route may provide a separate `stream` async iterable. Loaders and authoritative status and headers resolve before body iteration starts, and chunks are forwarded without collecting the completed body. Iteration failures terminate the body without injecting error HTML, and consumer cancellation closes the source iterator even if the body has not been pulled.

### HTML whitespace policy migration

TypeScript consumers must replace the removed `LegacyHtmlWhitespacePolicy`, `HtmlWhitespacePolicyInput`, and `CompatibleHtmlWhitespacePolicy<T>` exports with `HtmlWhitespacePolicy`, remove the obsolete policy type parameter from app, Vite, router, Workers, Node, and Lambda option types, and use `"preserve-tags"` or `"normalize-tags"`. For example, migrate `WorkersHandlerOptions<Env, LegacyPolicy>` to `WorkersHandlerOptions<Env>` and `RouteRenderOptions<LegacyPolicy>` to `RouteRenderOptions`. Runtime compatibility remains for already-built JavaScript and JSON configuration: `"preserve"` maps to `"preserve-tags"`, and `"condense"` maps to `"normalize-tags"`. Unknown values never silently select preserve behavior, but the observable error depends on the public boundary:

| Public boundary                              | Unknown runtime policy outcome                                                                                  |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| App document rendering                       | Throws the migration error directly.                                                                            |
| Vite app plugin creation                     | Throws the migration error directly before a development server or build starts.                                |
| Buffered router                              | Resolves to the generic internal-error document with status 500 because route rendering owns an error boundary. |
| Streaming router                             | Rejects with the migration error before returning stream metadata or chunks.                                    |
| Workers and Node buffered adapters           | Return the buffered router's generic 500 response.                                                              |
| Lambda proxy buffered adapter                | Returns the generic Lambda proxy response with status 500.                                                      |
| Workers, Node, and Lambda streaming adapters | Reject before committing a response when `streaming: true` selects the streaming router.                        |

## Recommended App Shape

For applications, keep route markup in route-local `.td` files and let Vite run the Tachyon DOM plugins on the main development path:

```text
src/
  routes/
    index/
      page.td
      page.td.d.ts
  routes.generated.ts
  client/
    main.ts
  app.ts
vite.config.ts
```

Use `src/routes/**/page.td` as the source of truth for page markup. Use `src/client/main.ts` for client-side runtime code that should be bundled by Vite. Do not put application code in `public/client/main.js`; reserve `public/` for static assets such as images, icons, manifests, and service workers.

Add Tachyon DOM template module types when TypeScript imports `.td` files directly:

```ts
/// <reference types="tachyon-dom/td-modules" />
```

For project-wide setup, add `"tachyon-dom/td-modules"` to `compilerOptions.types` alongside `"vite/client"`. The type entry covers `.td`, `.td?client`, `.td?server`, `.td?stream`, and `.td?raw` imports. During normal Vite development and builds, `tachyonDom()` writes an adjacent `.td.d.ts` for each transformed template. These declarations preserve exported SFC `scope()` types, require every referenced template field, and type event handlers. The generated starter and `add page` command create the initial declarations so a clean project typechecks before its first Vite run. `tachyon-dom typegen` remains available for non-Vite tooling but is not required by the standard workflow.

## Typed Templates and Environment Validation

`tachyon-dom/typed` exposes the typed-template helpers used by generated template declarations:

```ts
import { defineTemplate, templateScope, type TypedTemplate } from "tachyon-dom/typed";

type PageScope = {
  title: string;
  count: number;
};

const page = defineTemplate<PageScope, "<h1>{title}</h1>">("<h1>{title}</h1>");
const scoped = templateScope<PageScope>().define("<p>{count}</p>");

const typed: TypedTemplate<PageScope> = page;
void typed;
void scoped;
```

`tachyon-dom/env` provides a small runtime environment validator with a public/private split:

```ts
import { defineEnvSchema, readEnv } from "tachyon-dom/env";

const schema = defineEnvSchema({
  PUBLIC_APP_NAME: { default: "Tachyon App", public: true },
  SESSION_SECRET: { required: true },
});

const result = readEnv(process.env, schema);
if (!result.ok) {
  throw new Error(result.error.map((error) => error.message).join("\n"));
}

result.value.publicEnv.PUBLIC_APP_NAME;
result.value.env.SESSION_SECRET;
```

Only keys marked `public: true` are exposed under `result.value.publicEnv`. By default public keys must use the `PUBLIC_` prefix; pass `publicPrefix` to `readEnv()` when an app uses a different convention.

## Runtime APIs

The root entry exports browser-safe reactive and runtime APIs, including `createSignal()`, `createMemo()`, `effect()`, `batch()`, `untrack()`, `createResource()`, `createRoot()`, `onCleanup()`, `catchError()`, and the client router. Compiler, app, server, and Vite APIs live under their documented subpath entries so importing a signal does not pull their dependency graphs into browser tooling.

Use `createResource(source, loader)` for signal-driven async data with `data`, `error`, `loading`, and `refetch` accessors. Source changes abort superseded loads; the loader receives an `AbortSignal`, and `resource.dispose()` detaches tracking and aborts in-flight work. Resources created inside `createRoot()` are disposed automatically. Effects, memos, resources, and `onCleanup()` callbacks created inside a root share its lifetime; generated component bindings create a root around their scope factory and DOM bindings.

```ts
import { createMemo, createResource, createRoot, createSignal, onCleanup } from "tachyon-dom";

const dispose = createRoot((disposeRoot) => {
  const userId = createSignal("42");
  const user = createResource(userId, loadUser);
  const label = createMemo(() => user.data()?.name ?? "Loading");

  onCleanup(() => console.log(`Disposed ${label()}`));
  return disposeRoot;
});

dispose();
```

Use `untrack(fn)` to read signals without subscribing the active effect, and use `catchError(fn, onError)` when an effect should recover and keep tracking after a thrown error.

`createErrorBoundary()` is available from the root entry and `tachyon-dom/runtime/error-boundary` for DOM-mounted fallback UI around client enhancements. `createI18n()` and `localeMiddleware()` are available from `tachyon-dom/i18n` for dictionary lookup, interpolation, and request locale selection.

Adapters are lower-level deployment APIs for Node, Workers, and Lambda composition. They are useful when composing Tachyon DOM with an existing Request-to-Response handler, but an adapter-only app with TypeScript string templates is not the standard framework shape. If you are migrating an existing SSR app, start by replacing hand-written enhancement registries with `tachyon-dom/runtime/enhancement`, then move one screen at a time into `.td` templates, and finally wire those screens through the app or route layer.

## Routing

Routing is provided as a separate layer instead of being baked into the template compiler. The server router in `tachyon-dom/router` supports static routes, `:param` routes, wildcard routes, nested layouts through `outlet`, route loaders, form actions, auth guards, 404/error boundaries, head descriptor rendering, route hydration state scripts, trusted HTML responses, backend HTML sanitization helpers and adapters, CSRF guards, signed cookie sessions, middleware, observability hooks, deferred data helpers, CSP nonce propagation, resource hints, streaming finalization, build manifests, typed href builders, route preload plans, and route type generation. The client router in `tachyon-dom/runtime/router` supports same-origin link interception, History API navigation, `popstate`, abortable route loaders/actions, action-driven revalidation, loader cache/prefetch/invalidation, Vite route HMR revalidation, scroll-to-top hooks, focus restoration, history-entry `restoreScroll`, navigation announcements, title/head updates, nested layout outlets, optional `viewTransition`, and 404/error rendering.

The Vite integration also exposes `tachyonDomRoutes()` for a `virtual:tachyon-dom/routes` module. It emits a manifest plus lazy dynamic imports, which keeps route modules split into separate chunks.

During Vite dev server runs, `tachyonDom()` logs simple request lines such as `GET / 200 4ms` through Vite's logger. Query strings are omitted by default to avoid leaking tokens or other sensitive parameters. Disable request logs with `tachyonDom({ requestLog: false })`, pass `requestLog: { logger }` to route messages to a custom sink, or set `requestLog: { includeQuery: true }` when query strings are explicitly useful.

For request-scoped dynamic SSR, use `tachyonSsr()` in the Vite plugin list. It mounts a fetch-style `Request -> Response` handler in Vite dev, passes Vite module URLs such as `/@vite/client`, `/src/`, and `/node_modules/` through to Vite, and can serve public assets before the dynamic handler through the Node adapter static asset semantics:

```ts
import { defineConfig } from "vite";
import { attr, html } from "tachyon-dom/server/html";
import { tachyonDom, tachyonSsr } from "tachyon-dom/vite";

const clientScript = (request: Request) =>
  new URL(request.url).searchParams.has("prod") ? "/client/main.js" : "/src/client/main.ts";

export default defineConfig({
  plugins: [
    tachyonDom({ reactive: true }),
    tachyonSsr({
      clientScript,
      fetch: async (request, { clientScript }) => {
        const user = new URL(request.url).searchParams.get("user") ?? "Guest";
        const body = html`
          <main>Hello ${user}</main>
          <script type="module"${attr("src", clientScript ?? "")}></script>
        `;

        return new Response(String(body), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    }),
  ],
});
```

Server adapters live in `tachyon-dom/adapters` as compatibility exports, with runtime-specific entries at `tachyon-dom/adapters/node`, `tachyon-dom/adapters/workers`, and `tachyon-dom/adapters/lambda`. The Workers entry avoids Node built-ins and can serve Cloudflare Assets bindings before dynamic routes; the Node entry keeps file-system static asset serving; the Lambda entry supports Function URL and API Gateway HTTP API v2 style events, including AWS Lambda response streaming. When a Node app serves public files from a root `staticAssets.basePath`, set `staticAssets.fallthroughOnNotFound: true` to let missing files such as `/healthz`, `/`, or non-GET/HEAD app routes like `POST /login` continue to the app handler while still serving files that exist. `tachyon-dom/runtime/form` includes progressive form enhancement, `tachyon-dom/runtime/enhancement` adds small opt-in client behavior for SSR markup via `data-td-enhance`, and `tachyon-dom/runtime/hydrate` includes boundary mismatch diagnostics for SSR tests and development builds.

For Cloudflare Pages, `tachyon-dom/vite` exposes `packageCloudflarePages()` to copy static assets and generate a Pages `_worker.js` that tries `env.ASSETS` before delegating to a Tachyon DOM SSR renderer.

Server-rendered string helpers live under `tachyon-dom/server/html` and `tachyon-dom/server/form-action`. The HTML helper escapes interpolation by default, provides explicit `attr()`, `booleanAttr()`, `classList()`, `join()`, and `rawHtml()` helpers, and does not require DOM globals. The form action helper keeps validation in userland while standardizing `FormData` parsing, safe value preservation, accessible field error attributes, and path-relative redirect responses for classic SSR forms.

## Testing Templates

`tachyon-dom/testing` includes helpers for fast server-side assertions without starting Vite. Use `renderTdForTest(filePath, scope, { locale })` in Vitest when you want to assert the SSR HTML for a `.td` template directly:

```ts
import { expect, it } from "vitest";
import { renderTdForTest } from "tachyon-dom/testing";

it("escapes user content in the account view", async () => {
  await expect(
    renderTdForTest("src/account-view.td", {
      userName: `<img src=x onerror=alert(1)>`,
    }),
  ).resolves.toContain("&lt;img src=x onerror=alert(1)&gt;");
});
```

The helper reads and compiles the template with Tachyon DOM diagnostics, then renders it through the server target. Compiler errors include the template file path, line, column, source line, and pointer so failures are suitable for normal unit-test output.

## Security Notes

`sanitizeHtml(markup)` has a small built-in allowlist sanitizer for constrained, already-simple backend HTML. Do not rely on the default sanitizer for arbitrary untrusted HTML. For user-generated or third-party markup, pass a vetted adapter through `createHtmlSanitizer()`/`sanitizeHtml(..., { adapter })`, such as a DOMPurify-backed sanitizer in the target runtime.

Progressive route `stream()` strings are trusted raw HTML. Node, Workers, and Lambda adapters never escape or sanitize chunks. Escape untrusted text explicitly:

```ts
import { escapeToHtml, trustedHtmlChunk, type RouteDefinition } from "tachyon-dom/router";

const route: RouteDefinition = {
  path: "/search",
  loader: ({ url }) => url.searchParams.get("q") ?? "",
  render: () => "",
  stream: async function* ({ data }) {
    yield `<p>${trustedHtmlChunk(escapeToHtml(data))}</p>`;
  },
};
```

`escapeToHtml()` is for HTML text content, not unquoted attributes, script/style source, URLs, or other parser contexts. For intentionally accepted markup, use a vetted sanitizer adapter and pass its factory-created `TrustedHtml` through `trustedHtmlChunk()`; forged structural objects are rejected.

`tachyon-dom/server/html` is an escaping helper, not a sanitizer. Use `rawHtml()` only for trusted framework or application output. Sanitize user-generated HTML before it reaches `rawHtml()`.

The built-in sanitizer rejects protocol-relative URLs and removes absolute `http:`/`https:` URLs unless their origin is explicitly listed in `allowedUrlOrigins`. `redirect()` similarly accepts path-relative targets by default; external redirects require `allowExternal: true` plus an `allowedOrigins` entry for the target origin.

The Node adapter derives request URLs from `Host` only when you pass `trustedHosts`, or from a fixed `origin` when configured. Without either option it falls back to `localhost` instead of trusting the incoming `Host` header. Only enable `trustProxy` behind a trusted proxy or edge that normalizes forwarded headers.

The Lambda adapter derives request URLs from `event.requestContext.domainName` by default and falls back to the `Host` header for minimal local events. Pass `origin` when the public origin differs from the Lambda event domain, for example behind CloudFront or a custom domain.

## Commands

```sh
pnpm install
pnpm test
pnpm build
pnpm lint
pnpm check:exports
pnpm check:size
pnpm bench:local
pnpm bench:local:dev
pnpm bench:local:full
pnpm bench:local:gate
pnpm bench:local:smoke
```

The package CLI also exposes:

```sh
tachyon-dom compile view.td --target client --out view.js
tachyon-dom routes src/routes --out route-manifest.json
tachyon-dom typegen src/routes/index/page.td --out src/routes/index/page.td.ts
tachyon-dom add page settings/profile --routes-dir src/routes
npm create tachyon-dom@latest my-app
pnpm create tachyon-dom my-app
tachyon-dom init --template basic --out my-app
tachyon-dom dev --host 127.0.0.1 --port 5173
tachyon-dom build
tachyon-dom preview --host 127.0.0.1 --port 4173
tachyon-dom language-server --stdio
```

`npm create tachyon-dom@latest my-app` and `pnpm create tachyon-dom my-app` create a route-local starter with `src/routes/index/page.td`, `src/client/main.ts`, `src/app.ts`, `vite.config.ts`, `tsconfig.json`, `.gitignore`, a smoke test, CI workflow, `README.md`, and `package.json`. `tachyon-dom init --template basic --out my-app` is the equivalent installed-package command. Use `tachyon-dom init --template ssr --out my-app` when you also want a small `src/server.ts` SSR composition entry.

`tachyon-dom init` and `tachyon-dom add page` preserve existing files by default. A starter conflict aborts before any file is written. Pass `--force` only when you deliberately want to overwrite the listed managed files; the command reports every overwritten path.

`tachyon-dom add page` also reports the normalized route URL, adjacent declaration file, and generated registry it changed. For example, `users/[id]` reports `/users/:id/`, while `blog/[...slug]` reports `/blog/*slug/`.

Template files use the short `.td` extension. The Vite plugin and file router also accept `.tachyon` and `.tachyon.html` for compatibility.

`tachyon-dom language-server --stdio` starts a minimal Language Server Protocol server for editor integrations. The first version reports Tachyon template diagnostics for `.td`, `.tachyon`, and `.tachyon.html` documents; completion, hover, and semantic tokens are intentionally left to later editor-support slices.

`pnpm bench:local` builds every implementation in production mode (bundled and minified, matching what applications ship), serves them from a temporary Vite preview server, measures Tachyon DOM against local copies of the keyed vanilla benchmark implementations in Playwright Chromium, prints ratio tables, and writes JSON results under `benchmark/local-compare/results/`. Production is the canonical mode because dev-server module loading adds overhead that does not exist in a shipped app.

`pnpm bench:local:dev` runs the same comparison against the unbundled dev server for fast local iteration (no production build step).

`pnpm bench:local:full` runs the canonical production comparison with extra warmup and measured iterations for noisier performance investigations.

`pnpm bench:local:smoke` runs the same local comparison with one warmup and one measured iteration for manual benchmark smoke checks. The CI workflow exposes it through `workflow_dispatch`; normal push and pull request runs skip the benchmark.

`pnpm bench:local:gate` runs the local comparison with operation and memory regression thresholds.

The local benchmark prints row-operation timings plus auxiliary metrics for startup, JS heap usage, DOM node counts, and local source size. JSON output also keeps per-run values with mean, median, min, max, and p95.

`pnpm check:exports` runs `publint --strict` and `attw --pack --no-emoji` against the package exports and declaration files. `pnpm check:size` runs per-subpath size budgets for the root entry, selected runtime helpers including `runtime/signal`, `runtime/list`, `runtime/error-boundary`, the client router, `i18n`, and the server HTML helper. CI runs both gates after `pnpm build` and `pnpm verify:package`.

Version tags matching `v*` publish through GitHub Actions with npm Trusted Publishing and `npm publish --access public` after the same build, package, exports, and size checks pass. Because both the repository and packages are public, npm automatically generates provenance for these OIDC publishes. Configure the same Trusted Publisher (`t-k/tachyon-dom`, `release.yml`) for both npm packages. The workflow keeps `NPM_TOKEN` only for final npm dist-tag operations.

## Example

```sh
pnpm example:web
```

Open `http://127.0.0.1:5173/examples/web/` to try the browser example. It shows the compiled SSR preview, hydrate boundary markers, store updates, keyed list updates, stream chunks, and generated client module shape in one page.

Open `http://127.0.0.1:5173/examples/auth-todo/` for the authenticated todo example. Browser example HTML entries are generated by the Vite dev plugin, so these examples do not need hand-written `index.html` files.

```sh
pnpm example:stream
```

The CLI example in `examples/store-hydrate-stream.ts` prints the streamed SSR HTML for the same store/hydrate/streaming slice.

`examples/router.ts` shows nested route rendering with a loader, route head tags, and route hydration state.
