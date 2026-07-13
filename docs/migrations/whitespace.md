# HTML Whitespace Policy Migration

Compiler template whitespace and rendered-document tag whitespace are separate policy domains.

- `TemplateWhitespacePolicy` accepts `"preserve" | "condense"` and transforms the parsed template tree shared by client, buffered SSR, and streaming targets.
- `HtmlWhitespacePolicy` accepts `"preserve-tags" | "normalize-tags"` and changes whitespace inside tag syntax without condensing text nodes.

## TypeScript Migration

Replace removed `LegacyHtmlWhitespacePolicy`, `HtmlWhitespacePolicyInput`, and `CompatibleHtmlWhitespacePolicy<T>` exports with `HtmlWhitespacePolicy`. Remove the obsolete policy type parameter from app, Vite, router, Workers, Node, and Lambda options. For example, migrate `WorkersHandlerOptions<Env, LegacyPolicy>` to `WorkersHandlerOptions<Env>` and `RouteRenderOptions<LegacyPolicy>` to `RouteRenderOptions`.

Use `"preserve-tags"` instead of the old document-policy literal `"preserve"`, and `"normalize-tags"` instead of `"condense"`.

## JavaScript Compatibility

Already-built JavaScript and JSON configuration retain runtime mapping: `"preserve"` maps to `"preserve-tags"`, and `"condense"` maps to `"normalize-tags"`. Deprecated `condenseHtmlWhitespace()`, `minifyHtml()`, `minify`, and `minifyHtml` aliases remain separately available. Unknown values never silently select preserve behavior.

| Public boundary | Unknown runtime policy outcome |
| --- | --- |
| App document rendering | Throws the migration error directly. |
| Vite app plugin creation | Throws before a development server or build starts. |
| Buffered router | Resolves to the generic internal-error document with status 500 because route rendering owns an error boundary. |
| Streaming router | Rejects before returning stream metadata or chunks. |
| Workers and Node buffered adapters | Return the buffered router's generic 500 response. |
| Lambda proxy buffered adapter | Returns the generic Lambda proxy response with status 500. |
| Workers, Node, and Lambda streaming adapters | Reject before committing a response when `streaming: true` selects the streaming router. |

## Compiler Condensation Semantics

`templateWhitespace: "condense"` preserves same-line spaces, non-ASCII whitespace, hydration markers, text-binding separators, and RCDATA/raw-text-like elements including `title`. It honors inherited `xml:space="preserve"` in SVG and MathML. A static `xml:space="default"` resets preservation, and `foreignObject` returns to HTML rules. Formatting runs containing line breaks become one ASCII space.

Applications whose CSS makes arbitrary whitespace significant should retain `"preserve"`.

`normalizeHtmlTagWhitespace()` is parse5-validated, changes tag syntax only, and copies every text node and comment byte-for-byte. It does not replace compiler condensation.
