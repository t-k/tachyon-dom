import { defineConfig } from "vitest/config";

// Do not import the Vite plugin here: it loads compiler policies before Stryker activates static mutants.
export default defineConfig({
  test: {
    environment: "jsdom",
    fileParallelism: false,
    include: ["tests/server-html.test.ts", "tests/svg-animation-security.test.ts", "tests/url-policy.test.ts"],
  },
});
