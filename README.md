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

## Commands

```sh
npm install
npm test
npm run build
npm run lint
npm run bench:local
```

`npm run bench:local` starts a temporary Vite server, measures Tachyon DOM against local copies of the keyed vanilla benchmark implementations in Playwright Chromium, prints a ratio table, and writes JSON results under `benchmark/local-compare/results/`.
