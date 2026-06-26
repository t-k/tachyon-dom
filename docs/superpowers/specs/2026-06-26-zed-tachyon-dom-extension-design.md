# Zed Tachyon DOM dev extension設計

## 目的

ローカルのZedで`.td`、`.tachyon`、`.tachyon.html`をTachyon DOMテンプレートとして開き、既存の`tachyon-dom language-server --stdio`からDiagnosticsを受け取れるようにする。

## スコープ

初回はローカル開発用dev extensionに限定する。Zed extension marketplace向けの配布、language serverのnpm自動インストール、専用tree-sitter grammar、semantic tokens、補完、hoverは対象外にする。

## 構成

`editors/zed-tachyon-dom`をZed extension rootにする。`extension.toml`で`Tachyon DOM`言語、HTML tree-sitter grammar、`tachyon-dom` language serverを登録する。`languages/tachyon-dom/config.toml`は`.td`、`.tachyon`、`.tachyon.html`を対象にし、grammarはHTMLを再利用する。

Rust extensionの`language_server_command()`はZed同梱のNode runtimeを`zed::node_binary_path()`で取得し、repo-localの`dist/cli.js language-server --stdio`を起動する。dev extensionをこのrepository配下からinstallする前提なので、`env!("CARGO_MANIFEST_DIR")`からrepository rootを解決する。

## 受け入れ条件

- Zed dev extensionとして必要な`extension.toml`、`Cargo.toml`、`src/lib.rs`、`languages/tachyon-dom/config.toml`が存在する。
- `.td`、`.tachyon`、`.tachyon.html`が`Tachyon DOM`言語に関連付く。
- `language_server_command()`がZed同梱Nodeで`dist/cli.js language-server --stdio`を起動する。
- Rust extensionが通常targetと`wasm32-wasip1`targetで`cargo check`に通る。
- `pnpm build`済みであればZedの`Install Dev Extension`から利用できる。
