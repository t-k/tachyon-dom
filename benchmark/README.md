# Benchmark result provenance

## Reproducing the local keyed benchmark

```sh
pnpm bench:local
```

The canonical local run uses a production Vite build, two warmups, seven measured iterations, Playwright Chromium, and the trimmed mean with a 20% trim fraction. Result JSON is written under `benchmark/local-compare/results/` with command, Git, runtime, host, dependency, and browser provenance.

This comparison follows the row-operation model used by `js-framework-benchmark`, but it uses this repository's local runner and fixtures rather than the upstream official driver. Treat results as measurements of the recorded machine and revision, not as universal rankings.

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
