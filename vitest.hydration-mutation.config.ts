import { defineConfig } from "vitest/config";
import base from "./vitest.config";
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      "tests/conditional-hydration-contracts.test.ts",
      "tests/runtime-mount.test.ts",
      "tests/conditional-hydration-rollback.test.ts",
      "tests/hydration-deferred-updates.test.ts",
      "tests/generated-conditional-bindings.test.ts",
      "tests/sfc-import-bindings.test.ts",
      "tests/compiler.test.ts",
      "tests/runtime-conditional.test.ts",
      "tests/example-syntax-gallery.test.ts",
    ],
  },
});
