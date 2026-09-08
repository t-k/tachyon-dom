import { defineConfig } from "vitest/config";
import base from "./vitest.config.ts";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      "tests/runtime-store.test.ts",
      "tests/sfc-component-updates.test.ts",
      "tests/sfc-exports.test.ts",
      "tests/sfc-scope-behavior.test.ts",
      "tests/compiler.test.ts",
    ],
  },
});
