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

`tachyon-dom/router/node` exports `scanFileRoutes(rootDir)` for Node-based tooling that should read the filesystem. The runtime `tachyon-dom/router` entry does not import Node built-ins, so it is suitable for Workers bundles.

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

`NotFound` is a route-branch boundary for unmatched descendants. When no route matches the complete URL, the router compares pathname segments against each route's full nested path and calls the deepest matching boundary. Dynamic segments match one segment, static prefixes match only at segment boundaries, and a boundary on `/` is the top-level fallback. A wildcard route that matches the complete URL renders normally instead of invoking `NotFound`. If no route boundary owns the pathname, `renderRoute()` uses its global `notFound` option and then the built-in 404 body.

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

`TrustedHtml` values are factory-created runtime values, not plain structural objects. Passing a hand-written object that only looks like `TrustedHtml` is rejected. Use `escapeToHtml()` for text and `sanitizeHtml()` with a vetted sanitizer adapter before rendering user-controlled HTML.

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
- `csrf: { verify }` for action requests. `verify` receives the current request, URL, and configured environment, so applications can compare a submitted token with the current session without shared mutable handler state.
- `middleware`
- `hooks`

Resolve the expected CSRF token from the current request's server-side session, then use the timing-safe request helper:

```ts
const csrf = {
  verify: async ({ request }: { request: Request }) => {
    const session = await sessions.getSession(request.headers.get("cookie"));
    const token = typeof session.data.csrfToken === "string" ? session.data.csrfToken : undefined;
    return token ? verifyCsrfRequest(request, { token }) : false;
  },
};
```

`createSecurityHeaders()` returns default defense-in-depth headers including `nosniff`, `Referrer-Policy`, `Permissions-Policy`, `COOP`, optional HSTS, and optional nonce-based CSP. CSP `nonce` and `frameAncestors` values are validated before they are inserted into the header; invalid values throw instead of producing a weakened or injected policy. Use `applySecurityHeaders(response, headers)` to merge them onto a response.

`tachyon-dom/security` also exports:

- `createCsrfToken()`
- `csrfInput(token)`
- `verifyCsrfRequest(request, { token })`

`tachyon-dom/cookies` exports `parseCookies()`, `serializeCookie()`, and `createMemorySessionStorage()` for small server adapters and examples. `parseCookies()` ignores malformed cookie pairs and decoded NUL/control-character names or values. `serializeCookie()` validates `Path` and `Domain` attributes and throws on semicolons, control characters, CRLF, whitespace in domains, or other values that would inject extra cookie attributes or invalid header bytes. Memory and cookie session storage default to Secure, HTTP-only, SameSite=Lax cookies. Memory storage treats an unknown cookie ID as untrusted and assigns a fresh ID when it is committed; call `regenerateSession()` at login or privilege changes to rotate an existing session deliberately.

For server sessions, `createCookieSessionStorage({ secret, maxAgeMs, verificationSecrets })` stores signed session payloads in secure, HTTP-only, SameSite=Lax cookies. Its signing and verification secrets must be at least 32 bytes. `maxAgeMs` adds an authenticated absolute expiry, and `verificationSecrets` permits bounded key rotation while new cookies use `secret`. Stateless signed cookies cannot revoke a copied, still-valid cookie after logout; use memory or external server-side storage, or a server-checked session version, when logout must revoke every replayed copy. The lower-level `signCookieValue()` and `verifySignedCookieValue()` helpers are also exported for custom adapters and leave secret policy to their caller.

Route cache policies are private unless `mode: "public"` is specified explicitly. Use public caching only for responses that are independent of identity, or provide an intentional cache key and `Vary` policy.

Asynchronous GET and HEAD streams commit a conservative `Cache-Control: private` policy before their first fallback chunk. Loader-dependent cache callbacks cannot retroactively promote an already committed response to public caching. Unsafe methods wait for their authoritative route result before status, headers, or fallback content are committed.

## Server Adapters

`tachyon-dom/adapters` provides compatibility exports for:

- `createNodeHandler({ routes })`
- `createWorkersHandler({ routes })`
- `createLambdaHandler({ routes })`
- `createNodeFetchHandler({ fetch })`
- `createWorkersFetchHandler({ fetch })`
- `createLambdaFetchHandler({ fetch })`
- `createStaticAssetHandler({ rootDir, basePath })`

When a Node adapter must derive absolute request URLs from the request host, pass `trustedHosts` or a fixed `origin`. Without either option, the Node adapter falls back to `localhost` instead of trusting the incoming `Host` header.

Use the runtime-specific entries for deployable server bundles:

- `tachyon-dom/adapters/node` exports `createNodeHandler()`, `createNodeFetchHandler()`, and `createStaticAssetHandler()`.
- `tachyon-dom/adapters/workers` exports `createWorkersHandler()` and `createWorkersFetchHandler()` without importing Node built-ins.
- `tachyon-dom/adapters/lambda` exports `createLambdaHandler()`, `createLambdaFetchHandler()`, and `createLambdaStreamingHandler()` for AWS Lambda Function URL and API Gateway HTTP API v2 style events.

Both runtime handlers can apply `securityHeaders` and can use `streaming: true` to route through `renderRouteStream()`. File-system static asset serving is Node-only. On Cloudflare Workers, pass an Assets binding instead:

Buffered routes and their Node, Workers, and Lambda handlers accept the compatibility option `htmlWhitespace: "condense"`. It normalizes tag-syntax whitespace only and preserves text nodes, comments, Tachyon hydration markers, and raw-text content. Use `tachyonDom({ templateWhitespace: "condense" })` to reduce formatting newlines inside compiled `.td` route templates consistently across client, server, and stream targets. Streaming does not post-process or buffer completed responses, so neither option delays the first chunk or changes backpressure and cancellation behavior.

Streaming adapters preserve downstream backpressure. Node pauses source reads after `response.write()` returns `false` and resumes on `drain`; close or error cancels the source even during that wait. Workers converts route chunks with demand-driven `ReadableStream.pull()` and forwards cancellation to the async iterator. Lambda bridges the Web response body to the AWS-managed standard Node Writable with `pipeline()`, which coordinates backpressure, completion, cancellation, and destination errors without a custom `drain()` Promise contract.

```ts
import { createWorkersHandler } from "tachyon-dom/adapters/workers";

export default createWorkersHandler<{ ASSETS: { fetch: (request: Request) => Promise<Response> } }>({
  routes,
  assets: { bindingName: "ASSETS", basePath: "/assets" },
  securityHeaders,
});
```

The `Env` type parameter is also the request-scoped `bindings` type for route middleware, loaders, actions, renderers, head/resource functions, header functions, cache functions, and CSRF verification. A handler created with an explicit `Env` requires that object as the second argument to every `fetch()` invocation. Invocation bindings are kept separate from `RouteEnvironment`: `context.env` contains only the configured string values from handler options, while `context.bindings` is exactly the environment object passed to that Workers `fetch()` invocation. Invocation bindings do not merge into or override configured string environment values. The platform-neutral router and Node and Lambda handlers do not expose a Workers binding map.

Bindings are server-only capability objects and can contain Secrets, KV, D1, R2, services, and `ASSETS`. Tachyon DOM does not serialize the binding object itself, but loader return values are hydration data. Do not return secrets or capability objects from loaders or interpolate them into HTML, head descriptors, resource URLs, or response headers. An asset request handled by the configured binding bypasses route callbacks; on a dynamic route, `context.bindings` still contains the complete invocation object, including `ASSETS`.

If `basePath` is omitted, 404 responses from the binding fall through to the dynamic router. If `basePath` is provided, matching requests are treated as asset requests and the binding response is returned with `securityHeaders` merged.

For Cloudflare Pages, `tachyon-dom/vite` also exports `packageCloudflarePages()`. It copies static assets into the Pages output directory and writes a bundled `_worker.js` with the Pages `fetch(request, env, ctx)` shape. The generated worker asks `env.ASSETS.fetch(request)` first and falls through to your renderer for configured statuses, 404 by default:

```ts
import { packageCloudflarePages } from "tachyon-dom/vite";

await packageCloudflarePages({
  assetsDir: "public",
  entry: "src/renderer.ts",
  outDir: ".tachyon/pages",
  runtimeEnvKeys: ["SSR_API_BASE_URL"],
});
```

The entry module should export `renderRequest(request, env, ctx, runtimeEnv)` or a default renderer. A minimal `wrangler.jsonc` for the generated directory is:

```jsonc
{
  "name": "tachyon-app",
  "pages_build_output_dir": ".tachyon/pages",
  "compatibility_date": "2026-06-29",
}
```

If your application already exposes a standards-based `Request -> Response` handler, use the fetch handler variants instead of adding a catch-all route. The fetch variants still apply `securityHeaders` and still serve configured static routes or assets before calling your app handler:

```ts
import { createNodeFetchHandler } from "tachyon-dom/adapters/node";

export const handler = createNodeFetchHandler({
  fetch: renderRequest,
  staticAssets: { rootDir: "dist/client", basePath: "/assets" },
  securityHeaders,
});
```

When Node static assets are mounted at the application root, pass `staticAssets: { fallthroughOnNotFound: true }` so missing files, root requests, and non-GET/HEAD application routes such as `POST /login` continue to your app handler instead of being handled by the static asset layer.

Node static assets deny dotfile and dot-directory segments, including `.well-known`, by default. This policy is applied to both the requested path and the canonical target, so a public-name symlink cannot alias `.env`, `.git`, or another hidden path. Symlinks are followed only when their non-hidden canonical target remains beneath the canonical `rootDir`; sensitive-path denials return 403 and never fall through to the dynamic handler. The static tree is expected to be immutable while a request is resolved; deployments with attacker-writable asset roots need stronger file-descriptor-level isolation.

For Vite dev servers with request-scoped SSR, `tachyon-dom/vite` exports `tachyonSsr()`. It mounts the same fetch-style handler shape as `createNodeFetchHandler()`, lets Vite handle internal module URLs by default, and serves configured static assets before the dynamic handler:

```ts
import { defineConfig } from "vite";
import { tachyonDom, tachyonSsr } from "tachyon-dom/vite";

export default defineConfig({
  plugins: [
    tachyonDom({ reactive: true }),
    tachyonSsr({
      clientScript: (request) =>
        new URL(request.url).searchParams.has("preview") ? "/client/main.js" : "/src/client/main.ts",
      fetch: async (request, { clientScript }) => {
        const locale = request.headers.get("accept-language")?.split(",", 1)[0] ?? "en";
        return new Response(
          `<main data-locale="${locale}"></main><script type="module" src="${clientScript ?? ""}"></script>`,
          {
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        );
      },
    }),
  ],
});
```

Use `createTachyonSsrMiddleware()` when a custom Vite plugin needs direct access to the Connect middleware instead of the preset plugin.

The Node adapter constructs `Request.url` from the incoming `Host` header and `X-Forwarded-Proto` when present. Treat those headers as trusted only when the process is behind a proxy or edge layer that normalizes and validates them. If clients can reach the Node process directly, validate or strip forwarded headers at the deployment boundary before using the adapter for security-sensitive redirects, canonical URLs, or absolute links.

The Lambda adapter constructs a Web `Request` from the payload format v2.0 event shape used by Function URLs and API Gateway HTTP APIs. It preserves `rawPath`, `rawQueryString`, request cookies, decoded request bodies, route headers, and `securityHeaders`:

```ts
import { createLambdaFetchHandler, createLambdaHandler } from "tachyon-dom/adapters/lambda";

export const handler = createLambdaHandler({
  routes,
  origin: "https://example.com",
  securityHeaders,
});

export const fetchHandler = createLambdaFetchHandler({
  fetch: renderRequest,
  origin: "https://example.com",
  securityHeaders,
});
```

Buffered Lambda responses return `statusCode`, `headers`, `body`, `isBase64Encoded`, and `cookies`. Text-like responses are returned as strings; binary responses and responses that already have `Content-Encoding` are base64 encoded. `Set-Cookie` headers are moved into the Lambda `cookies` array.

For Lambda response streaming, export a handler created with `createLambdaStreamingHandler()` and configure the Function URL or integration to invoke with response streaming:

```ts
import { createLambdaStreamingHandler } from "tachyon-dom/adapters/lambda";

export const handler = createLambdaStreamingHandler({
  routes,
  streaming: true,
  origin: "https://example.com",
  securityHeaders,
});
```

The streaming handler uses the AWS Node runtime's `awslambda.streamifyResponse()` and `awslambda.HttpResponseStream.from()` helpers. The managed response stream is treated as a standard Node Writable and completed by `pipeline()`; custom runtime integrations must return the same Writable contract. It should run on a Lambda Node.js runtime with response streaming enabled. Static assets should usually live in S3/CloudFront or another static origin rather than being served from the Lambda function package.

The adapter uses `rawPath` and `rawQueryString` as delivered by the Lambda event. API Gateway custom domains and stage mappings can change which prefix appears in `rawPath`; configure the gateway mapping or normalize routes before they reach the adapter if your deployment includes a stage prefix that should not be part of application routing.

## Streaming Finalization

`renderRouteStream()` returns fallback chunks immediately and exposes a `final` promise for finalized `headHtml`, `resourceHints`, `stateScript`, headers, and status. Use this when an outer server shell needs to flush route fallback early but still collect final metadata.

## Type Generation

`generateRouteTypes(manifest)` emits a TypeScript declaration shape backed by `ParamsForPath`.

If TypeScript imports Tachyon template modules directly, add the ambient module package entry once per project:

```json
{
  "compilerOptions": {
    "types": ["vite/client", "tachyon-dom/td-modules"]
  }
}
```

Single files can also use `/// <reference types="tachyon-dom/td-modules" />`. The entry declares `.td`, `.td?client`, `.td?server`, `.td?stream`, and `.td?raw` modules with the Vite plugin output types.

`tachyonDom()` automatically refreshes adjacent `.td.d.ts` files during dev and build transforms. A named SFC `scope()` export becomes the declaration's concrete `TemplateScope`; required template identifiers constrain that return type, and simple event handlers require an `(event: Event) => unknown` function. Pass `declarationOutput: false` only when another build system owns these artifacts, or provide a callback to choose a custom output path.

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
