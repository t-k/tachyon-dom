import type { Plugin, UserConfig } from "vite";

type ExamplePage = {
  title: string;
  module: string;
};

const examplePages = new Map<string, ExamplePage>([
  [
    "/examples/auth-todo/",
    { module: "/examples/auth-todo/main.ts", title: "Authenticated Todo | Tachyon DOM Example" },
  ],
  ["/examples/web/", { module: "/examples/web/main.ts", title: "Tachyon DOM Example" }],
]);

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
    <script type="module" src="${page.module}"></script>
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
  plugins: [tachyonExamplePages()],
} satisfies UserConfig;
