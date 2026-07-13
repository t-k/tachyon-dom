# Security

- Template text interpolation and `tachyon-dom/server/html` interpolation escape by default.
- `rawHtml()`, `trustedHtmlChunk()`, and route `stream()` chunks are trust boundaries.
- Sanitize user-generated markup with a vetted runtime adapter.
- Configure public origins and trusted proxy/host behavior explicitly.
- Apply method and CSRF/Origin checks before direct form actions.

## Escaping and Trusted HTML

`tachyon-dom/server/html` escapes interpolated text and values created with `attr()`. It is an escaping helper, not an arbitrary HTML sanitizer. Use `rawHtml()` only for trusted framework or application output.

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

The built-in sanitizer rejects protocol-relative URLs and removes absolute HTTP(S) URLs unless their origin appears in `allowedUrlOrigins`. `redirect()` accepts path-relative targets by default. External redirects require `allowExternal: true` and an explicit `allowedOrigins` entry.

## Hosts, Proxies, and Origins

The Node adapter uses `Host` only with `trustedHosts`, or uses a configured fixed `origin`; otherwise it falls back to `localhost`. Enable `trustProxy` only behind a trusted proxy that normalizes forwarded headers.

The Lambda adapter uses `event.requestContext.domainName` and falls back to `Host` for local events. Configure `origin` when the public origin differs, including CloudFront and custom-domain deployments.

## Forms and CSRF

`tachyon-dom/server/form-action` standardizes `FormData` parsing, safe value preservation, accessible error attributes, and path-relative redirects. Direct `formAction()` handlers do not add method, CSRF, or Origin checks. Enforce them before invoking the handler. Router actions can use the router-level `csrf` option.

## Security Tests

Use `renderTdForTest()` to verify escaped SSR output without starting Vite. Add tests for every intentional trusted-HTML boundary, allowed external origin, proxy mode, and direct form action policy.
