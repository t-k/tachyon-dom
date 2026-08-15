# Security

- Template text interpolation and `tachyon-dom/server/html` interpolation escape by default.
- `rawHtml()`, `trustedHtmlChunk()`, and route `stream()` chunks are trust boundaries.
- Sanitize user-generated markup with a vetted runtime adapter.
- Configure public origins and trusted proxy/host behavior explicitly.
- Apply method and CSRF/Origin checks before direct form actions.

## Static Dispatch Authorization Boundary

Static routes and assets are outside route middleware authorization. Adapters resolve configured `staticRoutes` first, then static assets, and only then run route middleware and route matching. Keep protected content out of these public static sources; `requireUser()` and other route middleware do not guard them.

Use a narrow asset `basePath`. With Workers asset bindings, an omitted asset base path matches every request path before middleware, although configured fallthrough responses such as 404 continue to the dynamic router. Node static assets mounted at `/` have the same broad public trust boundary.

## Escaping and Trusted HTML

`tachyon-dom/server/html` escapes interpolated text and values created with `attr()`. It is an escaping helper, not an arbitrary HTML sanitizer. Interpolation inside `script` and `style` raw-text elements is rejected because HTML escaping does not protect JavaScript or CSS source contexts. Keep those elements static, load external assets, or use the router's hydration-state serialization instead of hand-interpolating JSON into a script. Use `rawHtml()` only for trusted framework or application output.

Direct `name=${value}` interpolation is quoted automatically. Quote the complete attribute value when a template contains a prefix or suffix, such as `src="/assets/${file}.png"`; interpolation into an unquoted value is rejected. `rawHtml()` is accepted only in text context, while fragments returned by `attr()` and `booleanAttr()` are accepted only between attributes inside an opening tag.

Native `on*`, `srcdoc`, `innerhtml`, and `outerhtml` attributes are rejected by the compiler, client runtime, and direct server HTML helpers, regardless of case or whether their value is static, dynamic, empty, or disabled. Use `on:event={handler}` for compiler-managed event listeners. This directive is compiled into listener registration and is not emitted as an executable HTML attribute.

`sanitizeHtml(markup)` has a small allowlist for constrained, already-simple backend HTML. For user-generated or third-party markup, pass a vetted adapter through `createHtmlSanitizer()` or `sanitizeHtml(..., { adapter })`, such as a DOMPurify-backed implementation in the target runtime.

Progressive route `stream()` strings are trusted raw HTML. Node, Workers, and Lambda adapters do not escape or sanitize chunks. Escape text before branding a chunk:

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

`escapeToHtml()` is only for HTML text content. It is not sufficient for unquoted attributes, script/style source, URLs, or other parser contexts. Factory-created `TrustedHtml` values are required where trusted markup is accepted; forged structural objects are rejected.

## URLs and Redirects

HTML escaping does not make an active URL scheme safe. The compiler, client attribute runtime, generated server and stream renderers, and `attr()` reject `javascript:`, `vbscript:`, executable `data:`, control-obfuscated schemes, protocol-relative references, decoded backslashes, and malformed percent encoding in `href`, `src`, `action`, `formaction`, and `xlink:href`. Direct `html` URL interpolation must supply the complete attribute value; build prefixes and suffixes before interpolation so the final URL can be validated as one value.

Use the public `sanitizeUrlAttribute(context)` Result API when validating a URL before it reaches one of those boundaries. The context must identify the element, attribute, value, and its `document-navigation`, `subresource`, or `form-submission` purpose. Omitting `allowedOrigins` accepts HTTP(S) origins after scheme validation, which is appropriate for author-controlled template and head URLs. Passing an empty `allowedOrigins` array rejects absolute HTTP(S) URLs; passing explicit origins accepts only exact matches. `mailto:` and `tel:` are limited to document navigation. Invalid attribute-purpose combinations return an `UnsafeUrlError` instead of falling back to a context-free boolean.

The built-in sanitizer rejects protocol-relative URLs and removes absolute HTTP(S) URLs unless their origin appears in `allowedUrlOrigins`. `redirect()` accepts path-relative targets by default. External redirects require `allowExternal: true` and an explicit `allowedOrigins` entry.

## Hosts, Proxies, and Origins

The Node adapter uses `Host` only with `trustedHosts`, or uses a configured fixed `origin`; otherwise it falls back to `localhost`. Enable `trustProxy` only behind a trusted proxy that normalizes forwarded headers.

The Lambda adapter uses `event.requestContext.domainName` and falls back to `Host` for local events. Configure `origin` when the public origin differs, including CloudFront and custom-domain deployments.

## Forms and CSRF

`tachyon-dom/server/form-action` standardizes `FormData` parsing, safe value preservation, accessible error attributes, and path-relative redirects. Direct `formAction()` handlers do not add method, CSRF, or Origin checks. Enforce them before invoking the handler. Router actions can use the router-level `csrf` option.

## Security Tests

Use `renderTdForTest()` to verify escaped SSR output without starting Vite. Add tests for every intentional trusted-HTML boundary, allowed external origin, proxy mode, and direct form action policy.
