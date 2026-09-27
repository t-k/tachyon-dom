# Benchmark result provenance

## Reproducing the local keyed benchmark

```sh
pnpm bench:local
```

The canonical local run uses a production Vite build, two warmups, seven measured iterations, Playwright Chromium, and the trimmed mean with a 20% trim fraction. Result JSON is written under `benchmark/local-compare/results/` with command, Git, runtime, host, dependency, and browser provenance.

This comparison follows the row-operation model used by `js-framework-benchmark`, but it uses this repository's local runner and fixtures rather than the upstream official driver. Treat results as measurements of the recorded machine and revision, not as universal rankings.

The local comparison's ranked `values` remain the click plus two `requestAnimationFrame` callbacks. Each summary also records `syncUpdateMs` as the duration of the synchronous click call. An implementation that schedules DOM work after the call returns must not be compared by this supplemental number alone. Trace capture runs as a separate unscored sample. The auxiliary DOM count is an element count; its heap reading is a current heap snapshot without forced garbage collection.

## Production browser benchmark for generated templates

Run `pnpm bench:template-browser -- --iterations 5 --warmup 2 --item-count 1000 --child-count 2 --output benchmark/browser-feature-results/template-browser.json`. This compiles the representative `.td` text and mixed templates into minified production browser bundles, runs them in Chromium beside the low-level `keyed-rows` path, and checks row counts and keyed node identity. Each sample uses a fresh page. `coldImportMs` measures importing the bundles, `create.syncUpdateMs` measures first mount, and `partialUpdate.syncUpdateMs` measures an update on that mounted list. No-change, immutable 1%, 10%, and 100% value changes, and mutable 1% value changes are measured separately. The `settledUpdateMs` fields include two frame callbacks and are not paint completion times. Samples with detailed browser tracing are not included in this suite.

The existing `pnpm bench:template-representative` remains a JSDOM regression fixture with broader oracle checks. Browser results are local evidence until paired base/head runs on a stable host confirm a change; the output does not represent page-wide INP.

The browser report records workload controls, bundle hashes, Git state, Node, CPU, esbuild, and Chromium versions. Compare base and head as separate processes with the same controls and host. Individual operations in one process are correlated samples, not independent trials.

Run `pnpm bench:template-browser:compare -- --pair base-1.json head-1.json --pair base-2.json head-2.json` on clean reports from the same host and browser. Each process contributes one ratio per operation; fewer than five pairs remain inconclusive. The comparison rejects changed controls, environment, bundle contents within a revision, dirty results, and reused process IDs. Use `--allow-dirty-smoke` only for local smoke artifacts.

Add `--memory true --memory-cycles 50` to run a separate diagnostic page per path. It records Chromium heap usage after forced GC at import, mount, first dispose, and repeated dispose, plus live Element, Text, and Comment counts. GC and node counting occur outside the timed samples. The heap deltas and bytes per row are estimates; they do not measure allocation volume or prove the absence of detached retained nodes.

New benchmark result files use schema version 2. Each result contains a benchmark and contract identifier, the lossless process argument vector, a display command, working directory, capture time, Git commit and dirty state, a working-tree hash, Node and operating-system details, CPU and host identity, and benchmark-specific dependency or browser versions. Workload controls and measurements are separate fields so comparison tools can validate controls before interpreting numbers.

Comparisons fail closed when required workload or environment fields differ. Source revision differences must be explicitly allowed and remain visible as intentional differences in the comparison report. Legacy files without the provenance envelope remain unchanged and readable as historical records, but they must not be used for authoritative rankings or before-and-after claims.

Historical subject measurements distinguish the runner checkout from the subject checkout. The streaming backpressure runner accepts `--subject-root` and `--adapter-module`, records the subject Git identity, and uses a real TCP server and throttled client rather than an in-process destination simulation.

## Raw-text scanner validation

Run `pnpm bench:raw-text-scan` to compare the production scalar scanner with the benchmark-local native string-search candidate. The command writes a provenance-bearing JSON artifact under `benchmark/raw-text-scan/results/` and evaluates the approved short-input, 64 KiB inert-span, and dense-decoy gates.

This benchmark validates a private prototype only. It does not imply that the candidate is safe to move into production, and it does not compare a Wasm SIMD implementation.

## Client bundle size of interactive pages

Run `pnpm bench:client-bundle` to build the fixtures in `benchmark/client-bundle/fixtures.ts` as production route apps and record the raw, gzip, and Brotli sizes of the HTML, module scripts, and stylesheets a cold browser fetches for each initial route. Every fixture must pass a Chromium interaction check before its size is recorded. See `benchmark/client-bundle/README.md` for the fixture list and the measurement rules.

## Manual GitHub Actions runs

The `Benchmarks` workflow can be started manually from GitHub Actions. Its `suite` input accepts `all`, `web-framework`, `js-framework`, or `client-bundle`; `all` is the default.

The workflow writes an overall ranking and a separate ranking for every measured metric to the GitHub Actions job summary, and a table of client bundle sizes per interactive page fixture when that suite is selected. Each row includes the measured value and its ratio to the best value in that run. The JSON results, generated Markdown, and available benchmark logs are uploaded as a workflow artifact.

These are indicative rankings from one workflow dispatch, not authoritative rankings. The `js-framework` suite runs this repository's comparison based on the krausest/js-framework-benchmark operation model; it does not run the upstream official benchmark driver. Use the contract-specific multi-run validation described by each benchmark when making authoritative performance claims.
