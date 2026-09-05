# Public API Layers

Tachyon DOM exposes three API layers. The root entry is for application code, runtime subpaths are for browser integrations and compiler output, and compiler/server/tooling subpaths are for build and server infrastructure. The package remains experimental, but the contracts below describe which imports are intended to remain compatible within a minor release.

## Compatibility rules

The root entry and named subpaths are the supported import surface. Existing exports are not removed or moved without a deprecation period and a release note. Type-only exports follow the same compatibility rule as value exports. Generated modules are compiler artifacts: applications may import their declared `bind`, `render`, `stream`, and metadata exports, but should not depend on private names beginning with `__tachyon`.

The `runtime/*` layer is intentionally low-level. It may accept DOM paths, compiled binding records, and trusted compiler output. Those inputs are not the recommended application-facing abstraction and must not be treated as a sanitizer or a substitute for application validation. Compiler-generated imports use these subpaths directly so a browser bundle can omit TypeScript, OXC, parse5, server, and language-server code.

## Export map

| Import | Layer | Intended use and compatibility contract |
| --- | --- | --- |
| `tachyon-dom` | application | Signals, resources, stores, forms, router, mount/hydrate, lazy hydration, reusable template components, error boundaries, enhancement registry, and Result helpers. Named exports and their public types are supported. |
| `tachyon-dom/compiler` | toolchain | Parse and compile templates and emit client, server, and stream modules. Compiler IR types are supported for integrations that consume compiler output. |
| `tachyon-dom/cli` | toolchain | Command-line compilation, type generation, and project commands. CLI behavior is compatible at the documented command boundary. |
| `tachyon-dom/app` | application/toolchain | App definitions, route files, and request-scoped document rendering. |
| `tachyon-dom/cookies` | server/browser utility | Cookie parsing and signed-cookie helpers. Browser builds remain free of Node built-ins. |
| `tachyon-dom/adapters` | server | Platform-neutral adapter composition and shared server contracts. |
| `tachyon-dom/adapters/workers` | server | Cloudflare Workers and Pages fetch handlers, bindings, and asset composition. |
| `tachyon-dom/adapters/node` | server | Node fetch handlers and static asset integration. |
| `tachyon-dom/adapters/lambda` | server | AWS Lambda response and streaming adapters. |
| `tachyon-dom/diagnostics` | tooling | Positioned compiler and target diagnostics. Diagnostics are data contracts and may be rendered by editor or CLI integrations. |
| `tachyon-dom/template-language` | editor tooling | Dependency-light completion, hover, definition, and rename features for script/template symbols. |
| `tachyon-dom/env` | server/application | Environment schema declaration and runtime validation. |
| `tachyon-dom/typed` | application/tooling | `TypedTemplate` and scope-carrying template helpers. |
| `tachyon-dom/testing` | test tooling | Template test rendering and test-only helpers. |
| `tachyon-dom/language-server` | editor tooling | Language Server Protocol integration for `.td` files. |
| `tachyon-dom/i18n` | application/server | Dictionary lookup and locale middleware. |
| `tachyon-dom/vite` | toolchain | Vite plugins, route manifests, and application packaging. |
| `tachyon-dom/router` | server/application | Platform-neutral routes, loaders, actions, heads, streaming, security, and route rendering. |
| `tachyon-dom/router/node` | server | Node router handler convenience exports. |
| `tachyon-dom/runtime/text` | generated/browser | Text-node lookup and updates used by generated client modules. |
| `tachyon-dom/runtime/class` | generated/browser | Class toggles and element lookup used by generated client modules. |
| `tachyon-dom/runtime/event` | generated/browser | Direct event listener binding used by generated client modules. |
| `tachyon-dom/runtime/conditional` | generated/browser | Conditional DOM ownership and binding updates. |
| `tachyon-dom/runtime/attr` | generated/browser | Attributes, styles, and refs. URL-sensitive values retain the URL policy contract. |
| `tachyon-dom/runtime/form` | generated/browser | Form controls, model writeback, validation, and progressive form helpers. |
| `tachyon-dom/runtime/enhancement` | browser | Progressive enhancement registration and cleanup. |
| `tachyon-dom/runtime/error-boundary` | browser | Reactive descendant error boundaries and fallback rendering. |
| `tachyon-dom/runtime/fragment` | generated/browser | Wrapper-free fragment mounting. |
| `tachyon-dom/runtime/hydrate` | generated/browser | Hydration marker location, state handoff, scheduling, and diagnostics. |
| `tachyon-dom/runtime/mount` | application/browser | Mount and hydrate entrypoints for compiler-produced client modules, with idempotent handles. |
| `tachyon-dom/runtime/component` | application/browser | Reusable component instances with independent scopes, prop updates, SSR renderers, stream renderers, and idempotent disposal. |
| `tachyon-dom/runtime/diagnostics` | development/browser | Opt-in aggregate ownership/resource observation and template binding location lookup. It is not part of normal generated imports. |
| `tachyon-dom/runtime/list` | generated/browser | Generic keyed list binding. Inputs are compiler-owned binding records and trusted template HTML. |
| `tachyon-dom/runtime/list-text` | generated/browser | Text-only keyed list binding. |
| `tachyon-dom/runtime/keyed-rows` | browser | Low-level DOM-source keyed table-row operations. |
| `tachyon-dom/runtime/virtual-list` | browser | Fixed-height virtualized list with row cleanup and destroy semantics. |
| `tachyon-dom/runtime/portal` | generated/browser | External-target DOM mounting. |
| `tachyon-dom/runtime/router` | browser | Client router implementation and client route types. |
| `tachyon-dom/runtime/signal` | browser | Signal, memo, effect, resource, and ownership primitives. |
| `tachyon-dom/runtime/store` | browser | Shallow top-level reactive store. |
| `tachyon-dom/runtime/stream-client` | browser | Stream chunk and deferred-data readers. |
| `tachyon-dom/server/stream` | server | Server stream module helpers and backpressure-aware output. |
| `tachyon-dom/server/html` | server | Escaping HTML template helper and explicit trusted HTML values. |
| `tachyon-dom/server/form-action` | server | Low-level form action and validation-state conventions. HTTP method and CSRF policy remain application responsibilities. |
| `tachyon-dom/security` | server/application | Security policy helpers and trusted boundary utilities. |
| `tachyon-dom/td-modules` | type declarations | Ambient module declarations for `.td` and target query imports. It has no runtime export. |

## Common application imports

Use the root entry for ordinary application code:

```ts
import { createResource, createSignal, mount, type Resource, type Signal } from "tachyon-dom";
```

Use an explicit subpath when the code is compiler-generated, low-level, server-only, or tooling-specific:

```ts
import { mountKeyedList } from "tachyon-dom/runtime/list";
import { compileTemplate } from "tachyon-dom/compiler";
import { html } from "tachyon-dom/server/html";
```

Do not import from `dist` files directly. The `package.json` export map is the compatibility boundary and is checked by `pnpm check:exports`, `pnpm verify:package`, and the clean-consumer verification.
