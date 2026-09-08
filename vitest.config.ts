import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { tachyonDom } from "./src/vite.ts";

const root = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(root, "src");

export default defineConfig({
  plugins: [tachyonDom({ reactive: true })],
  resolve: {
    alias: [
      { find: /^tachyon-dom\/(.+)$/, replacement: `${sourceRoot}/$1.ts` },
      { find: "tachyon-dom", replacement: resolve(sourceRoot, "index.ts") },
    ],
  },
  test: {
    environment: "jsdom",
    fileParallelism: false,
    globals: true,
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/fast-check.setup.ts"],
  },
});
