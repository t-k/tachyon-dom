import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, UserConfig } from "vite";

const root = dirname(fileURLToPath(import.meta.url));

const pages = {
  compiler: resolve(root, "compiler/index.html"),
  counter: resolve(root, "counter/index.html"),
  forms: resolve(root, "forms/index.html"),
  index: resolve(root, "index.html"),
  lists: resolve(root, "lists/index.html"),
  settings: resolve(root, "settings/index.html"),
};

const minifyHtml = (html: string): string => {
  const preserved: string[] = [];
  const preserve = (match: string): string => {
    preserved.push(match);
    return `___TACHYON_PRESERVE_${preserved.length - 1}___`;
  };
  const minified = html
    .replace(/<pre\b[\s\S]*?<\/pre>/gi, preserve)
    .replace(/<!--(?!\[if\b)[\s\S]*?-->/gi, "")
    .replace(/\s+</g, "<")
    .replace(/>\s+/g, ">")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/___TACHYON_PRESERVE_(\d+)___/g, (_, index: string) => preserved[Number(index)] ?? "");
  return `${minified}\n`;
};

const htmlMinifyPlugin = (): Plugin => ({
  name: "tachyon-full-app-html-minify",
  apply: "build",
  transformIndexHtml: {
    order: "post",
    handler: minifyHtml,
  },
});

export default {
  root,
  build: {
    rollupOptions: {
      input: pages,
    },
  },
  plugins: [htmlMinifyPlugin()],
} satisfies UserConfig;
