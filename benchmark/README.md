# Benchmark result provenance

New benchmark result files use schema version 2. Each result contains a benchmark and contract identifier, the lossless process argument vector, a display command, working directory, capture time, Git commit and dirty state, a working-tree hash, Node and operating-system details, CPU and host identity, and benchmark-specific dependency or browser versions. Workload controls and measurements are separate fields so comparison tools can validate controls before interpreting numbers.

Comparisons fail closed when required workload or environment fields differ. Source revision differences must be explicitly allowed and remain visible as intentional differences in the comparison report. Legacy files without the provenance envelope remain unchanged and readable as historical records, but they must not be used for authoritative rankings or before-and-after claims.

Historical subject measurements distinguish the runner checkout from the subject checkout. The streaming backpressure runner accepts `--subject-root` and `--adapter-module`, records the subject Git identity, and uses a real TCP server and throttled client rather than an in-process destination simulation.

## Manual GitHub Actions runs

The `Benchmarks` workflow can be started manually from GitHub Actions. Its `suite` input accepts `all`, `web-framework`, or `js-framework`; `all` is the default.

The workflow writes an overall ranking and a separate ranking for every measured metric to the GitHub Actions job summary. Each row includes the measured value and its ratio to the best value in that run. The JSON results, generated Markdown, and available benchmark logs are uploaded as a workflow artifact.

These are indicative rankings from one workflow dispatch, not authoritative rankings. The `js-framework` suite runs this repository's comparison based on the krausest/js-framework-benchmark operation model; it does not run the upstream official benchmark driver. Use the contract-specific multi-run validation described by each benchmark when making authoritative performance claims.
