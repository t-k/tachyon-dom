import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { mutationTestExclude } from "./mutation-test-policy";

const readJson = (path: string): Record<string, any> =>
  existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, any>) : {};

describe("local mutation testing configuration", () => {
  it("mutates every implementation TypeScript file but not declarations", () => {
    const config = readJson("stryker.config.json");
    expect(config.mutate).toEqual(["src/**/*.ts", "!src/**/*.d.ts"]);
    expect(config.plugins).toEqual(["./node_modules/@stryker-mutator/vitest-runner/dist/src/index.js"]);
    expect(config.testRunner).toBe("vitest");
    expect(config.vitest).toEqual({ configFile: "vitest.mutation.config.ts", related: true });
  });

  it("records a non-blocking incremental baseline with local reports", () => {
    const config = readJson("stryker.config.json");
    expect(config.incremental).toBe(true);
    expect(config.incrementalFile).toBe("reports/mutation/incremental.json");
    expect(config.thresholds).toEqual({ high: 80, low: 60, break: null });
    expect(config.reporters).toEqual(["clear-text", "html", "json"]);
    expect(config.htmlReporter).toEqual({ fileName: "reports/mutation/index.html" });
    expect(config.jsonReporter).toEqual({ fileName: "reports/mutation/mutation.json" });
  });

  it("excludes process-heavy suites from mutant runs", () => {
    expect(mutationTestExclude).toEqual([
      "tests/**/*-e2e.test.ts",
      "tests/compiler-source-policy.test.ts",
      "tests/example-*.test.ts",
      "tests/examples-*.test.ts",
      "tests/*benchmark*.test.ts",
      "tests/local-compare-*.test.ts",
      "tests/open-issues-browser.test.ts",
      "tests/quick-example-size-policy.test.ts",
      "tests/readme-landing.test.ts",
      "tests/release-contract.test.ts",
      "tests/artifact-manifest.test.ts",
      "tests/server-html-browser.test.ts",
      "tests/streaming-backpressure-compare.test.ts",
      "tests/streaming-subject.test.ts",
      "tests/statistical-authority.test.ts",
      "tests/tachyon-app-production-hydration.test.ts",
      "tests/template-whitespace-production-hydration.test.ts",
      "tests/web-framework-*.test.ts",
      "tests/dx.test.ts",
    ]);
  });

  it("exposes local scripts without adding mutation testing to CI", () => {
    const packageJson = readJson("package.json");
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    const readme = readFileSync("README.md", "utf8");
    const propertyConfig = readFileSync("vitest.property.config.ts", "utf8");
    expect(packageJson.scripts["test:property"]).toBe("vitest run --config vitest.property.config.ts");
    expect(propertyConfig).toContain('include: ["tests/*-property.test.ts"]');
    expect(packageJson.scripts["test:mutation"]).toBe("stryker run");
    expect(packageJson.scripts["test:mutation:full"]).toBe("stryker run --force");
    expect(ci).not.toContain("test:mutation");
    expect(readme).toContain("pnpm test:property");
    expect(readme).toContain("pnpm test:mutation:full");
    expect(readme).toContain("FAST_CHECK_SEED");
    expect(readme).toContain("reports/mutation/index.html");
  });

  it("keeps generated mutation reports out of Git", () => {
    expect(readFileSync(".gitignore", "utf8").split("\n")).toEqual(
      expect.arrayContaining(["reports/mutation/", ".stryker-tmp/"]),
    );
  });
});
