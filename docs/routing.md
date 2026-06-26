# Routing

Tachyon DOM keeps routing outside the template compiler. Templates compile to server/client targets; route modules decide which template, loader, action, head tags, resources, and hydration state belong to a URL.

## File Routes

`createFileRouteManifest(files, { rootDir })` maps route files to paths:

- `index.td` -> `/`
- `index.tachyon.html` -> `/`
- `users/[id].td` -> `/users/:id`
- `users/[id].tachyon.html` -> `/users/:id`
- `blog/[...slug].tachyon.html` -> `/blog/*slug`
- `admin/route.ts` -> `/admin`
- `admin/layout.ts` -> `/admin`

Template routes may use `.td`, `.tachyon`, or `.tachyon.html` extensions. Route and layout modules may use `.ts` or `.js`.

`scanFileRoutes(rootDir)` performs the same mapping by reading the filesystem.

## Route Modules

Use `defineRouteModule()` for route modules:

```ts
export default defineRouteModule({
  path: "/users/:id",
  loader: ({ params }) => ({ name: `User ${params.id}` }),
  action: async ({ request }) => ({ ok: true }),
  head: ({ data }) => ({ title: (data as { name: string }).name }),
  resources: [{ rel: "modulepreload", href: "/users.js" }],
  fallback: "<p>Loading</p>",
  template: ({ data }) => `<h1>${(data as { name: string }).name}</h1>`,
  ErrorBoundary: ({ error }) => `<h1>${error instanceof Error ? error.message : "Error"}</h1>`,
  NotFound: ({ url }) => `<h1>Missing ${url.pathname}</h1>`,
});
```

`routeFromModule(id, module)` adapts this convention into a `RouteDefinition`.

## Server Rendering

`renderRoute(routes, requestOrUrl, options)` returns:

- `status`
- `html`
- `headHtml`
- `resourceHints`
- `stateScript`
- `loaderData`
- `actionResult`
- `headers`

Actions run for non-GET/HEAD requests before loaders. Loaders run from parent to child. Rendering runs from child to parent with `outlet`.

`renderRouteStream()` yields route `fallback` chunks before the final rendered route HTML.

`middleware` runs before route matching and can rewrite the incoming `Request` or return a short-circuit `Response`. `hooks` expose request, match, loader, action, render, and error observations for tracing and metrics.

`requireUser(getUser, options)` creates route middleware for protected routes. It redirects to `/login` by default, can use a custom redirect target, or can return a custom forbidden response.

## Response Helpers

- `redirect("/path")` returns a 302 route response. External redirects are rejected unless `allowExternal` is set and the target origin is included in `allowedOrigins`.
- `json(data)` returns an application/json route response.
- `html(trustedHtml)` returns a text/html route response.

If an action or loader returns one of these responses, route rendering short-circuits.

HTML responses use explicit trusted HTML helpers:

- `escapeToHtml(value)` escapes text and returns `TrustedHtml`.
- `unsafeHtml(markup)` marks raw HTML as trusted and should only be used for framework-generated or otherwise trusted markup.
- `sanitizeHtml(markup)` is available from `tachyon-dom/security` for allowlist-based backend sanitization before passing content to `html()`.

The built-in sanitizer keeps path-relative URLs such as `/posts/1`, same-page fragments, and `mailto:` links. Absolute `http:`/`https:` URLs are removed unless their origin is listed in `allowedUrlOrigins`:

```ts
const trusted = sanitizeHtml(markup, {
  allowedUrlOrigins: ["https://assets.example"],
});
```

The default `sanitizeHtml(markup)` implementation is intentionally small and only suitable for constrained, simple backend markup. It is not a full browser-grade sanitizer for arbitrary untrusted HTML. For user-generated content, CMS content, imported third-party HTML, or any other attacker-controlled markup, provide a vetted sanitizer adapter:

```ts
import { createHtmlSanitizer, sanitizeHtml } from "tachyon-dom/security";

const sanitizer = createHtmlSanitizer({
  sanitize: (markup) => DOMPurify.sanitize(markup),
});

const trusted = sanitizeHtml(markup, { adapter: sanitizer });
```

`defer(record)` separates immediate values from promised values, and `resolveDeferredData()` resolves the full object. `renderRoute()` resolves deferred loader data before rendering; `renderRouteStream()` can still flush route fallbacks before the final route HTML.

`renderDeferredDataScript(id, deferred, { nonce })` serializes resolved deferred data for client-side stream handoff.

## CSP Nonces

Pass `cspNonce` to `renderRoute()` to propagate a nonce to route head scripts and route hydration state scripts:

```ts
await renderRoute(routes, request, { cspNonce: nonce });
```

## Security Options

`renderRoute()` supports:

- `allowedMethods`
- `maxActionBodyBytes`, enforced from both `Content-Length` and the actual action body bytes read by the router
- `csrf: { token }` for action requests. Token checks use timing-safe comparison for header and form tokens.
- `middleware`
- `hooks`

`createSecurityHeaders()` returns default defense-in-depth headers including `nosniff`, `Referrer-Policy`, `Permissions-Policy`, `COOP`, optional HSTS, and optional nonce-based CSP. Use `applySecurityHeaders(response, headers)` to merge them onto a response.

`tachyon-dom/security` also exports:

- `createCsrfToken()`
- `csrfInput(token)`
- `verifyCsrfRequest(request, { token })`

`tachyon-dom/cookies` exports `parseCookies()`, `serializeCookie()`, and `createMemorySessionStorage()` for small server adapters and examples.

For server sessions, `createCookieSessionStorage({ secret })` stores signed session payloads in secure, HTTP-only, SameSite=Lax cookies. `signCookieValue()` and `verifySignedCookieValue()` are also exported for custom adapters.

## Server Adapters

`tachyon-dom/adapters` provides compatibility exports for:

- `createNodeHandler({ routes })`
- `createWorkersHandler({ routes })`
- `createStaticAssetHandler({ rootDir, basePath })`

Use the runtime-specific entries for deployable server bundles:

- `tachyon-dom/adapters/node` exports `createNodeHandler()` and `createStaticAssetHandler()`.
- `tachyon-dom/adapters/workers` exports `createWorkersHandler()` without importing Node built-ins.

Both runtime handlers can apply `securityHeaders` and can use `streaming: true` to route through `renderRouteStream()`. File-system static asset serving is Node-only. On Cloudflare Workers, pass an Assets binding instead:

```ts
import { createWorkersHandler } from "tachyon-dom/adapters/workers";

export default createWorkersHandler<{ ASSETS: { fetch: (request: Request) => Promise<Response> } }>({
  routes,
  assets: { bindingName: "ASSETS", basePath: "/assets" },
  securityHeaders,
});
```

If `basePath` is omitted, 404 responses from the binding fall through to the dynamic router. If `basePath` is provided, matching requests are treated as asset requests and the binding response is returned with `securityHeaders` merged.

The Node adapter constructs `Request.url` from the incoming `Host` header and `X-Forwarded-Proto` when present. Treat those headers as trusted only when the process is behind a proxy or edge layer that normalizes and validates them. If clients can reach the Node process directly, validate or strip forwarded headers at the deployment boundary before using the adapter for security-sensitive redirects, canonical URLs, or absolute links.

## Streaming Finalization

`renderRouteStream()` returns fallback chunks immediately and exposes a `final` promise for finalized `headHtml`, `resourceHints`, `stateScript`, headers, and status. Use this when an outer server shell needs to flush route fallback early but still collect final metadata.

## Type Generation

`generateRouteTypes(manifest)` emits a TypeScript declaration shape backed by `ParamsForPath`.

`createRouteBuildManifest(routes, { buildId, assets })` creates a route build manifest containing route paths, per-route assets, and generated route types.

`createHrefBuilder(manifest)` and `hrefForRoute(manifest, id, params)` build URLs from route IDs and params. `createRoutePreloadPlan(manifest, routeId)` converts route assets into preload/modulepreload/prefetch entries for route-aware preloading.

The CLI can write file-route manifests:

```sh
tachyon-dom routes src/routes --out route-manifest.json
```

## Testing

`tachyon-dom/testing` provides:

- `renderRouteForTest(routes, path)`
- `assertRouteParity(routes, cases)`

## Vite

`tachyonDomRoutes()` creates a `virtual:tachyon-dom/routes` module:

```ts
tachyonDomRoutes({
  files,
  rootDir: "/absolute/path/to/src/routes",
});
```

The virtual module exports `manifest` plus `routes` entries whose `module` fields are lazy dynamic imports.
