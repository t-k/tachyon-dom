# Zed Tachyon DOM Dev Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ローカルZedからTachyon DOM LSP diagnosticsを使えるdev extensionを追加する。

**Architecture:** Zed extensionは`editors/zed-tachyon-dom`に分離し、HTML grammarを再利用する。Rust extensionはZed同梱Nodeでrepo-localの`dist/cli.js language-server --stdio`を起動する。

**Tech Stack:** Zed extension API 0.7.0、Rust cdylib、Tree-sitter HTML grammar、Vitest。

---

### Task 1: Extension構成テスト

**Files:**
- Create: `tests/zed-extension.test.ts`

- [x] **Step 1: REDテストを書く**

`extension.toml`、`languages/tachyon-dom/config.toml`、`src/lib.rs`が存在し、Zed extensionとして必要な設定を持つことを検証する。

- [x] **Step 2: REDを確認**

Run: `pnpm vitest run tests/zed-extension.test.ts --reporter=verbose`

Expected: extension filesが存在しないため失敗。

### Task 2: Extension実装

**Files:**
- Create: `editors/zed-tachyon-dom/extension.toml`
- Create: `editors/zed-tachyon-dom/Cargo.toml`
- Create: `editors/zed-tachyon-dom/src/lib.rs`
- Create: `editors/zed-tachyon-dom/languages/tachyon-dom/config.toml`
- Create: `editors/zed-tachyon-dom/README.md`
- Modify: `.gitignore`

- [x] **Step 1: Zed manifestを追加**

`Tachyon DOM`言語、HTML grammar、`tachyon-dom` language serverを登録する。

- [x] **Step 2: Rust extensionを追加**

`language_server_command()`で`zed::node_binary_path()`とrepo-local`dist/cli.js language-server --stdio`を返す。

- [x] **Step 3: Language configを追加**

`.td`、`.tachyon`、`.tachyon.html`を`Tachyon DOM`へ関連付ける。

- [x] **Step 4: READMEを追加**

`pnpm build`後にZedの`Install Dev Extension`で`editors/zed-tachyon-dom`を選ぶ手順を書く。

- [x] **Step 5: targetをignore**

`editors/*/target/`を`.gitignore`へ追加する。

### Task 3: Verification

**Files:**
- Verify only.

- [x] **Step 1: 対象テスト**

Run: `pnpm vitest run tests/zed-extension.test.ts --reporter=verbose`

Expected: 2テスト成功。

- [x] **Step 2: Rust check**

Run:

```bash
cargo check --manifest-path editors/zed-tachyon-dom/Cargo.toml
cargo check --manifest-path editors/zed-tachyon-dom/Cargo.toml --target wasm32-wasip1
```

Expected: 成功。

- [x] **Step 3: 全体検証**

Run:

```bash
cargo fmt --manifest-path editors/zed-tachyon-dom/Cargo.toml -- --check
pnpm lint
pnpm build
pnpm test
```

Expected: すべて成功。
