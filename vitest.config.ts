import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { tachyonDom } from "./src/vite";

const root = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(root, "src");
const mreactRoot = resolve(root, "../mreact");

export default defineConfig({
  plugins: [tachyonDom({ reactive: true })],
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
  test: {
    environment: "jsdom",
    globals: true,
    include: ["tests/**/*.test.ts"],
  },
});
