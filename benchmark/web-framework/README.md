# Web framework benchmark contract

Contract version 3 separates precomputed static throughput from request-time dynamic SSR. Every run creates high-entropy product IDs that are unknown to the fixture and uses them for both validation and the measured dynamic URL. Each response must contain its requested ID and remain distinct, so a finite table of bodies prepared before the run cannot satisfy the contract.

The stream scenario must send an application shell before a deliberately delayed payload through the framework's production server path. The runner records downstream chunk arrival timestamps and rejects a fixture unless the shell and `data-stream="done"` payload arrive in distinct chunks at least 10ms apart. All fixtures currently use a 20ms delay.

Results written before contract version 3 did not enforce the run-scoped dynamic challenge or require framework-owned Marko streaming. Their dynamic SSR and streaming rankings are non-authoritative; static throughput data can still be interpreted independently. New JSON results use the shared provenance envelope, include `benchmark.contractVersion: 3`, record resolved workload controls and framework build/start commands, and use timestamped or explicitly run-scoped filenames without overwriting older files.

The older production smoke run at `results/2026-07-10-contract-v2-smoke.json` is preserved as a legacy artifact with incomplete provenance. Corrected contract-v3 runs must be written to new run-scoped files and are authoritative only when their provenance and workload compatibility checks pass.
