# Local comparison benchmark authority

Contract version 3 distinguishes exploratory measurements from authoritative rankings. A run records its fresh-process run ID, deterministic seed, run index, measured implementation order, measured scenario order, warmup count, measured count, and raw timing samples. Result files are timestamped or explicitly run-scoped and must never overwrite an earlier run.

An authoritative aggregate requires at least five clean fresh-process runs from the same commit, working tree, runtime, host, browser, dependency set, build mode, and workload. Stable measurements use at least 5 warmups and 30 measured samples per implementation and scenario. The measured orders must balance each implementation and scenario across positions; a fixed order is not authoritative.

Each fresh process contributes one candidate-to-fastest-competitor ratio per scenario. Samples within that process determine its summary but are not treated as independent observations. The aggregate applies a deterministic run-level bootstrap and reports the median ratio and one-sided 95% upper bound. An upper bound below `1.00` is a reproducible win, and an upper bound at or below `0.99` is a meaningful win of at least 1%. Dirty, incompatible, undersampled, unbalanced, or uncertain inputs are rejected or reported as inconclusive.

Contract-v2 and older artifacts remain readable as historical measurements, but they cannot be promoted to authoritative rankings under the version-3 validator.
