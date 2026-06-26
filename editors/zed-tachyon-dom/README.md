# Tachyon DOM Zed Extension

This is a local development extension for Zed. It associates `.td`, `.tachyon`, and `.tachyon.html` files with the `Tachyon DOM` language and starts the repo-local Tachyon DOM language server.

## Prerequisites

Build the Tachyon DOM package before installing or reloading the extension:

```sh
pnpm build
```

The extension starts:

```sh
node ../../dist/cli.js language-server --stdio
```

Zed resolves the absolute path from the local extension directory at compile time, so this extension is intended for local development from this repository.

## Install In Zed

1. Open Zed.
2. Run `zed: install dev extension` from the command palette.
3. Select `editors/zed-tachyon-dom`.
4. Open a `.td`, `.tachyon`, or `.tachyon.html` file.

If diagnostics do not appear, run `zed: open log` and confirm the language server command points at this repository's `dist/cli.js`.
