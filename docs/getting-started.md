# Getting Started

Tachyon DOM is experimental. Start with a small route or isolated application surface and keep server validation and security boundaries explicit.

## Create an App

```sh
npm create tachyon-dom@latest my-app
cd my-app
pnpm install
pnpm dev
```

The equivalent pnpm command is `pnpm create tachyon-dom my-app`. If Tachyon DOM is already installed, use `tachyon-dom init --template basic --out my-app`; choose `--template ssr` to include a small server composition entry.

Generated starters use route-local templates:

```text
src/
  routes/
    index/
      page.td
      page.td.d.ts
  routes.generated.ts
  client/
    main.ts
  app.ts
vite.config.ts
```

Keep page markup in `src/routes/**/page.td`, browser entry code in `src/client/main.ts`, and static assets in `public/`. Do not put application code in `public/client/main.js`.

## Template Types

When TypeScript imports `.td` modules directly, add:

```ts
/// <reference types="tachyon-dom/td-modules" />
```

For project-wide configuration, add `"tachyon-dom/td-modules"` to `compilerOptions.types` alongside `"vite/client"`. The entry covers `.td`, `.td?client`, `.td?client&mount-only`, `.td?client&hydrate-only`, `.td?server`, `.td?stream`, `.td?entry`, and `.td?raw` imports. The `.tachyon` and `.tachyon.html` extensions are declared for every one of those forms except the two `client&` modes.

During Vite development and builds, `tachyonDom()` writes an adjacent `.td.d.ts` for every transformed template. These declarations preserve exported `scope()` types, require referenced template fields, and type event handlers. The starter creates initial declarations so a clean project typechecks before its first Vite run. Use `tachyon-dom typegen` only for tooling that does not run Vite.

## Add Routes

```sh
tachyon-dom add page settings/profile --routes-dir src/routes
```

`src/routes/index/page.td` maps to `/`, `counter/page.td` maps to `/counter/`, `[id]` maps to `:id`, and `[...slug]` maps to a named wildcard. The command reports the normalized URL, adjacent declaration, and registry it changed. It preserves existing files unless `--force` is explicitly supplied.

## Test Templates

```ts
import { expect, it } from "vitest";
import { renderTdForTest } from "tachyon-dom/testing";

it("escapes account names", async () => {
  await expect(
    renderTdForTest("src/routes/account/page.td", {
      userName: `<img src=x onerror=alert(1)>`,
    }),
  ).resolves.toContain("&lt;img src=x onerror=alert(1)&gt;");
});
```

Compiler errors include the template path, line, column, source line, and pointer. Continue with the [syntax specification](syntax-spec.md), [app and Vite guide](app-vite.md), and [security guide](security.md).
