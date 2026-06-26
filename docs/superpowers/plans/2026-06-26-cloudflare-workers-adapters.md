# Cloudflare Workers Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cloudflare Workers向けにNode依存を含まないSSR/ルーティングアダプタとAssets binding対応を追加する。

**Architecture:** Workers用処理を`src/adapters/workers.ts`へ分離し、Node用処理を`src/adapters/node.ts`へ移す。`src/adapters.ts`は互換用の集約エントリとして残し、`src/router.ts`のトップレベルNode importは動的importまたは文字列処理へ置き換える。

**Tech Stack:** TypeScript、Vitest、Web標準`Request`/`Response`/`ReadableStream`、Cloudflare Workers Assets binding互換インターフェース。

---

### Task 1: Workersアダプタの赤テスト

**Files:**
- Modify: `tests/router-adapters.test.ts`
- Read: `src/adapters.ts`

- [ ] **Step 1: Write the failing test**

`tests/router-adapters.test.ts`に`../src/adapters/workers`から`createWorkersHandler`をimportするテストを追加する。`env.ASSETS`を使って`/assets/app.js`へ応答し、`createSecurityHeaders`のCSPがマージされることを検証する。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/router-adapters.test.ts --testNamePattern "serves Cloudflare assets from env binding"`

Expected: FAIL with module resolution error for `../src/adapters/workers` or missing `assets` behavior.

- [ ] **Step 3: Commit nothing**

赤テスト確認だけなのでコミットしない。

### Task 2: Workersアダプタの実装

**Files:**
- Create: `src/adapters/workers.ts`
- Modify: `src/adapters.ts`
- Modify: `package.json`
- Test: `tests/router-adapters.test.ts`

- [ ] **Step 1: Write minimal implementation**

`src/adapters/workers.ts`へ`createWorkersHandler`、`defineStaticRoute`、Workers Assets binding解決、security headerマージを実装する。`fetch(request, env)`は`assets.binding`または`env[assets.bindingName ?? "ASSETS"]`を使えるようにする。

- [ ] **Step 2: Keep compatibility exports**

`src/adapters.ts`は`src/adapters/workers.ts`と`src/adapters/node.ts`を再exportする互換エントリにする。`package.json`に`./adapters/workers`と`./adapters/node`を追加する。

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm vitest run tests/router-adapters.test.ts --testNamePattern "serves Cloudflare assets from env binding"`

Expected: PASS.

- [ ] **Step 4: Commit**

Run: `git add src/adapters.ts src/adapters/workers.ts src/adapters/node.ts tests/router-adapters.test.ts package.json && git commit -m "feat: add cloudflare workers adapter entry"`

### Task 3: Nodeアダプタ分離

**Files:**
- Create: `src/adapters/node.ts`
- Modify: `src/adapters.ts`
- Test: `tests/router-adapters.test.ts`
- Test: `tests/router-platform.test.ts`

- [ ] **Step 1: Move Node-only code**

`createNodeHandler`、`writeNodeResponse`、`createStaticAssetHandler`を`src/adapters/node.ts`へ移し、Node importをそのファイルだけに閉じ込める。

- [ ] **Step 2: Update tests to explicit imports**

Node用テストは`../src/adapters/node`からimportし、Workers用テストは`../src/adapters/workers`からimportする。

- [ ] **Step 3: Run adapter tests**

Run: `pnpm vitest run tests/router-adapters.test.ts tests/router-platform.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit**

Run: `git add src/adapters.ts src/adapters/node.ts tests/router-adapters.test.ts tests/router-platform.test.ts && git commit -m "refactor: split node adapter entry"`

### Task 4: RouterのNode import除去

**Files:**
- Modify: `src/router.ts`
- Test: `tests/router-advanced.test.ts`
- Test: `tests/dx.test.ts`

- [ ] **Step 1: Write source-level regression test**

`tests/router-adapters.test.ts`へ`src/router.ts`と`src/adapters/workers.ts`のソースにトップレベル`node:` importがないことを確認するテストを追加する。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/router-adapters.test.ts --testNamePattern "keeps the Workers entry free of top-level Node imports"`

Expected: FAIL because `src/router.ts` currently has top-level `node:` imports.

- [ ] **Step 3: Remove router top-level Node imports**

`createFileRouteManifest`は文字列処理で相対パスを作る。`scanFileRoutes`は関数内で`node:fs/promises`と`node:path`を動的importする。

- [ ] **Step 4: Run targeted tests**

Run: `pnpm vitest run tests/router-adapters.test.ts tests/router-advanced.test.ts tests/dx.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add src/router.ts tests/router-adapters.test.ts && git commit -m "refactor: keep router runtime node-free"`

### Task 5: Docs、作業ログ、検証、セキュリティレビュー

**Files:**
- Modify: `docs/routing.md`
- Add: `docs.local/logs/2026-06-26/2026-06-26-005-cloudflare-workers-adapter.md`
- Read: `.agents/agents/security_specialist.md`

- [ ] **Step 1: Update docs**

`docs/routing.md`にWorkersでは`tachyon-dom/adapters/workers`を使うこと、Cloudflare Assets bindingは`assets: { bindingName: "ASSETS", basePath: "/assets" }`で使えることを書く。

- [ ] **Step 2: Write work log**

`docs.local/logs/2026-06-26/2026-06-26-005-cloudflare-workers-adapter.md`へ実装内容、テスト、セキュリティレビュー結果を書く。

- [ ] **Step 3: Run verification**

Run: `pnpm vitest run tests/router-adapters.test.ts tests/router-platform.test.ts tests/router-advanced.test.ts tests/dx.test.ts`

Run: `pnpm build`

Expected: both commands exit 0.

- [ ] **Step 4: Security review**

`.agents/agents/security_specialist.md`の観点で、Assets binding、basePath、headers merge、static route precedenceをMust Fix / Should Fix / Notes形式で確認し、作業ログに残す。

- [ ] **Step 5: Final commit**

Run: `git add docs/routing.md docs.local/logs/2026-06-26/2026-06-26-005-cloudflare-workers-adapter.md && git commit -m "docs: document cloudflare workers adapter"`
