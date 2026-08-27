import { defineConfig, mergeConfig } from "vitest/config";

import { mutationTestExclude } from "./tests/mutation-test-policy";
import baseConfig from "./vitest.config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      exclude: [...mutationTestExclude],
    },
  }),
);
