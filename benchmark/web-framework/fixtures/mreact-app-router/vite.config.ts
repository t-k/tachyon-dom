import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mreactRouter } from "@reckona/mreact-router/vite";
import { defineConfig } from "vite";

const projectRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    mreactRouter({
      projectRoot,
      routesDir: "app",
      publicDir: "public",
    }),
  ],
});
