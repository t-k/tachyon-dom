# Benchmark result provenance

New benchmark result files use schema version 2. Each result contains a benchmark and contract identifier, the lossless process argument vector, a display command, working directory, capture time, Git commit and dirty state, a working-tree hash, Node and operating-system details, CPU and host identity, and benchmark-specific dependency or browser versions. Workload controls and measurements are separate fields so comparison tools can validate controls before interpreting numbers.

Comparisons fail closed when required workload or environment fields differ. Source revision differences must be explicitly allowed and remain visible as intentional differences in the comparison report. Legacy files without the provenance envelope remain unchanged and readable as historical records, but they must not be used for authoritative rankings or before-and-after claims.

Historical subject measurements distinguish the runner checkout from the subject checkout. The streaming backpressure runner accepts `--subject-root` and `--adapter-module`, records the subject Git identity, and uses a real TCP server and throttled client rather than an in-process destination simulation.
