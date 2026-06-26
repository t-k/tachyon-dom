# Tachyon DOM Language Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `.td`ファイル向けの最小LSP serverを追加し、stdio経由でDiagnosticsを提供する。

**Architecture:** 既存`diagnoseTachyonSfc()`を再利用し、LSP接続層は`src/language-server.ts`に閉じ込める。診断変換は純粋関数としてexportし、CLIは動的importで`language-server --stdio`を起動する。

**Tech Stack:** TypeScript、`vscode-languageserver`、`vscode-languageserver-textdocument`、Vitest、pnpm。

---

### Task 1: LSP診断変換

**Files:**
- Create: `src/language-server.ts`
- Create: `tests/language-server.test.ts`
- Modify: `package.json`

- [ ] **Step 1: 依存追加**

Run: `pnpm add vscode-languageserver vscode-languageserver-textdocument`

- [ ] **Step 2: REDテストを追加**

`tests/language-server.test.ts`に以下を追加する。

```ts
import { describe, expect, it } from "vitest";
import { diagnosticsForTachyonDocument } from "../src/language-server";

describe("Tachyon language server diagnostics", () => {
  it("converts Tachyon compiler diagnostics to LSP diagnostics", () => {
    const diagnostics = diagnosticsForTachyonDocument("<main>\n<if></if>\n</main>");

    expect(diagnostics).toEqual([
      {
        message: "<if> requires test={condition}.",
        range: {
          start: { line: 1, character: 0 },
          end: { line: 1, character: 4 },
        },
        severity: 1,
        source: "tachyon-dom",
      },
    ]);
  });

  it("returns no diagnostics for valid Tachyon documents", () => {
    expect(diagnosticsForTachyonDocument("<main><h1>{title}</h1></main>")).toEqual([]);
  });
});
```

- [ ] **Step 3: REDを確認**

Run: `pnpm vitest run tests/language-server.test.ts --reporter=verbose`

Expected: `../src/language-server`が存在しないため失敗。

- [ ] **Step 4: 最小実装**

`src/language-server.ts`に`diagnosticsForTachyonDocument()`を実装し、`diagnoseTachyonSfc()`の結果をLSP Diagnosticへ変換する。

- [ ] **Step 5: GREENを確認**

Run: `pnpm vitest run tests/language-server.test.ts --reporter=verbose`

Expected: 2テスト成功。

### Task 2: stdio LSP serverとCLI統合

**Files:**
- Modify: `src/language-server.ts`
- Modify: `src/cli.ts`
- Modify: `tests/dx.test.ts`
- Modify: `package.json`

- [ ] **Step 1: REDテストを追加**

`tests/dx.test.ts`に`runCli(["language-server"])`がusageエラー、`runCli(["language-server", "--stdio"])`がLSP起動関数へ到達できる構造を直接起動せずに検証する引数パーサー相当のテストを追加する。既存CLIはparserを非exportにしているため、`serverCommandMessage`相当の純粋関数を追加するより、`parseArgs`をexportしてテストする。

- [ ] **Step 2: REDを確認**

Run: `pnpm vitest run tests/dx.test.ts -t "parses language server" --reporter=verbose`

Expected: `parseArgs`未exportまたは未対応で失敗。

- [ ] **Step 3: CLI型とparserを実装**

`CliLanguageServerOptions`を追加し、`parseArgs`をexportし、`language-server --stdio`だけを受理する。

- [ ] **Step 4: LSP起動関数を実装**

`src/language-server.ts`に`startLanguageServer()`を追加し、`createConnection(ProposedFeatures.all)`、`TextDocuments`、`documents.listen(connection)`、`connection.listen()`を構成する。

- [ ] **Step 5: package exportsを追加**

`package.json`に`./language-server`のtypes/import exportを追加する。

- [ ] **Step 6: GREENを確認**

Run: `pnpm vitest run tests/dx.test.ts -t "parses language server" --reporter=verbose`

Expected: 対象テスト成功。

### Task 3: 全体検証と梱包確認

**Files:**
- Verify only.

- [ ] **Step 1: 型・lint・テスト**

Run:

```bash
pnpm lint
pnpm build
pnpm test
```

Expected: すべて成功。

- [ ] **Step 2: pack確認**

Run: `npm pack --dry-run --json`

Expected: `dist/language-server.js`と`dist/language-server.d.ts`を含む。

- [ ] **Step 3: 作業ログ**

`docs.local/logs/2026-06-26/2026-06-26-012-language-server.md`へ実装内容、Coverage Ledger、検証結果を書く。

- [ ] **Step 4: コミット**

Run:

```bash
git add package.json pnpm-lock.yaml src/language-server.ts src/cli.ts tests/language-server.test.ts tests/dx.test.ts docs/superpowers/specs/2026-06-26-tachyon-dom-language-server-design.md docs/superpowers/plans/2026-06-26-tachyon-dom-language-server.md
git commit -m "feat: add tachyon language server diagnostics"
```
