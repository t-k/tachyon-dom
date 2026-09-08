import { defineConfig } from "vitest/config";
import base from "./vitest.config";
export default defineConfig({
  ...base,
  test: { ...base.test, include: ["tests/sfc-import-bindings.test.ts", "tests/sfc-scope-behavior.test.ts"] },
});
