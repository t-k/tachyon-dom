import { defineConfig } from "vitest/config";
import base from "./vitest.config";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["tests/sfc-component-export.test.ts", "tests/sfc-component-size.test.ts", "tests/runtime-mount.test.ts"],
  },
});
