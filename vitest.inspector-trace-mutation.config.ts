import { defineConfig } from "vitest/config";
import base from "./vitest.config";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["tests/inspector-trace.test.ts", "tests/runtime-diagnostics.test.ts", "tests/inspector-report.test.ts"],
  },
});
