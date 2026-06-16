# Routing

Tachyon DOM keeps routing outside the template compiler. Templates compile to server/client targets; route modules decide which template, loader, action, head tags, resources, and hydration state belong to a URL.

## File Routes

`createFileRouteManifest(files, { rootDir })` maps route files to paths:

- `index.tachyon.html` -> `/`
- `users/[id].tachyon.html` -> `/users/:id`
- `blog/[...slug].tachyon.html` -> `/blog/*slug`
- `admin/route.ts` -> `/admin`
- `admin/layout.ts` -> `/admin`

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

## Response Helpers

- `redirect("/path")` returns a 302 route response. External redirects are rejected unless `allowExternal` is set.
- `json(data)` returns an application/json route response.
- `html(markup)` returns a text/html route response.

If an action or loader returns one of these responses, route rendering short-circuits.

HTML responses use explicit trusted HTML helpers:

- `escapeToHtml(value)` escapes text and returns `TrustedHtml`.
- `unsafeHtml(markup)` marks raw HTML as trusted and should only be used for framework-generated or otherwise trusted markup.

## CSP Nonces

Pass `cspNonce` to `renderRoute()` to propagate a nonce to route head scripts and route hydration state scripts:

```ts
await renderRoute(routes, request, { cspNonce: nonce });
```

## Security Options

`renderRoute()` supports:

- `allowedMethods`
- `maxActionBodyBytes`

`createSecurityHeaders()` returns default defense-in-depth headers including `nosniff`, `Referrer-Policy`, `Permissions-Policy`, `COOP`, optional HSTS, and optional nonce-based CSP. Use `applySecurityHeaders(response, headers)` to merge them onto a response.

## Server Adapters

`tachyon-dom/adapters` provides:

- `createNodeHandler({ routes })`
- `createWorkersHandler({ routes })`

Both adapters can apply `securityHeaders` and can use `streaming: true` to route through `renderRouteStream()`.

## Streaming Finalization

`renderRouteStream()` returns fallback chunks immediately and exposes a `final` promise for finalized `headHtml`, `resourceHints`, `stateScript`, headers, and status. Use this when an outer server shell needs to flush route fallback early but still collect final metadata.

## Type Generation

`generateRouteTypes(manifest)` emits a TypeScript declaration shape backed by `ParamsForPath`.

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
