# Mutation and Property-Based Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `agent-dag` first to select a single-writer execution topology. If the resulting plan uses agentic task execution, follow `superpowers:subagent-driven-development` or `superpowers:executing-plans` as selected by that DAG.

**Goal:** Add reproducible fast-check properties and a local full-source StrykerJS mutation baseline without changing GitHub Actions or enforcing a mutation-score threshold.

**Architecture:** Vitest will load a deterministic fast-check setup shared by normal and mutation runs. Stryker will mutate all implementation TypeScript under `src`, use a mutation-specific Vitest configuration that excludes process-heavy suites, and write ignored local reports for coverage-ledger triage.

**Tech Stack:** TypeScript 6, Vitest 4, fast-check 4.9.0, StrykerJS 10.0.0, pnpm 10.32.1, OxLint, OxFmt

---

## File Structure

- Modify `package.json` and `pnpm-lock.yaml` to add the three test-tool dependencies and local scripts.
- Modify `vitest.config.ts` to load deterministic fast-check setup.
- Modify `.gitignore` to exclude mutation reports.
- Create `tests/fast-check-config.ts` for validated environment-to-runner parameter conversion.
- Create `tests/fast-check.setup.ts` for global fast-check defaults.
- Create `tests/fast-check-config.test.ts` for configuration contracts.
- Create `tests/mutation-test-policy.ts` for the mutation-run test exclusions.
- Create `tests/mutation-config.test.ts` for Stryker scope, reporter, script, and CI-isolation contracts.
- Create `vitest.mutation.config.ts` to reuse the normal aliases and plugin while excluding process-heavy tests.
- Create `stryker.config.json` for full-source, incremental local mutation runs.
- Modify the three existing `*-property.test.ts` files to use fast-check.
- Create `tests/html-escape-property.test.ts`, `tests/html-tag-whitespace-property.test.ts`, `tests/url-redirect-policy-property.test.ts`, and `tests/stream-segments-property.test.ts` for the new invariants.
- Create or update `.coverage-ledger/mutation-property-testing.md` with the observed baseline. This local artifact remains ignored.
- Update `docs.local/logs/2026-08-27/2026-08-27-001-mutation-property-testing-design.md` with implementation and verification results. This local artifact remains ignored.

If a new property exposes a production defect, do not weaken the invariant to preserve the current behavior. Pause that task, use `superpowers:systematic-debugging`, add a failing regression test before the production fix, and request the required Security Specialist review when the defect affects HTML trust boundaries, URL policy, redirects, or another security-sensitive path.

### Task 1: Install Compatible Test Tooling

**Files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Add exact compatible development dependencies**

Run:

```bash
pnpm add -D fast-check@4.9.0 @stryker-mutator/core@10.0.0 @stryker-mutator/vitest-runner@10.0.0
```

Expected: pnpm updates `package.json` and `pnpm-lock.yaml` without peer-dependency errors. StrykerJS 10 requires Node 22 or later; the repository requires and currently runs Node 24.

- [ ] **Step 2: Verify the installed entry points**

Run:

```bash
pnpm exec stryker --version
pnpm exec vitest --version
node -e "import('fast-check').then(({__version}) => console.log(__version))"
```

Expected: Stryker prints `10.0.0`, Vitest prints a `4.1.x` version, and fast-check prints `4.9.0`.

- [ ] **Step 3: Run the unchanged tests before test-infrastructure edits**

Run:

```bash
pnpm test
```

Expected: the existing suite passes, establishing the pre-migration baseline.

- [ ] **Step 4: Commit dependency installation**

```bash
git add package.json pnpm-lock.yaml
git commit -m "test: add property and mutation tooling"
```

### Task 2: Add Deterministic fast-check Configuration

**Files:**

- Create: `tests/fast-check-config.ts`
- Create: `tests/fast-check-config.test.ts`
- Create: `tests/fast-check.setup.ts`
- Modify: `vitest.config.ts`

- [ ] **Step 1: Write the failing configuration tests and a throwing scaffold**

Create `tests/fast-check-config.ts` with only the compile-time contract and a throwing implementation:

```typescript
export type FastCheckEnvironment = {
  FAST_CHECK_NUM_RUNS?: string;
  FAST_CHECK_PATH?: string;
  FAST_CHECK_SEED?: string;
};

export type PropertyRunParameters = {
  numRuns: number;
  path?: string;
  seed: number;
};

export type PropertyRunDefaults = {
  numRuns?: number;
  seed?: number;
};

export const resolveFastCheckParameters = (
  _environment: FastCheckEnvironment,
  _defaults: PropertyRunDefaults = {},
): PropertyRunParameters => {
  throw new Error("Not implemented.");
};

export const propertyParameters = (_defaults: PropertyRunDefaults = {}): PropertyRunParameters => {
  throw new Error("Not implemented.");
};
```

Create `tests/fast-check-config.test.ts`:

```typescript
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { propertyParameters, resolveFastCheckParameters } from "./fast-check-config";

describe("fast-check run configuration", () => {
  it("uses stable defaults", () => {
    expect(resolveFastCheckParameters({})).toEqual({ seed: 0x7a11c0de, numRuns: 100 });
  });

  it("uses property defaults when environment overrides are absent", () => {
    expect(resolveFastCheckParameters({}, { seed: 123, numRuns: 256 })).toEqual({ seed: 123, numRuns: 256 });
  });

  it("applies seed, path, and run-count overrides", () => {
    expect(
      resolveFastCheckParameters(
        { FAST_CHECK_SEED: "-42", FAST_CHECK_PATH: "1:0:2", FAST_CHECK_NUM_RUNS: "512" },
        { seed: 123, numRuns: 256 },
      ),
    ).toEqual({ seed: -42, path: "1:0:2", numRuns: 512 });
  });

  it("treats an empty replay path as absent", () => {
    expect(resolveFastCheckParameters({ FAST_CHECK_PATH: "" })).toEqual({ seed: 0x7a11c0de, numRuns: 100 });
  });

  it.each([
    ["FAST_CHECK_SEED", { FAST_CHECK_SEED: "1.5" }, "a safe integer"],
    ["FAST_CHECK_SEED", { FAST_CHECK_SEED: "NaN" }, "a safe integer"],
    ["FAST_CHECK_NUM_RUNS", { FAST_CHECK_NUM_RUNS: "0" }, "a positive safe integer"],
    ["FAST_CHECK_NUM_RUNS", { FAST_CHECK_NUM_RUNS: "2.5" }, "a positive safe integer"],
  ] as const)("rejects invalid %s", (name, environment, requirement) => {
    expect(() => resolveFastCheckParameters(environment)).toThrow(`${name} must be ${requirement}.`);
  });

  it("matches the globally configured parameters", () => {
    expect(fc.readConfigureGlobal()).toMatchObject(propertyParameters());
  });
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
pnpm exec vitest run tests/fast-check-config.test.ts
```

Expected: FAIL with `Not implemented.` from `resolveFastCheckParameters`.

- [ ] **Step 3: Implement validated fast-check parameters**

Replace `tests/fast-check-config.ts` with:

```typescript
export type FastCheckEnvironment = {
  FAST_CHECK_NUM_RUNS?: string;
  FAST_CHECK_PATH?: string;
  FAST_CHECK_SEED?: string;
};

export type PropertyRunParameters = {
  numRuns: number;
  path?: string;
  seed: number;
};

export type PropertyRunDefaults = {
  numRuns?: number;
  seed?: number;
};

const defaultSeed = 0x7a11c0de;
const defaultNumRuns = 100;

const safeInteger = (name: string, value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`${name} must be a safe integer.`);
  return parsed;
};

const positiveSafeInteger = (name: string, value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return parsed;
};

export const resolveFastCheckParameters = (
  environment: FastCheckEnvironment,
  defaults: PropertyRunDefaults = {},
): PropertyRunParameters => {
  const seed = safeInteger("FAST_CHECK_SEED", environment.FAST_CHECK_SEED, defaults.seed ?? defaultSeed);
  const numRuns = positiveSafeInteger(
    "FAST_CHECK_NUM_RUNS",
    environment.FAST_CHECK_NUM_RUNS,
    defaults.numRuns ?? defaultNumRuns,
  );
  const path = environment.FAST_CHECK_PATH;
  return path ? { seed, path, numRuns } : { seed, numRuns };
};

export const propertyParameters = (defaults: PropertyRunDefaults = {}): PropertyRunParameters =>
  resolveFastCheckParameters(process.env, defaults);
```

Create `tests/fast-check.setup.ts`:

```typescript
import fc from "fast-check";

import { propertyParameters } from "./fast-check-config";

fc.configureGlobal(propertyParameters());
```

Add the setup file inside the existing `test` block in `vitest.config.ts`:

```typescript
test: {
  environment: "jsdom",
  fileParallelism: false,
  globals: true,
  include: ["tests/**/*.test.ts"],
  setupFiles: ["./tests/fast-check.setup.ts"],
},
```

- [ ] **Step 4: Run the tests and verify GREEN**

Run:

```bash
pnpm exec vitest run tests/fast-check-config.test.ts
FAST_CHECK_SEED=7 FAST_CHECK_PATH=0:1 FAST_CHECK_NUM_RUNS=3 pnpm exec vitest run tests/fast-check-config.test.ts
pnpm build
```

Expected: both test runs pass and the build succeeds. The second run proves that explicit replay parameters are accepted by the global setup.

- [ ] **Step 5: Commit deterministic property configuration**

```bash
git add tests/fast-check-config.ts tests/fast-check-config.test.ts tests/fast-check.setup.ts vitest.config.ts
git commit -m "test: configure reproducible property runs"
```

### Task 3: Add Local Stryker Configuration

**Files:**

- Create: `tests/mutation-test-policy.ts`
- Create: `tests/mutation-config.test.ts`
- Create: `vitest.mutation.config.ts`
- Create: `stryker.config.json`
- Modify: `package.json`
- Modify: `.gitignore`
- Modify: `README.md`

- [ ] **Step 1: Write the failing configuration contract**

Create `tests/mutation-test-policy.ts` with a deliberately empty policy:

```typescript
export const mutationTestExclude: readonly string[] = [];
```

Create `tests/mutation-config.test.ts`:

```typescript
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { mutationTestExclude } from "./mutation-test-policy";

const readJson = (path: string): Record<string, any> =>
  existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, any>) : {};

describe("local mutation testing configuration", () => {
  it("mutates every implementation TypeScript file but not declarations", () => {
    const config = readJson("stryker.config.json");
    expect(config.mutate).toEqual(["src/**/*.ts", "!src/**/*.d.ts"]);
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
    expect(packageJson.scripts["test:property"]).toBe("vitest run tests/*-property.test.ts");
    expect(packageJson.scripts["test:mutation"]).toBe("stryker run");
    expect(packageJson.scripts["test:mutation:full"]).toBe("stryker run --force");
    expect(ci).not.toContain("test:mutation");
    expect(readme).toContain("pnpm test:property");
    expect(readme).toContain("pnpm test:mutation:full");
    expect(readme).toContain("FAST_CHECK_SEED");
    expect(readme).toContain("reports/mutation/index.html");
  });

  it("keeps generated mutation reports out of Git", () => {
    expect(readFileSync(".gitignore", "utf8").split("\n")).toContain("reports/mutation/");
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
pnpm exec vitest run tests/mutation-config.test.ts
```

Expected: FAIL because `stryker.config.json`, package scripts, exclusions, and the Git ignore entry are absent.

- [ ] **Step 3: Implement the mutation policy and runner configuration**

Replace `tests/mutation-test-policy.ts` with:

```typescript
export const mutationTestExclude: readonly string[] = [
  "tests/**/*-e2e.test.ts",
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
];
```

Create `vitest.mutation.config.ts`:

```typescript
import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "./vitest.config";
import { mutationTestExclude } from "./tests/mutation-test-policy";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      exclude: [...mutationTestExclude],
    },
  }),
);
```

Create `stryker.config.json`:

```json
{
  "$schema": "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  "concurrency": 4,
  "htmlReporter": {
    "fileName": "reports/mutation/index.html"
  },
  "incremental": true,
  "incrementalFile": "reports/mutation/incremental.json",
  "jsonReporter": {
    "fileName": "reports/mutation/mutation.json"
  },
  "mutate": ["src/**/*.ts", "!src/**/*.d.ts"],
  "reporters": ["clear-text", "html", "json"],
  "testRunner": "vitest",
  "thresholds": {
    "high": 80,
    "low": 60,
    "break": null
  },
  "vitest": {
    "configFile": "vitest.mutation.config.ts",
    "related": true
  }
}
```

Add these scripts next to the existing `test` script in `package.json`:

```json
"test": "vitest run",
"test:property": "vitest run tests/*-property.test.ts",
"test:mutation": "stryker run",
"test:mutation:full": "stryker run --force"
```

Add to `.gitignore`:

```gitignore
reports/mutation/
```

Add this text after the main Development command block in `README.md`:

````markdown
Property tests use a stable default fast-check seed. Replay a reported counterexample or change the local campaign with `FAST_CHECK_SEED`, `FAST_CHECK_PATH`, and `FAST_CHECK_NUM_RUNS`:

```sh
pnpm test:property
FAST_CHECK_SEED=123 FAST_CHECK_PATH=0:1 FAST_CHECK_NUM_RUNS=256 pnpm test:property
```

Mutation testing is an explicit local check and is not part of GitHub Actions. The normal command reuses incremental results; the full command forces every in-scope mutant to run:

```sh
pnpm test:mutation
pnpm test:mutation:full
```

Open `reports/mutation/index.html` after a completed run for the detailed report.
````

- [ ] **Step 4: Run the contract, dry run, lint, and build**

Run:

```bash
pnpm exec vitest run tests/mutation-config.test.ts
pnpm exec stryker run --dryRunOnly
pnpm lint
pnpm build
```

Expected: the configuration test passes, Stryker's focused initial test run succeeds without executing mutants, lint has no new errors, and build succeeds.

- [ ] **Step 5: Commit mutation infrastructure**

```bash
git add .gitignore README.md package.json stryker.config.json vitest.mutation.config.ts tests/mutation-config.test.ts tests/mutation-test-policy.ts
git commit -m "test: configure local full-source mutation runs"
```

### Task 4: Migrate Compiler Whitespace Properties to fast-check

**Files:**

- Modify: `tests/compiler-whitespace-property.test.ts`

- [ ] **Step 1: Run the existing characterization test**

Run:

```bash
pnpm exec vitest run tests/compiler-whitespace-property.test.ts
```

Expected: PASS before the refactor.

- [ ] **Step 2: Replace the custom random loop with fast-check**

Remove `randomValues`, `pick`, and the manual loop. Add these imports:

```typescript
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { propertyParameters } from "./fast-check-config";
```

Replace the suite with:

```typescript
describe("compiler whitespace bounded properties", () => {
  it("preserves semantic contexts and condenses ordinary contexts", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...contexts),
        fc.constantFrom(...policies),
        fc.constantFrom(...whitespaceForms),
        (context, policy, whitespace) => {
          const content = `left${whitespace}right`;
          const protectedContext = context === "title" || context === "pre" || context === "svg" || context === "math";
          const expectedContent = policy === "preserve" || protectedContext ? content : "left right";
          const result = compileTemplate(sourceFor(context, content), { whitespace: policy });
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          const serverHtml = renderServerTemplate(result.value, {});
          expect(serverHtml).toBe(result.value.client.templateHtml);
          expect(serverHtml).toContain(expectedContent);
          expect(generateServerStreamModule(result.value)).toContain(JSON.stringify(expectedContent));
        },
      ),
      propertyParameters({ seed: 0x7a11c0de, numRuns: 128 }),
    );
  });
});
```

- [ ] **Step 3: Verify the migrated property and replay controls**

Run:

```bash
pnpm exec vitest run tests/compiler-whitespace-property.test.ts
FAST_CHECK_SEED=17 FAST_CHECK_NUM_RUNS=8 pnpm exec vitest run tests/compiler-whitespace-property.test.ts
```

Expected: both runs pass.

- [ ] **Step 4: Commit the compiler property migration**

```bash
git add tests/compiler-whitespace-property.test.ts
git commit -m "test: migrate compiler whitespace properties to fast-check"
```

### Task 5: Migrate Progressive Stream Escaping to fast-check

**Files:**

- Modify: `tests/router-stream-escaping-property.test.ts`

- [ ] **Step 1: Run the existing characterization test**

Run:

```bash
pnpm exec vitest run tests/router-stream-escaping-property.test.ts
```

Expected: PASS before the refactor.

- [ ] **Step 2: Replace the seeded loop with an async property**

Add imports:

```typescript
import fc from "fast-check";

import { propertyParameters } from "./fast-check-config";
```

Replace the first test with:

```typescript
it("keeps generated attacker inputs in a text node across chunk boundaries", async () => {
  const attackerInput = fc.oneof(
    fc.constantFrom(...fragments),
    fc.string({ unit: "grapheme", maxLength: 64 }),
  );
  await fc.assert(
    fc.asyncProperty(attackerInput, fc.nat(), fc.nat(), fc.nat(), async (value, firstOffset, secondOffset, byteOffset) => {
      const escaped = trustedHtmlChunk(escapeToHtml(value));
      const firstSplit = firstOffset % (escaped.length + 1);
      const secondSplit = firstSplit + (secondOffset % (escaped.length - firstSplit + 1));
      const routes: RouteDefinition[] = [
        {
          path: "/search",
          loader: () => value,
          render: () => "",
          stream: async function* () {
            yield "<p>";
            yield escaped.slice(0, firstSplit);
            yield escaped.slice(firstSplit, secondSplit);
            yield escaped.slice(secondSplit);
            yield "</p>";
          },
        },
      ];
      const result = await renderRouteStream(routes, "https://example.test/search");
      if (!result.ok) throw new Error(result.error.message);
      const chunks: string[] = [];
      for await (const chunk of result.value.chunks) chunks.push(chunk);
      expect(chunks[0]).toBe("<p>");
      const bytes = new TextEncoder().encode(chunks.join(""));
      const firstByteSplit = byteOffset % (bytes.length + 1);
      const secondByteSplit = firstByteSplit + ((byteOffset >>> 8) % (bytes.length - firstByteSplit + 1));
      const decoded = decodeAcrossByteBoundaries(bytes, firstByteSplit, secondByteSplit);
      const parsed = elementsAndText(parseFragment(decoded) as Node);
      expect(parsed.elements).toEqual(["p"]);
      expect(parsed.text).toBe(parserNormalizedText(value));
    }),
    propertyParameters({ seed: 0x5afe4004, numRuns: 256 }),
  );
});
```

Remove the obsolete `seed` and `budget` constants.

- [ ] **Step 3: Verify normal and replayed execution**

Run:

```bash
pnpm exec vitest run tests/router-stream-escaping-property.test.ts
FAST_CHECK_SEED=23 FAST_CHECK_NUM_RUNS=8 pnpm exec vitest run tests/router-stream-escaping-property.test.ts
```

Expected: both runs pass, including the existing cancellation and trusted-value tests in the same file.

- [ ] **Step 4: Commit the stream property migration**

```bash
git add tests/router-stream-escaping-property.test.ts
git commit -m "test: shrink progressive stream escaping cases"
```

### Task 6: Migrate Benchmark JSON Properties to fast-check

**Files:**

- Modify: `tests/benchmark-json-property.test.ts`

- [ ] **Step 1: Run the existing characterization test**

Run:

```bash
pnpm exec vitest run tests/benchmark-json-property.test.ts
```

Expected: PASS before the refactor.

- [ ] **Step 2: Replace the seeded mutation loop**

Add imports:

```typescript
import fc from "fast-check";

import { propertyParameters } from "./fast-check-config";
```

Replace the first test with:

```typescript
it("rejects generated malformed numeric fields with their baseline path", () => {
  fc.assert(
    fc.property(fc.constantFrom(...fields), fc.constantFrom(...invalidValues), (field, invalid) => {
      const baseline = envelope("baseline");
      const candidate = envelope("candidate");
      setPath(baseline, field, invalid);
      if (field.startsWith("workload.")) setPath(candidate, field, invalid);
      expect(() => compareStreamingBackpressureResults(baseline, candidate)).toThrow(
        new RegExp(`baseline\\.${field.replaceAll(".", "\\.")}`),
      );
    }),
    propertyParameters({ seed: 0xb34c4004, numRuns: 256 }),
  );
});
```

Remove the obsolete `seed` and `budget` constants.

- [ ] **Step 3: Verify normal and replayed execution**

Run:

```bash
pnpm exec vitest run tests/benchmark-json-property.test.ts
FAST_CHECK_SEED=29 FAST_CHECK_NUM_RUNS=16 pnpm exec vitest run tests/benchmark-json-property.test.ts
```

Expected: both runs pass, including the finite-ratio boundary test.

- [ ] **Step 4: Commit the benchmark property migration**

```bash
git add tests/benchmark-json-property.test.ts
git commit -m "test: shrink benchmark validation cases"
```

### Task 7: Add HTML Escape and Tag-Whitespace Properties

**Files:**

- Create: `tests/html-escape-property.test.ts`
- Create: `tests/html-tag-whitespace-property.test.ts`

- [ ] **Step 1: Record focused mutation results before the new properties**

Run:

```bash
pnpm exec stryker run --force --mutate src/html-escape.ts --reporters clear-text
pnpm exec stryker run --force --mutate src/html-whitespace.ts --reporters clear-text
```

Expected: both targeted mutation runs complete. Record any `Survived` and `NoCoverage` entries associated with parsing, idempotence, or semantic preservation in the work log before adding tests.

- [ ] **Step 2: Add HTML escaping properties**

Create `tests/html-escape-property.test.ts`:

```typescript
import fc from "fast-check";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { describe, expect, it } from "vitest";

import { escapeHtml } from "../src/html-escape";
import { propertyParameters } from "./fast-check-config";

type Node = DefaultTreeAdapterMap["node"] & {
  childNodes?: Node[];
  nodeName?: string;
  value?: string;
};

const elementsAndText = (node: Node): { elements: string[]; text: string } => {
  const elements: string[] = [];
  let text = "";
  const visit = (current: Node): void => {
    if (current.nodeName === "#text") text += current.value ?? "";
    else if (current.nodeName && !current.nodeName.startsWith("#")) elements.push(current.nodeName);
    for (const child of current.childNodes ?? []) visit(child);
  };
  visit(node);
  return { elements, text };
};

describe("HTML escaping properties", () => {
  it("keeps arbitrary printable Unicode inside one text node", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 64 }), (value) => {
        const parsed = elementsAndText(parseFragment(`<p>${escapeHtml(value)}</p>`) as Node);
        expect(parsed.elements).toEqual(["p"]);
        expect(parsed.text).toBe(value);
      }),
      propertyParameters({ numRuns: 256 }),
    );
  });

  it("returns text without escapable characters unchanged", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 64 }), (value) => {
        if (!/[&<>"']/.test(value)) expect(escapeHtml(value)).toBe(value);
      }),
      propertyParameters(),
    );
  });
});
```

- [ ] **Step 3: Add tag-whitespace properties**

Create `tests/html-tag-whitespace-property.test.ts`:

```typescript
import fc from "fast-check";
import { parseFragment, serialize } from "parse5";
import { describe, expect, it } from "vitest";

import { normalizeHtmlTagWhitespace } from "../src/html-whitespace";
import { propertyParameters } from "./fast-check-config";

const htmlSpace = fc.string({ unit: fc.constantFrom(" ", "\t", "\n", "\f", "\r"), minLength: 1, maxLength: 8 });
const attributeText = fc.string({ unit: fc.constantFrom("a", "b", "c", " ", "雪"), maxLength: 24 });
const bodyText = fc.string({ unit: fc.constantFrom("a", "b", "c", " ", "雪"), maxLength: 32 });

describe("HTML tag whitespace properties", () => {
  it("is idempotent and preserves parsed semantics", () => {
    fc.assert(
      fc.property(htmlSpace, htmlSpace, htmlSpace, attributeText, attributeText, bodyText, (first, second, last, title, data, text) => {
        const source = `<div${first}title="${title}"${second}data-value='${data}'${last}>${text}</div>`;
        const output = normalizeHtmlTagWhitespace(source);
        expect(normalizeHtmlTagWhitespace(output)).toBe(output);
        expect(serialize(parseFragment(output))).toBe(serialize(parseFragment(source)));
        expect(output).toContain(`title="${title}"`);
        expect(output).toContain(`data-value='${data}'`);
        expect(output).toContain(`>${text}</div>`);
      }),
      propertyParameters(),
    );
  });

  it("preserves generated unterminated quoted tags", () => {
    fc.assert(
      fc.property(htmlSpace, attributeText, (space, value) => {
        const source = `<div${space}title="${value}>`;
        expect(normalizeHtmlTagWhitespace(source)).toBe(source);
      }),
      propertyParameters(),
    );
  });
});
```

- [ ] **Step 4: Run the new properties and focused mutation checks**

Run:

```bash
pnpm exec vitest run tests/html-escape-property.test.ts tests/html-tag-whitespace-property.test.ts
pnpm exec stryker run --force --mutate src/html-escape.ts --reporters clear-text
pnpm exec stryker run --force --mutate src/html-whitespace.ts --reporters clear-text
```

Expected: properties pass. Any previously surviving mutants tied to the new obligations are killed; remaining survivors are recorded rather than hidden.

- [ ] **Step 5: Commit HTML properties**

```bash
git add tests/html-escape-property.test.ts tests/html-tag-whitespace-property.test.ts
git commit -m "test: add HTML transformation properties"
```

### Task 8: Add URL, srcset, and Redirect Properties

**Files:**

- Create: `tests/url-redirect-policy-property.test.ts`

- [ ] **Step 1: Record focused mutation results before the new property suite**

Run:

```bash
pnpm exec stryker run --force --mutate src/url-policy.ts --reporters clear-text
pnpm exec stryker run --force --mutate src/redirect-policy.ts --reporters clear-text
```

Expected: both runs complete. Record policy-selection, decoded-hazard, descriptor, and origin survivors in the work log.

- [ ] **Step 2: Add policy properties**

Create `tests/url-redirect-policy-property.test.ts`:

```typescript
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { validateRedirectTarget } from "../src/redirect-policy";
import { decideSrcset, decideUrlAttribute, urlKindForAttribute, urlPurposeForAttribute } from "../src/url-policy";
import { propertyParameters } from "./fast-check-config";

const ruleCases = [
  ["object", "data", "subresource", "url"],
  ["video", "poster", "subresource", "url"],
  ["img", "srcset", "subresource", "srcset"],
  ["a", "href", "document-navigation", "url"],
  ["link", "href", "subresource", "url"],
  ["form", "action", "form-submission", "url"],
] as const;

const mixedCase = (value: string, mask: readonly boolean[]): string =>
  Array.from(value, (character, index) => (mask[index % mask.length] ? character.toUpperCase() : character)).join("");

const segment = fc.string({ unit: fc.constantFrom(...Array.from("abcdefghijklmnopqrstuvwxyz0123456789")), maxLength: 24 });
const mask = fc.array(fc.boolean(), { minLength: 12, maxLength: 12 });
const hazard = fc
  .tuple(fc.constantFrom("//", "/\\", "/%5c", "/%5C", "/%00", "javascript:", "java%73cript:"), segment)
  .map(([prefix, suffix]) => `${prefix}${suffix}`);
const descriptor = fc.oneof(
  fc.integer({ min: 1, max: 4096 }).map((value) => `${value}w`),
  fc.integer({ min: 1, max: 40 }).map((value) => `${value / 10}x`),
);
const candidate = fc.tuple(segment, descriptor).map(([path, size]) => `/assets/${path || "x"}.png ${size}`);

describe("URL and redirect policy properties", () => {
  it("selects the same rule regardless of ASCII case", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ruleCases), mask, ([element, attribute, purpose, kind], caseMask) => {
        expect(urlPurposeForAttribute(mixedCase(element, caseMask), mixedCase(attribute, caseMask))).toBe(purpose);
        expect(urlKindForAttribute(mixedCase(element, caseMask), mixedCase(attribute, caseMask))).toBe(kind);
      }),
      propertyParameters(),
    );
  });

  it("rejects generated raw and decoded structural hazards", () => {
    fc.assert(
      fc.property(hazard, (value) => {
        expect(decideUrlAttribute({ element: "a", attribute: "href", purpose: "document-navigation", value }).ok).toBe(false);
        expect(validateRedirectTarget(value).ok).toBe(false);
      }),
      propertyParameters({ numRuns: 256 }),
    );
  });

  it("keeps configured absolute origins authoritative", () => {
    fc.assert(
      fc.property(segment, (path) => {
        const allowed = `https://accounts.example/${path}`;
        const denied = `https://evil.example/${path}`;
        expect(
          decideUrlAttribute({
            element: "a",
            attribute: "href",
            purpose: "document-navigation",
            allowedOrigins: ["https://accounts.example"],
            value: allowed,
          }).ok,
        ).toBe(true);
        expect(
          decideUrlAttribute({
            element: "a",
            attribute: "href",
            purpose: "document-navigation",
            allowedOrigins: ["https://accounts.example"],
            value: denied,
          }).ok,
        ).toBe(false);
        expect(validateRedirectTarget(allowed, { allowExternal: true, allowedOrigins: ["https://accounts.example"] }).ok).toBe(true);
        expect(validateRedirectTarget(denied, { allowExternal: true, allowedOrigins: ["https://accounts.example"] }).ok).toBe(false);
      }),
      propertyParameters(),
    );
  });

  it("accepts generated local redirect paths", () => {
    fc.assert(
      fc.property(segment, (path) => {
        expect(validateRedirectTarget(`/${path}`).ok).toBe(true);
      }),
      propertyParameters(),
    );
  });

  it("accepts generated valid srcset candidates", () => {
    fc.assert(
      fc.property(fc.array(candidate, { minLength: 1, maxLength: 4 }), (candidates) => {
        const value = candidates.join(", ");
        expect(decideSrcset({ value })).toEqual({ ok: true, value });
      }),
      propertyParameters(),
    );
  });

  it("rejects a generated srcset containing one invalid candidate", () => {
    const invalid = fc.constantFrom("javascript:alert(1) 1x", "/asset.png 0x", "/asset.png 1q", "/asset.png 1x 2x");
    fc.assert(
      fc.property(fc.array(candidate, { maxLength: 3 }), invalid, fc.nat(), (safe, unsafe, offset) => {
        const insertion = offset % (safe.length + 1);
        const candidates = [...safe.slice(0, insertion), unsafe, ...safe.slice(insertion)];
        expect(decideSrcset({ value: candidates.join(", ") }).ok).toBe(false);
      }),
      propertyParameters(),
    );
  });
});
```

- [ ] **Step 3: Run the property suite and focused mutation checks**

Run:

```bash
pnpm exec vitest run tests/url-redirect-policy-property.test.ts tests/url-policy.test.ts tests/redirect-policy.test.ts
pnpm exec stryker run --force --mutate src/url-policy.ts --reporters clear-text
pnpm exec stryker run --force --mutate src/redirect-policy.ts --reporters clear-text
```

Expected: all policy tests pass. Mutants tied to case normalization, decoded hazards, origins, and srcset descriptors are killed or recorded with a specific remaining reason.

- [ ] **Step 4: Commit URL and redirect properties**

```bash
git add tests/url-redirect-policy-property.test.ts
git commit -m "test: add URL policy properties"
```

### Task 9: Add Stream Composition State Properties

**Files:**

- Create: `tests/stream-segments-property.test.ts`

- [ ] **Step 1: Record the focused mutation result before the new properties**

Run:

```bash
pnpm exec stryker run --force --mutate src/stream-segments.ts --reporters clear-text
```

Expected: the run completes. Record survivors affecting outlet phases, source closure, or duplicate cleanup.

- [ ] **Step 2: Add stateful async-iterable properties without mocks**

Create `tests/stream-segments-property.test.ts`:

```typescript
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { composeSingleOutlet } from "../src/stream-segments";
import { propertyParameters } from "./fast-check-config";

type Tracker = {
  nextCalls: number;
  returnCalls: number;
};

const trackedSource = (values: readonly string[], failAt?: number): { source: AsyncIterable<string>; tracker: Tracker } => {
  let index = 0;
  const tracker: Tracker = { nextCalls: 0, returnCalls: 0 };
  const iterator: AsyncIterableIterator<string> = {
    [Symbol.asyncIterator]: () => iterator,
    next: async () => {
      tracker.nextCalls += 1;
      if (index === failAt) throw new Error("source failed");
      if (index < values.length) return { done: false, value: values[index++] as string };
      return { done: true, value: undefined };
    },
    return: async () => {
      tracker.returnCalls += 1;
      return { done: true, value: undefined };
    },
  };
  return { source: { [Symbol.asyncIterator]: () => iterator }, tracker };
};

const collect = async (source: AsyncIterable<string>): Promise<string[]> => {
  const output: string[] = [];
  for await (const value of source) output.push(value);
  return output;
};

const chunk = fc.string({ unit: "grapheme", maxLength: 16 });

describe("single-outlet stream composition properties", () => {
  it("emits framing and enumerates an included source once", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(chunk, { maxLength: 6 }), chunk, chunk, async (values, before, after) => {
        const tracked = trackedSource(values);
        const composed = await composeSingleOutlet(tracked.source, { before, after, outlet: "once" });
        expect(await collect(composed)).toEqual([
          ...(before ? [before] : []),
          ...values,
          ...(after ? [after] : []),
        ]);
        expect(tracked.tracker.nextCalls).toBe(values.length + 1);
        expect(tracked.tracker.returnCalls).toBe(0);
      }),
      propertyParameters(),
    );
  });

  it("closes an omitted source without pulling it", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(chunk, { maxLength: 6 }), chunk, chunk, async (values, before, after) => {
        const tracked = trackedSource(values);
        const composed = await composeSingleOutlet(tracked.source, { before, after, outlet: "omit" });
        expect(await collect(composed)).toEqual([...(before ? [before] : []), ...(after ? [after] : [])]);
        expect(tracked.tracker.nextCalls).toBe(0);
        expect(tracked.tracker.returnCalls).toBe(1);
      }),
      propertyParameters(),
    );
  });

  it("propagates early return to an unconsumed source exactly once", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(chunk, { minLength: 1, maxLength: 6 }), async (values) => {
        const tracked = trackedSource(values);
        const composed = await composeSingleOutlet(tracked.source, { before: "prefix", after: "suffix", outlet: "once" });
        const iterator = composed[Symbol.asyncIterator]();
        await expect(iterator.next()).resolves.toEqual({ done: false, value: "prefix" });
        await iterator.return?.();
        await iterator.return?.();
        expect(tracked.tracker.nextCalls).toBe(0);
        expect(tracked.tracker.returnCalls).toBe(1);
      }),
      propertyParameters(),
    );
  });

  it("closes a failing source exactly once", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(chunk, { minLength: 1, maxLength: 6 }), fc.nat(), async (values, offset) => {
        const failAt = offset % values.length;
        const tracked = trackedSource(values, failAt);
        const composed = await composeSingleOutlet(tracked.source, { before: "", after: "", outlet: "once" });
        await expect(collect(composed)).rejects.toThrow("source failed");
        expect(tracked.tracker.returnCalls).toBe(1);
      }),
      propertyParameters(),
    );
  });
});
```

- [ ] **Step 3: Run the properties and focused mutation check**

Run:

```bash
pnpm exec vitest run tests/stream-segments-property.test.ts tests/router-document.test.ts
pnpm exec stryker run --force --mutate src/stream-segments.ts --reporters clear-text
```

Expected: the properties pass. Outlet-phase and cleanup mutants are killed or retained with a recorded reason.

- [ ] **Step 4: Commit stream state properties**

```bash
git add tests/stream-segments-property.test.ts
git commit -m "test: add stream composition properties"
```

### Task 10: Run the Full Mutation Baseline and Update the Coverage Ledger

**Files:**

- Create or modify: `.coverage-ledger/mutation-property-testing.md`
- Modify: `docs.local/logs/2026-08-27/2026-08-27-001-mutation-property-testing-design.md`

- [ ] **Step 1: Run all property tests before the expensive baseline**

Run:

```bash
pnpm test:property
```

Expected: every `tests/*-property.test.ts` file passes with the stable default seed.

- [ ] **Step 2: Run a forced full-source mutation baseline**

Run in an interactive execution session so progress can be reported at least once per minute:

```bash
pnpm test:mutation:full
```

Expected: Stryker completes its dry run, mutates every `src/**/*.ts` implementation file, writes `reports/mutation/index.html`, `reports/mutation/mutation.json`, and `reports/mutation/incremental.json`, and exits without a score-gate failure because `thresholds.break` is `null`.

- [ ] **Step 3: Inspect the report and classify every outcome**

Run:

```bash
node --input-type=module -e 'import { readFile } from "node:fs/promises"; const report = JSON.parse(await readFile("reports/mutation/mutation.json", "utf8")); const mutants = Object.values(report.files).flatMap((file) => file.mutants); const counts = Object.groupBy(mutants, (mutant) => mutant.status); console.log(JSON.stringify(Object.fromEntries(Object.entries(counts).map(([status, values]) => [status, values.length])), null, 2));'
```

Expected: JSON counts for every status present in the completed report. Cross-check the total and mutation score against Stryker's terminal summary and HTML report.

- [ ] **Step 4: Write the observed coverage ledger with no guessed values**

Use `apply_patch` to create or replace `.coverage-ledger/mutation-property-testing.md` with:

- the completed run timestamp, elapsed time, Stryker version, seed, and run counts;
- exact status counts and the reported mutation score;
- obligations `P-COMP-01` through `M-SURV-01` from the approved design;
- the test file or report evidence linked to each property obligation;
- every security-relevant survivor, its source location, its behavior change, and status `debt` or `equivalent_with_reason`;
- every `NoCoverage` production file or region grouped by subsystem;
- an explicit statement that no mutation-score threshold has been selected.

Expected: every design obligation is `covered_by_property`, `covered_with_overlap`, `partial`, or `debt`; none is left unlabeled.

- [ ] **Step 5: Check for leaked child processes**

Run:

```bash
ps -axo pid=,ppid=,comm=,args= | rg '(stryker|vitest)' || true
```

Expected: no Stryker or task-owned Vitest child remains. If a new task-owned process remains, verify its PID, parent, `comm`, and full arguments, send SIGTERM to that PID only, recheck it, and use SIGKILL only if the verified process traps termination.

### Task 11: Final Verification and Handoff Commit

**Files:**

- Modify: `docs.local/logs/2026-08-27/2026-08-27-001-mutation-property-testing-design.md`

- [ ] **Step 1: Format changed files**

Run:

```bash
pnpm exec oxfmt --write package.json stryker.config.json vitest.config.ts vitest.mutation.config.ts tests/fast-check-config.ts tests/fast-check-config.test.ts tests/fast-check.setup.ts tests/mutation-config.test.ts tests/mutation-test-policy.ts tests/*-property.test.ts
```

Expected: OxFmt completes successfully. Review the diff to ensure unrelated files were not changed. Do not pass `.gitignore` to OxFmt; preserve its one-pattern-per-line format directly.

- [ ] **Step 2: Run the complete non-mutation verification**

Run:

```bash
pnpm test:property
pnpm test
pnpm lint
pnpm build
git diff --check
```

Expected: all property tests and the full Vitest suite pass, lint has no new errors, build succeeds, and the diff has no whitespace errors.

- [ ] **Step 3: Verify configuration boundaries and artifacts**

Run:

```bash
pnpm exec vitest run tests/fast-check-config.test.ts tests/mutation-config.test.ts
test -f reports/mutation/index.html
test -f reports/mutation/mutation.json
test -f reports/mutation/incremental.json
git check-ignore reports/mutation/index.html .coverage-ledger/mutation-property-testing.md docs.local/logs/2026-08-27/2026-08-27-001-mutation-property-testing-design.md
```

Expected: both configuration suites pass, all mutation artifacts exist, and generated/local artifacts are ignored.

- [ ] **Step 4: Update the local work log**

Use `apply_patch` to append the exact dependency versions, commits, normal/property test counts, full mutation counts and score, elapsed mutation time, remaining high-risk survivors, remaining `NoCoverage` debt, and process-cleanup result to `docs.local/logs/2026-08-27/2026-08-27-001-mutation-property-testing-design.md`.

- [ ] **Step 5: Commit final formatting and verification corrections**

Run:

```bash
git status --short
```

If tracked formatting or test-infrastructure corrections remain, stage only the task-owned paths and commit:

```bash
git add README.md package.json pnpm-lock.yaml stryker.config.json vitest.config.ts vitest.mutation.config.ts tests/fast-check-config.ts tests/fast-check-config.test.ts tests/fast-check.setup.ts tests/mutation-config.test.ts tests/mutation-test-policy.ts tests/*-property.test.ts
git commit -m "test: finalize mutation baseline tooling"
```

Expected: no uncommitted tracked changes remain. Ignored reports, the coverage ledger, and the local work log remain available locally.
