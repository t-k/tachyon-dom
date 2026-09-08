# Tachyon DOM

Tachyon DOM is an experimental HTML-first compiler that turns static templates into direct DOM updates, using a small fine-grained runtime shared with SSR and streaming targets.

> Experimental status: the compiler and runtime are ready for evaluation, examples, and incremental adoption, but public APIs may change before a stable release.

## Why Tachyon DOM?

- HTML stays recognizable while dynamic fields become explicit DOM paths.
- Fine-grained updates write to cached text, attribute, class, and list targets without a virtual DOM.
- One parsed template feeds client, buffered SSR, and streaming server targets.
- Browser-safe runtime imports keep compiler and server dependencies out of client bundles.

## Quick Example

This `.td` component combines a signal-backed counter with a keyed list:

```html
<script setup lang="ts">
  const count = createSignal(0);
  const rows = createSignal([
    { id: 1, label: "Alpha" },
    { id: 2, label: "Beta" },
  ]);
  const increment = (): void => count.update((value) => value + 1);
</script>

<main>
  <button on:click={increment}>{count}</button>
  <ul>
    <for each={rows} key={row.id}>
      <li>{row.label}</li>
    </for>
  </ul>
</main>
```

The server targets escape interpolated text. The client target records direct paths to the button text and list container, then updates only those targets when their signals change.

## What the Compiler Emits

The real output uses modular runtime imports and explicit cleanup ownership. Abbreviated, the hot path looks like this:

```js
const countText = __tachyonTextAt(root, [0, 0]);
cleanups.push(__tachyonEffect(() => __tachyonSetText(countText, __tachyonRead(scope.count))));

cleanups.push(__tachyonEffect(() => __tachyonMountTextKeyedList(listRoot, [], __tachyonRead(scope.rows), listOptions)));
cleanups.push(() => __tachyonCleanupTextKeyedList(listRoot, []));
```

Static markup remains in a reusable template. Events are attached once per created target, keyed rows retain their DOM nodes while moving, and the generated binding root disposes effects, resources, events, and controls together.

See the [syntax specification](docs/syntax-spec.md) for supported expressions and exact target behavior.

## Measured Size

`import { createSignal } from "tachyon-dom"` bundles to **940 bytes minified** in the current esbuild contract.

Quick example client bundle: 13964 bytes minified, 4955 bytes Brotli, including the counter, text-only keyed-list binding code, and browser runtime. CI requires the minified baseline exactly, permits 1% Brotli variance across Node/zlib patch versions, enforces absolute 16000-byte minified and 5200-byte Brotli budgets, and rejects TypeScript, parse5, compiler, server, app, language-server, and runtime diagnostics modules from both browser metafiles. `pnpm check:client-bundle-attribution` records ten smaller fixtures, including a one-template and a thirty-template page whose difference is the per-template descriptor and glue cost, and a varied page of eight structurally different templates (forms, dynamic attributes, nested control flow, refs, richer expressions) that shows the per-template cost the repeated page understates, with the same build settings and keeps their esbuild contribution data and provenance in a unique ignored artifact.

```sh
pnpm build
pnpm check:browser-entry
pnpm check:quick-example-size
```

These numbers are produced from repository scripts, not estimated from source files. Subpath size budgets remain available through `pnpm check:size`.

## Keyed List Benchmark

On this machine, Tachyon DOM performed within 3% of the comparison implementations across nine keyed-row operations.

| Compared with        | Tachyon DOM result |
| -------------------- | -----------------: |
| vanillajs-lite-keyed | 1.8% faster |
| solid-keyed | 0.9% faster |
| marko-keyed | 2.5% slower |

Results are the geometric mean of nine operations: row creation, replacement, partial updates, selection, swapping, removal, append, clear, and creation of many rows. Lower execution time is better.

The recorded run used:

- AMD Ryzen 9 9950X
- Chromium 149.0.7827.55
- Production Vite builds
- 2 warmup runs and 7 measured runs per operation
- 20% trimmed means to reduce outlier influence

The [complete JSON artifact](benchmark/local-compare/results/2026-07-13-readme-baseline.json) includes raw samples, variability, dependency versions, and clean Git provenance.

Reproduce the same benchmark contract locally:

```sh
pnpm bench:local
```

This is a repository-local comparison based on the `js-framework-benchmark` row-operation model. It is not an official upstream result or a general ranking of framework performance. See the [benchmark methodology](benchmark/README.md) for details.

## Install

Create a route-local starter:

```sh
npm create tachyon-dom@latest my-app
cd my-app
pnpm install
pnpm dev
```

The equivalent pnpm command is `pnpm create tachyon-dom my-app`. For an installed package, use `tachyon-dom init --template basic --out my-app` or select the `ssr` template.

The normal project shape keeps route markup in `src/routes/**/page.td`, client code in `src/client/main.ts`, and generated route registration in `src/routes.generated.ts`. Start with the [getting-started guide](docs/getting-started.md).

## Compiler and Runtime Boundaries

The package root contains browser-safe reactive and runtime APIs such as `createSignal()`, `createMemo()`, `createResource()`, `createRoot()`, `onCleanup()`, and the client router. Heavier tools use explicit subpaths:

```ts
import { createClientRouter, createSignal } from "tachyon-dom";
import { compileTemplate } from "tachyon-dom/compiler";
import { defineApp } from "tachyon-dom/app";
import { html } from "tachyon-dom/server/html";
import { tachyonDom } from "tachyon-dom/vite";
```

This boundary keeps TypeScript, parse5, language-server, app, and server graphs away from a browser consumer that only needs reactivity.

Runtime-only consumers do not install TypeScript, OXC, or language-server tooling. Add the optional peers for the features you use:

```sh
pnpm add typescript oxc-parser
pnpm add vscode-languageserver vscode-languageserver-textdocument
```

TypeScript powers SFC script transformation and OXC parses advanced template expressions. The second command is only needed for `tachyon-dom/language-server`. Missing peers fail at the relevant feature boundary with the package name and install command; importing the root runtime remains available without them. parse5 remains a normal dependency because the synchronous `normalize-tags` policy is supported in Workers as well as Node and Lambda.

## Documentation

- [Getting started](docs/getting-started.md): starter creation, project shape, route files, template types, and testing.
- [Syntax specification](docs/syntax-spec.md): HTML-first syntax, expressions, directives, components, hydration, and streaming constructs.
- [Runtime](docs/runtime.md): signals, ownership, DOM helpers, keyed lists, forms, enhancements, portals, and hydration.
- [Public API layers](docs/api.md): root, runtime, generated, server, and tooling import contracts.
- [App and Vite](docs/app-vite.md): app definitions, file routes, plugins, request-scoped SSR, logging, and packaging.
- [Routing](docs/routing.md): server routes, layouts, loaders, actions, streaming, and client navigation.
- [Server adapters](docs/adapters.md): Workers, Node, Lambda, static assets, origins, and deployment behavior.
- [Security](docs/security.md): escaping, trusted HTML, sanitizers, redirects, CSRF, hosts, proxies, and origins.
- [Whitespace migration](docs/migrations/whitespace.md): compiler versus document policies, legacy mappings, and boundary outcomes.
- [Benchmarks](benchmark/README.md): provenance, contracts, reproduction, and interpretation.
- [Releasing](docs/releasing.md): package verification, Trusted Publishing, and release commands.
- [Changelog](CHANGELOG.md): release history, breaking changes, fixes, and security notes.

## Security

Template interpolation and `tachyon-dom/server/html` escape text by default. `rawHtml()`, `trustedHtmlChunk()`, and route `stream()` chunks are explicit trust boundaries. Sanitize user-generated markup with a vetted runtime adapter, configure public origins and trusted proxy behavior, and apply method plus CSRF/Origin checks before direct form actions.

See the [security guide](docs/security.md) before deploying server-rendered or streamed applications.

## Project Status

The current compiler supports text, class, attribute, style, ref, model, and event bindings; keyed lists and conditionals; local stores and components; hydration boundaries; buffered SSR; and streaming targets. The runtime uses fine-grained reactive ownership so component cleanup stops effects, aborts resources, and detaches DOM bindings.

Tachyon DOM is still experimental. Evaluate compatibility, output, accessibility, security boundaries, and benchmark relevance for your application before production adoption.

## Development

```sh
pnpm install
pnpm test
pnpm build
pnpm lint
pnpm check:exports
pnpm check:size
pnpm check:browser-entry
pnpm check:browser-feature-budgets
pnpm check:template-types
pnpm check:quick-example-size
pnpm test:property
pnpm test:mutation
pnpm test:mutation:full
pnpm test:mutation:hydration
```

Property tests use a stable fast-check seed; use `FAST_CHECK_SEED`, `FAST_CHECK_PATH`, and `FAST_CHECK_NUM_RUNS` to replay or resize a campaign. Mutation testing remains a local check: the normal command reuses incremental results, the full command retests every in-scope mutant, and the detailed report is written to `reports/mutation/index.html`.

The focused hydration campaign reruns the compiler and conditional-runtime ranges from the hydration review without incremental reuse. See [its coverage and survivor ledger](docs/hydration-mutation-testing.md) for scope, remaining equivalent mutations, and GC test requirements.

Useful examples:

```sh
pnpm example:web
pnpm example:full-app
pnpm example:stream
```

## License

MIT
