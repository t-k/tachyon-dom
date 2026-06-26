# Tachyon DOM Language Server設計

## 目的

`.td`、`.tachyon`、`.tachyon.html`ファイルを複数エディターから扱えるようにするため、Tachyon DOMの最小Language Server Protocol実装を追加する。

## スコープ

初回はDiagnosticsのみを提供する。補完、hover、定義ジャンプ、フォーマット、semantic tokens、仮想TypeScript型チェックは対象外とし、後続フェーズで扱う。

## アーキテクチャ

`src/language-server.ts`を追加し、`vscode-languageserver/node`と`vscode-languageserver-textdocument`でstdio LSP serverを構成する。ドキュメント管理は`TextDocuments<TextDocument>`に任せ、`onDidOpen`、`onDidChangeContent`、`onDidClose`で診断を発行またはクリアする。

診断生成は既存の`diagnoseTachyonSfc()`を再利用する。Tachyon側の診断は1-basedの`line`/`column`を持つため、LSPの0-based `Range`へ変換する小さな純粋関数を用意する。LSP serverのイベント処理と診断変換を分け、変換部分はユニットテストできる形にする。

CLIは`tachyon-dom language-server --stdio`を追加する。npm公開パッケージから直接使えるよう、`package.json`に`./language-server` exportも追加する。

## ファイル構成

- `src/language-server.ts`: LSP接続、TextDocuments、診断変換、CLI起動関数。
- `src/cli.ts`: `language-server --stdio`コマンドを追加し、LSP serverを動的importで起動する。
- `tests/language-server.test.ts`: 診断変換とCLI引数の基本動作を検証する。
- `package.json`: LSP依存、export、bin経由のサブコマンドを更新する。

## 受け入れ条件

- 不正な`.td`入力に対し、LSP Diagnosticの`range`、`message`、`severity`、`source`が生成される。
- 正常な`.td`入力では診断が空になる。
- `tachyon-dom language-server --stdio`がCLI引数として受理される。
- `pnpm build`で`dist/language-server.js`と型定義が生成される。
- `npm pack --dry-run --json`に`dist/language-server.js`と`dist/language-server.d.ts`が含まれる。

## 非目標

- VS Code拡張の同梱。
- TextMate grammarの追加。
- TypeScript Language Serviceとの仮想ファイル連携。
- 複数診断の網羅的収集。現行compilerが最初のエラーを返すため、LSPも初回は同じ粒度に合わせる。
