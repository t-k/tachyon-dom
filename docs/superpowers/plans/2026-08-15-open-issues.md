# Open Issue Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the `agent-dag` skill to implement this plan task-by-task (it decides whether to use subagents and builds a Single-Writer Agent DAG). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve all 29 open local issues with safe cross-target contracts, regression coverage, preserved benchmark history, and independently reviewable commits.

**Architecture:** The work is split into five subsystem plans so each wave produces testable software without requiring an all-at-once rewrite. The main agent is the only source writer; read-only specialists may review security, test coverage, benchmarks, and the final diff.

**Tech Stack:** TypeScript, Tachyon DOM compiler/runtime/router, Vitest, jsdom, Playwright, pnpm, OxLint, OxFmt, TypeScript compiler, publint, Are the Types Wrong, size-limit.

---

## Baseline

- Worktree: `/home/tk/work/tachyon-dom/.worktrees/open-issues-2026-08-15`
- Branch: `fix/open-issues-2026-08-15`
- Baseline commit: `437ff12`
- Setup: `pnpm install --frozen-lockfile && pnpm build`
- Baseline verification: `pnpm test` reports 66 files and 795 tests passing.
- Local issue source and work log remain in the main repository at `/home/tk/work/tachyon-dom/docs.local/`.

## File ownership map

| Plan | Primary responsibility | Plan file |
| --- | --- | --- |
| 1 | HTML, URL, proxy, cookie, source-map, and malformed-path security boundaries | `docs/superpowers/plans/2026-08-15-open-issues-security.md` |
| 2 | Router result transport, adapter parity, and static dispatch documentation | `docs/superpowers/plans/2026-08-15-open-issues-transport.md` |
| 3 | Compiler AST, SFC extraction, hydration paths, loop diagnostics, and class composition | `docs/superpowers/plans/2026-08-15-open-issues-compiler.md` |
| 4 | Loader cache, scheduler errors, list/ref ownership, forms, virtual lists, and deferred data | `docs/superpowers/plans/2026-08-15-open-issues-runtime.md` |
| 5 | README, package footprint, changelog, diagnostics, size checks, and metadata | `docs/superpowers/plans/2026-08-15-open-issues-package-docs.md` |

## Execution order

- [ ] **Step 1: Execute the security plan**

Run every task in `2026-08-15-open-issues-security.md` in order. Stop if the security review leaves a Must Fix item.

- [ ] **Step 2: Execute the transport plan**

Run every task in `2026-08-15-open-issues-transport.md` in order. Preserve native Response bytes before changing adapter construction.

- [ ] **Step 3: Execute the compiler plan**

Run every task in `2026-08-15-open-issues-compiler.md` in order. Record parser/compiler benchmarks before the first production change in each hot path.

- [ ] **Step 4: Execute the runtime plan**

Run every task in `2026-08-15-open-issues-runtime.md` in order. Keep scheduler, list, ref, form, and virtual-list RED/GREEN cycles in separate commits.

- [ ] **Step 5: Execute the package and documentation plan**

Run every task in `2026-08-15-open-issues-package-docs.md` in order. Use packed clean consumers rather than workspace links for package assertions.

- [ ] **Step 6: Run the final gates**

```bash
pnpm lint
pnpm test
pnpm build
pnpm verify:package
pnpm verify:starters
pnpm check:exports
pnpm check:size
pnpm check:browser-entry
pnpm check:quick-example-size
TD_RELEASE_DIR=$(mktemp -d)
pnpm prepare:release --tag v0.1.1 --output "$TD_RELEASE_DIR"
node scripts/release-contract.mjs --verify-artifacts "$TD_RELEASE_DIR" --tag v0.1.1
rm -rf "$TD_RELEASE_DIR"
```

Expected: every command exits 0, Vitest reports no failed tests, and no warning represents a contract violation.

- [ ] **Step 7: Run final reviews**

Request a security review in Must Fix / Should Fix / Notes format and a clean-context correctness review. Resolve every Must Fix and blocking correctness finding with a new RED/GREEN commit.

- [ ] **Step 8: Close issue files**

For each issue, record the implementation commit and verification evidence in its local issue file, then move it from `/home/tk/work/tachyon-dom/docs.local/issues/open/` to `/home/tk/work/tachyon-dom/docs.local/issues/closed/`. Update `/home/tk/work/tachyon-dom/docs.local/logs/2026-08-15/2026-08-15-001-open-issues.md` with the final commit list and gates.

- [ ] **Step 9: Verify process hygiene**

```bash
git status --short --branch
ps -eo pid=,ppid=,comm=,args= | rg 'chrome-headless|playwright|vite|workerd|wrangler' || true
```

Expected: only intentional user-owned files remain outside the implementation branch, and no task-started server or browser process remains.
