import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, UserConfig } from "vite";
import { minifyHtml } from "../../src/app";
import { tachyonDom } from "../../src/vite";
import { fullAppPages, normalizedFullAppPath } from "./app";
import { renderFullAppDocument, type FullAppDocumentAssets } from "./ssr";

const root = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(root, "../../src");

const pageForPath = (url: string | undefined): (typeof fullAppPages)[number] | undefined => {
  const path = normalizedFullAppPath(new URL(url ?? "/", "http://tachyon.local").pathname);
  return fullAppPages.find((page) => page.path === path);
};

const prefixed = (prefix: string, fileName: string): string => `${prefix}/${fileName}`;

const fullAppHtmlPlugin = (): Plugin => ({
  name: "tachyon-full-app-html",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const page = pageForPath(request.url);
      if (!page) {
        next();
        return;
      }
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(renderFullAppDocument(page.path, page.prefix));
    });
  },
  generateBundle(_options, bundle) {
    const entry = Object.values(bundle).find(
      (item) => item.type === "chunk" && item.isEntry && item.facadeModuleId === resolve(root, "main.ts"),
    );
    if (!entry || entry.type !== "chunk") {
      this.error("Unable to find the full-app entry chunk.");
      return;
    }
    const cssFiles = Object.values(bundle).flatMap((item) =>
      item.type === "asset" && item.fileName.endsWith(".css") ? [item.fileName] : [],
    );
    for (const page of fullAppPages) {
      const assets: FullAppDocumentAssets = {
        scripts: [prefixed(page.prefix, entry.fileName)],
        styles: cssFiles.map((fileName) => prefixed(page.prefix, fileName)),
      };
      this.emitFile({
        fileName: page.fileName,
        source: minifyHtml(renderFullAppDocument(page.path, page.prefix, assets)),
        type: "asset",
      });
    }
  },
});

export default {
  root,
  build: {
    rollupOptions: {
      input: {
        main: resolve(root, "main.ts"),
      },
    },
  },
  plugins: [tachyonDom({ reactive: true }), fullAppHtmlPlugin()],
  resolve: {
    alias: [
      { find: /^tachyon-dom\/(.+)$/, replacement: `${sourceRoot}/$1.ts` },
      { find: "tachyon-dom", replacement: resolve(sourceRoot, "index.ts") },
    ],
  },
} satisfies UserConfig;
