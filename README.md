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

The framework direction is HTML-first syntax with Solid-style fine-grained reactivity and Marko-style separated server/client compiler targets. The first compiler slice lives in `@local/tachyon-dom/compiler` and can:

- parse a single-root HTML-like template
- extract `{expr}` text bindings
- extract `class:name={expr}` class bindings
- extract `on:event={handler}` event bindings
- extract `<for each={items} key={item.id}>` keyed list boundaries
- render an escaped server string for the same template
- generate client code that imports only the runtime helper modules it needs

The compiler output is intentionally close to the current direct DOM runtime: static markup stays static, dynamic text/class/event slots are recorded as explicit paths, and generated client code can import subpath helpers such as `@local/tachyon-dom/runtime/text`.

The first list runtime path, `@local/tachyon-dom/runtime/list`, preserves keyed row elements across updates, moves reused elements into order, patches text/class bindings, removes stale rows, and keeps event handlers current through a mutable row scope.

## Commands

```sh
npm install
npm test
npm run build
npm run lint
npm run bench:local
```

`npm run bench:local` starts a temporary Vite server, measures Tachyon DOM against local copies of the keyed vanilla benchmark implementations in Playwright Chromium, prints ratio tables, and writes JSON results under `benchmark/local-compare/results/`.

The local benchmark prints row-operation timings plus auxiliary metrics for startup, JS heap usage, DOM node counts, and local source size. JSON output also keeps per-run values with mean, median, min, max, and p95.
