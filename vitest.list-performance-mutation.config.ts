import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config";

export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: [
        "tests/runtime-list-core.test.ts",
        "tests/runtime-list-text.test.ts",
        "tests/runtime-list.test.ts",
        "tests/hydration-deferred-updates.test.ts",
        "tests/list-region-markers.test.ts",
      ],
    },
  }),
);
