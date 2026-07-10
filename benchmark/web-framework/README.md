# Web framework benchmark contract

Contract version 2 separates precomputed static throughput from request-time dynamic SSR. Fixture validation requests both `/products/42` and `/products/43`, requires different parameter-dependent responses, and rejects an exact precomputed dynamic response.

The stream scenario must send an application shell before a deliberately delayed payload through the framework's production server path. The runner records downstream chunk arrival timestamps and rejects a fixture unless the shell and `data-stream="done"` payload arrive in distinct chunks at least 10ms apart. All fixtures currently use a 20ms delay.

Results written before contract version 2 did not enforce these properties. Their dynamic SSR and streaming rankings are non-authoritative; static throughput data can still be interpreted independently. New JSON results include `contractVersion: 2` and use timestamped or explicitly run-scoped filenames without overwriting older files.

The corrected production smoke run from 2026-07-10 is stored at `results/2026-07-10-contract-v2-smoke.json`. It built and validated Tachyon DOM, Marko Run, SolidStart, TanStack Start, Next.js App Router, and mreact App Router under the same host process, runtime dependency set, smoke duration, concurrency, and route contract.
