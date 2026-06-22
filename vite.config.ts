import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, UserConfig } from "vite";
import { tachyonDom } from "./src/vite";

type ExamplePage = {
  title: string;
  module: string;
};

const examplePages = new Map<string, ExamplePage>([
  [
    "/examples/auth-todo/",
    {
      module: "/examples/auth-todo/app.td?entry&mount=mountAuthTodoExample",
      title: "Authenticated Todo | Tachyon DOM Example",
    },
  ],
  ["/examples/web/", { module: "/examples/web/app.td?entry&mount=mountWebExample", title: "Tachyon DOM Example" }],
]);

const root = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(root, "src");
const mreactRoot = resolve(root, "../mreact");

const normalizePath = (url: string | undefined): string => {
  const path = new URL(url ?? "/", "http://tachyon.local").pathname;
  return path.endsWith("/index.html") ? path.slice(0, -"index.html".length) : path;
};

const renderExampleDocument = (page: ExamplePage): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${page.title}</title>
    <script type="module">import ${JSON.stringify(page.module)};</script>
  </head>
  <body>
    <main id="app"></main>
  </body>
</html>
`;

const tachyonExamplePages = (): Plugin => ({
  name: "tachyon-example-pages",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const page = examplePages.get(normalizePath(request.url));
      if (!page) {
        next();
        return;
      }
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(renderExampleDocument(page));
    });
  },
});

export default {
  plugins: [tachyonDom({ reactive: true }), tachyonExamplePages()],
  resolve: {
    alias: [
      { find: /^tachyon-dom\/(.+)$/, replacement: `${sourceRoot}/$1.ts` },
      { find: "tachyon-dom", replacement: resolve(sourceRoot, "index.ts") },
      {
        find: /^@reckona\/mreact-reactive-core$/,
        replacement: resolve(mreactRoot, "packages/reactive-core/src/index.ts"),
      },
      {
        find: /^@reckona\/mreact-reactive-core\/(.+)$/,
        replacement: `${resolve(mreactRoot, "packages/reactive-core/src")}/$1.ts`,
      },
      {
        find: /^@reckona\/mreact-reactive-dom$/,
        replacement: resolve(mreactRoot, "packages/reactive-dom/src/index.ts"),
      },
      {
        find: /^@reckona\/mreact-reactive-dom\/(.+)$/,
        replacement: `${resolve(mreactRoot, "packages/reactive-dom/src")}/$1.ts`,
      },
      { find: /^@reckona\/mreact-shared$/, replacement: resolve(mreactRoot, "packages/shared/src/index.ts") },
      { find: /^@reckona\/mreact-shared\/(.+)$/, replacement: `${resolve(mreactRoot, "packages/shared/src")}/$1.ts` },
    ],
  },
} satisfies UserConfig;
