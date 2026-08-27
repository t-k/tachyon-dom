# Security Mutation-Debt Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The Agent DAG decision for this change is single-writer inline execution with read-only specialist reviews.

**Goal:** Add independent tests that kill meaningful security and stream-lifecycle mutants in `constant-time`, `head-policy`, `stream-segments`, and `redirect-policy` while documenting genuinely equivalent or unreachable mutants.

**Architecture:** Keep production source unchanged and strengthen its observable contracts through focused Vitest examples, one bounded fast-check property for head attribute names, and existing public redirect-path tables. Establish fresh per-source mutation baselines before editing tests, then compare target-specific JSON reports by mutant signature after each test group.

**Tech Stack:** TypeScript, Vitest 4, fast-check 4, StrykerJS 10 with the Vitest runner, pnpm, OxLint, OxFmt

---

## File Map

- Modify `tests/constant-time.test.ts`: add coercion-collision and independent digest-failure contracts.
- Create `tests/head-policy-property.test.ts`: add fixed attribute-name boundaries and bounded generated name/event-handler checks.
- Create `tests/stream-segments.test.ts`: add deterministic iterator lifecycle and return-less iterator contracts.
- Modify `tests/redirect-policy.test.ts`: expand the shared validator/router/form redirect matrix.
- Create `.codex/candidate-tournaments/security-mutation-debt/stryker.validator.config.mjs`: ignored local configuration for isolated mutation reports; do not commit.
- Create `.codex/candidate-tournaments/security-mutation-debt/compare-reports.mjs`: ignored local signature comparator; do not commit.
- Modify `/Users/tk/work/tachyon-dom/.coverage-ledger/mutation-property-testing.md`: record final obligation and mutant classifications in the main checkout because this file is ignored.
- Modify `/Users/tk/work/tachyon-dom/docs.local/logs/2026-08-27/2026-08-27-001-mutation-property-testing-design.md`: record execution and review evidence in the main checkout because `docs.local` is ignored.

## Task 1: Establish Fresh Target Baselines

**Files:**

- Create: `.codex/candidate-tournaments/security-mutation-debt/stryker.validator.config.mjs`
- Create: `.codex/candidate-tournaments/security-mutation-debt/compare-reports.mjs`

- [ ] **Step 1: Create the isolated Stryker validator configuration**

Use `apply_patch` to create this ignored local file:

```js
const runId = process.env.TD_MUTATION_RUN_ID;
const target = process.env.TD_MUTATION_TARGET;
const allowedTargets = new Set([
  "src/constant-time.ts",
  "src/head-policy.ts",
  "src/stream-segments.ts",
  "src/redirect-policy.ts",
]);

if (!runId || !/^[a-z0-9-]+$/.test(runId)) throw new Error("Invalid TD_MUTATION_RUN_ID.");
if (!target || !allowedTargets.has(target)) throw new Error("Invalid TD_MUTATION_TARGET.");

const output = `.codex/candidate-tournaments/security-mutation-debt/raw/${runId}`;

export default {
  cleanTempDir: "always",
  concurrency: 1,
  incremental: true,
  incrementalFile: `${output}.incremental.json`,
  jsonReporter: { fileName: `${output}.mutation.json` },
  mutate: [target],
  plugins: ["./node_modules/@stryker-mutator/vitest-runner/dist/src/index.js"],
  reporters: ["clear-text", "json"],
  testRunner: "vitest",
  thresholds: { high: 80, low: 60, break: null },
  vitest: {
    configFile: "vitest.mutation.config.ts",
    related: true,
  },
};
```

- [ ] **Step 2: Create the signature-level report comparator**

Use `apply_patch` to create:

```js
import fs from "node:fs";
import path from "node:path";

const [baselinePath, candidatePath, target] = process.argv.slice(2);
if (!baselinePath || !candidatePath || !target) {
  throw new Error("Usage: node compare-reports.mjs <baseline> <candidate> <target>");
}

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const baseline = read(baselinePath);
const candidate = read(candidatePath);
const cwd = fs.realpathSync(process.cwd());
if (fs.realpathSync(baseline.projectRoot) !== cwd || fs.realpathSync(candidate.projectRoot) !== cwd) {
  throw new Error("Mutation report projectRoot does not match the current checkout.");
}

const selectFile = (report) => {
  const entry = Object.entries(report.files).find(([file]) => file === target || file.endsWith(`/${target}`));
  if (!entry) throw new Error(`Missing target in report: ${target}`);
  if (entry[1].source !== fs.readFileSync(path.resolve(target), "utf8")) {
    throw new Error(`Report source differs from disk: ${target}`);
  }
  return entry[1];
};

const signature = (mutant) =>
  JSON.stringify([mutant.mutatorName, mutant.location, mutant.replacement]);
const before = new Map(selectFile(baseline).mutants.map((mutant) => [signature(mutant), mutant]));
const after = new Map(selectFile(candidate).mutants.map((mutant) => [signature(mutant), mutant]));
if (before.size === 0 || before.size !== after.size) throw new Error("Mutant signature count changed.");

const improvements = [];
for (const [key, previous] of before) {
  const current = after.get(key);
  if (!current) throw new Error(`Missing candidate mutant: ${key}`);
  if (["Pending", "RuntimeError", "CompileError", "Ignored"].includes(current.status)) {
    throw new Error(`Invalid candidate status ${current.status}: ${key}`);
  }
  if (previous.status === "Killed" && current.status !== "Killed") {
    throw new Error(`Killed mutant regressed to ${current.status}: ${key}`);
  }
  if (previous.status !== "Timeout" && current.status === "Timeout") {
    throw new Error(`New timeout: ${key}`);
  }
  if (current.status === "Killed" && (!current.killedBy || current.killedBy.length === 0)) {
    throw new Error(`Killed mutant has no killedBy attribution: ${key}`);
  }
  if (previous.status !== "Killed" && current.status === "Killed") {
    improvements.push({ from: previous.status, to: current.status, killedBy: current.killedBy, signature: key });
  }
}

console.log(JSON.stringify({ target, improvements }, null, 2));
```

- [ ] **Step 3: Run focused tests twice before mutation work**

Run:

```bash
for td_validation_pass in 1 2; do
  env -u FAST_CHECK_PATH FAST_CHECK_SEED=2047983838 FAST_CHECK_NUM_RUNS=100 pnpm exec vitest run --config vitest.mutation.config.ts tests/constant-time.test.ts tests/redirect-policy.test.ts tests/url-redirect-policy-property.test.ts tests/stream-segments-property.test.ts tests/router-document.test.ts tests/router-security.test.ts tests/router-client.test.ts || exit $?
done
```

Expected: both runs pass with the same test count and no worker remains.

- [ ] **Step 4: Generate four fresh baselines**

Run each command sequentially:

```bash
env -u FAST_CHECK_PATH TD_MUTATION_RUN_ID=baseline-constant-time TD_MUTATION_TARGET=src/constant-time.ts FAST_CHECK_SEED=2047983838 FAST_CHECK_NUM_RUNS=100 pnpm exec stryker run .codex/candidate-tournaments/security-mutation-debt/stryker.validator.config.mjs --force --concurrency 1 --cleanTempDir always
env -u FAST_CHECK_PATH TD_MUTATION_RUN_ID=baseline-head-policy TD_MUTATION_TARGET=src/head-policy.ts FAST_CHECK_SEED=2047983838 FAST_CHECK_NUM_RUNS=100 pnpm exec stryker run .codex/candidate-tournaments/security-mutation-debt/stryker.validator.config.mjs --force --concurrency 1 --cleanTempDir always
env -u FAST_CHECK_PATH TD_MUTATION_RUN_ID=baseline-stream-segments TD_MUTATION_TARGET=src/stream-segments.ts FAST_CHECK_SEED=2047983838 FAST_CHECK_NUM_RUNS=100 pnpm exec stryker run .codex/candidate-tournaments/security-mutation-debt/stryker.validator.config.mjs --force --concurrency 1 --cleanTempDir always
env -u FAST_CHECK_PATH TD_MUTATION_RUN_ID=baseline-redirect-policy TD_MUTATION_TARGET=src/redirect-policy.ts FAST_CHECK_SEED=2047983838 FAST_CHECK_NUM_RUNS=100 pnpm exec stryker run .codex/candidate-tournaments/security-mutation-debt/stryker.validator.config.mjs --force --concurrency 1 --cleanTempDir always
```

Expected: all four commands complete, emit a non-zero mutant count, and have no `CompileError` or `RuntimeError`. Record the fresh counts rather than assuming the historical 160 killed, 29 survived, 8 timeout, and 2 no-coverage total.

- [ ] **Step 5: Check process hygiene and repository state**

Run:

```bash
ps -axo pid=,ppid=,comm=,args= | rg '([s]tryker|[v]itest|tinypool|[v]ite.*tachyon-dom)' || true
git status --short
```

Expected: no Stryker or Vitest process remains and only ignored `.codex` artifacts exist, so tracked status is clean.

## Task 2: Strengthen Constant-Time Failure Contracts

**Files:**

- Modify: `tests/constant-time.test.ts`

- [ ] **Step 1: Add the coercion-collision example and independent digest failure table**

Add `{ left: "undefined", right: undefined, expected: false }` to the existing equality table. Add this test below the existing digest rejection test:

```ts
  it.each([1, 2] as const)("fails closed when digest call %i rejects", async (rejectCall) => {
    let digestCalls = 0;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {
        subtle: {
          digest: async () => {
            digestCalls += 1;
            if (digestCalls === rejectCall) throw new Error("digest unavailable");
            return new Uint8Array([7]).buffer;
          },
        },
      },
    });

    await expect(timingSafeEqual("secret", "secret")).resolves.toBe(false);
  });
```

- [ ] **Step 2: Run the focused original-source test**

Run:

```bash
pnpm exec vitest run tests/constant-time.test.ts
```

Expected: pass. This tests-only task uses the fresh surviving-mutant baseline as its red phase; the original implementation is expected to remain green.

- [ ] **Step 3: Run the candidate mutation classification**

Run:

```bash
env -u FAST_CHECK_PATH TD_MUTATION_RUN_ID=candidate-constant-time TD_MUTATION_TARGET=src/constant-time.ts FAST_CHECK_SEED=2047983838 FAST_CHECK_NUM_RUNS=100 pnpm exec stryker run .codex/candidate-tournaments/security-mutation-debt/stryker.validator.config.mjs --force --concurrency 1 --cleanTempDir always
node .codex/candidate-tournaments/security-mutation-debt/compare-reports.mjs .codex/candidate-tournaments/security-mutation-debt/raw/baseline-constant-time.mutation.json .codex/candidate-tournaments/security-mutation-debt/raw/candidate-constant-time.mutation.json src/constant-time.ts
```

Expected: the right-operand type-guard mutant and the `leftDigest || rightDigest` mutant change from `Survived` to `Killed`, with the new tests present in `killedBy`. No killed mutant regresses and no new timeout appears.

- [ ] **Step 4: Commit the constant-time test group**

```bash
git add tests/constant-time.test.ts
git commit -m "test: cover partial constant-time digest failures"
```

## Task 3: Add Head Attribute-Name Properties

**Files:**

- Create: `tests/head-policy-property.test.ts`

- [ ] **Step 1: Create fixed and generated grammar tests**

Create the complete file:

```ts
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { sanitizeHeadAttributes } from "../src/head-policy";
import { propertyParameters } from "./fast-check-config";

const firstNameCharacter = fc.constantFrom(...Array.from("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_:"));
const remainingNameCharacter = fc.constantFrom(
  ...Array.from("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.:-"),
);
const validName = fc
  .tuple(firstNameCharacter, fc.array(remainingNameCharacter, { maxLength: 12 }))
  .map(([first, remaining]) => `${first}${remaining.join("")}`);
const malformedBoundaryName = fc.oneof(
  fc.tuple(fc.constantFrom("0", " ", "/", "="), validName).map(([prefix, name]) => `${prefix}${name}`),
  fc.tuple(validName, fc.constantFrom(" ", "/", "=", "\"")).map(([name, suffix]) => `${name}${suffix}`),
);
const eventHandlerName = fc
  .tuple(fc.constantFrom("o", "O"), fc.constantFrom("n", "N"), validName)
  .map(([o, n, suffix]) => `${o}${n}${suffix}`);

describe("head attribute policy properties", () => {
  it("rejects invalid name boundaries while retaining a valid sentinel", () => {
    expect(
      sanitizeHeadAttributes("meta", {
        "1data-id": "leading",
        "data-id ": "trailing",
        "data-safe": "kept",
      }),
    ).toEqual({ "data-safe": "kept" });
  });

  it("retains valid boundary characters", () => {
    expect(
      sanitizeHeadAttributes("meta", {
        _private: "underscore",
        ":namespace": "colon",
        "http-equiv": "hyphen",
      }),
    ).toEqual({ _private: "underscore", ":namespace": "colon", "http-equiv": "hyphen" });
  });

  it("rejects generated malformed boundaries and event-handler names", () => {
    fc.assert(
      fc.property(malformedBoundaryName, eventHandlerName, (malformedName, handlerName) => {
        expect(
          sanitizeHeadAttributes("meta", {
            [malformedName]: "blocked-boundary",
            [handlerName]: "blocked-handler",
            "data-safe": "kept",
          }),
        ).toEqual({ "data-safe": "kept" });
      }),
      propertyParameters({ numRuns: 64 }),
    );
  });
});
```

- [ ] **Step 2: Run the property file against the original source**

Run:

```bash
FAST_CHECK_SEED=2047983838 FAST_CHECK_NUM_RUNS=64 pnpm exec vitest run --config vitest.property.config.ts tests/head-policy-property.test.ts
```

Expected: 3 tests pass and failures, if any, report the seed and shrunk counterexample.

- [ ] **Step 3: Run and compare the head-policy mutation report**

Run:

```bash
env -u FAST_CHECK_PATH TD_MUTATION_RUN_ID=candidate-head-policy TD_MUTATION_TARGET=src/head-policy.ts FAST_CHECK_SEED=2047983838 FAST_CHECK_NUM_RUNS=64 pnpm exec stryker run .codex/candidate-tournaments/security-mutation-debt/stryker.validator.config.mjs --force --concurrency 1 --cleanTempDir always
node .codex/candidate-tournaments/security-mutation-debt/compare-reports.mjs .codex/candidate-tournaments/security-mutation-debt/raw/baseline-head-policy.mutation.json .codex/candidate-tournaments/security-mutation-debt/raw/candidate-head-policy.mutation.json src/head-policy.ts
```

Expected: both regular-expression anchor mutants change from `Survived` to `Killed`. The defensive missing-`unsafeName` branch may remain and must not be forced through module replacement.

- [ ] **Step 4: Commit the head-policy property group**

```bash
git add tests/head-policy-property.test.ts
git commit -m "test: cover head attribute name boundaries"
```

## Task 4: Add Deterministic Stream Lifecycle Tests

**Files:**

- Create: `tests/stream-segments.test.ts`

- [ ] **Step 1: Create the deterministic stream contract file**

Create the complete file:

```ts
import { describe, expect, it } from "vitest";

import { closeAsyncIterable, composeSingleOutlet } from "../src/stream-segments";

const returnlessSource = (values: readonly string[]): { source: AsyncIterable<string>; nextCalls: () => number } => {
  let index = 0;
  let calls = 0;
  const iterator: AsyncIterableIterator<string> = {
    [Symbol.asyncIterator]: () => iterator,
    next: async () => {
      calls += 1;
      if (index < values.length) return { done: false, value: values[index++] as string };
      if (index === values.length) {
        index += 1;
        return { done: true, value: undefined };
      }
      throw new Error("source read after completion");
    },
  };
  return { source: { [Symbol.asyncIterator]: () => iterator }, nextCalls: () => calls };
};

const closeableSource = (): { source: AsyncIterable<string>; returnCalls: () => number } => {
  let calls = 0;
  const iterator: AsyncIterableIterator<string> = {
    [Symbol.asyncIterator]: () => iterator,
    next: async () => ({ done: true, value: undefined }),
    return: async () => {
      calls += 1;
      return { done: true, value: undefined };
    },
  };
  return { source: { [Symbol.asyncIterator]: () => iterator }, returnCalls: () => calls };
};

describe("single-outlet stream lifecycle", () => {
  it("closes a valid return-less source without throwing", async () => {
    const tracked = returnlessSource([]);
    await expect(closeAsyncIterable(tracked.source)).resolves.toBeUndefined();
  });

  it("emits each phase once and remains terminal", async () => {
    const tracked = returnlessSource(["source"]);
    const composed = await composeSingleOutlet(tracked.source, {
      before: "before",
      after: "after",
      outlet: "once",
    });
    const iterator = composed[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ done: false, value: "before" });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: "source" });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: "after" });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(tracked.nextCalls()).toBe(2);
  });

  it("returns an exact terminal result and closes the source at most once", async () => {
    const tracked = closeableSource();
    const composed = await composeSingleOutlet(tracked.source, { before: "", after: "", outlet: "once" });
    const iterator = composed[Symbol.asyncIterator]();

    await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined });
    await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(tracked.returnCalls()).toBe(1);
  });

  it("does not close the source again after natural completion", async () => {
    const tracked = closeableSource();
    const composed = await composeSingleOutlet(tracked.source, { before: "", after: "", outlet: "once" });
    const iterator = composed[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined });
    expect(tracked.returnCalls()).toBe(0);
  });

  it("cancels a partially consumed return-less source without throwing", async () => {
    const tracked = returnlessSource(["source"]);
    const composed = await composeSingleOutlet(tracked.source, { before: "", after: "", outlet: "once" });
    const iterator = composed[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ done: false, value: "source" });
    await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined });
  });
});
```

- [ ] **Step 2: Run deterministic and existing generated stream tests**

Run:

```bash
FAST_CHECK_SEED=2047983838 FAST_CHECK_NUM_RUNS=100 pnpm exec vitest run tests/stream-segments.test.ts tests/stream-segments-property.test.ts
```

Expected: both files pass. The deterministic file must terminate immediately; no test timeout is used as an assertion.

- [ ] **Step 3: Run and compare the stream mutation report**

Run:

```bash
env -u FAST_CHECK_PATH TD_MUTATION_RUN_ID=candidate-stream-segments TD_MUTATION_TARGET=src/stream-segments.ts FAST_CHECK_SEED=2047983838 FAST_CHECK_NUM_RUNS=100 pnpm exec stryker run .codex/candidate-tournaments/security-mutation-debt/stryker.validator.config.mjs --force --concurrency 1 --cleanTempDir always
node .codex/candidate-tournaments/security-mutation-debt/compare-reports.mjs .codex/candidate-tournaments/security-mutation-debt/raw/baseline-stream-segments.mutation.json .codex/candidate-tournaments/security-mutation-debt/raw/candidate-stream-segments.mutation.json src/stream-segments.ts
```

Expected: optional `return()` removal and meaningful completion/terminal-result mutants become killed. State assignments with identical observable terminal behavior may remain. Existing timeout mutants must not increase.

- [ ] **Step 4: Commit the stream lifecycle group**

```bash
git add tests/stream-segments.test.ts
git commit -m "test: cover deterministic stream lifecycle"
```

## Task 5: Expand Shared Redirect Boundary Cases

**Files:**

- Modify: `tests/redirect-policy.test.ts`

- [ ] **Step 1: Replace the case shape with explicit options and add boundaries**

Replace the `cases` declaration with:

```ts
const cases: readonly {
  location: string;
  options: { allowExternal?: boolean; allowedOrigins?: readonly string[] };
  allowed: boolean;
}[] = [
  { location: "/dashboard", options: {}, allowed: true },
  { location: "/dashboard?next=%2Fsettings", options: {}, allowed: true },
  { location: "/safe//", options: {}, allowed: true },
  { location: "//evil.example/path", options: {}, allowed: false },
  { location: "/%2f%2fevil.example/path", options: {}, allowed: false },
  { location: "/%5C%5Cevil.example/path", options: {}, allowed: false },
  { location: "/\t/evil.example/path", options: {}, allowed: false },
  { location: "https://accounts.example/callback", options: { allowExternal: true }, allowed: false },
  {
    location: "https://accounts.example/callback",
    options: { allowExternal: true, allowedOrigins: [] },
    allowed: false,
  },
  {
    location: "https://evil.example/path",
    options: { allowExternal: true, allowedOrigins: ["https://accounts.example"] },
    allowed: false,
  },
  {
    location: "https://accounts.example/callback",
    options: { allowExternal: true, allowedOrigins: ["https://accounts.example"] },
    allowed: true,
  },
  {
    location: "http://accounts.example/callback",
    options: { allowExternal: true, allowedOrigins: ["http://accounts.example"] },
    allowed: true,
  },
  {
    location: "ftp://accounts.example/file",
    options: { allowExternal: true, allowedOrigins: ["ftp://accounts.example"] },
    allowed: false,
  },
  {
    location: "https://[",
    options: { allowExternal: true, allowedOrigins: ["https://accounts.example"] },
    allowed: false,
  },
  {
    location: "javascript:alert(1)",
    options: { allowExternal: true, allowedOrigins: ["https://accounts.example"] },
    allowed: false,
  },
];
```

Update the table callback to use the explicit `options` value:

```ts
  it.each(cases)("returns $allowed for $location on every redirect path", ({ location, options, allowed }) => {
    const decision = validateRedirectTarget(location, options);
    const routeCall = (): unknown => redirect(location, options);
    const formCall = (): unknown => redirectResponse(location, options);

    expect(decision.ok).toBe(allowed);
    if (allowed) {
      expect(routeCall).not.toThrow();
      expect(formCall).not.toThrow();
    } else {
      expect(routeCall).toThrow("Unsafe redirect target.");
      expect(formCall).toThrow("Unsafe redirect target.");
    }
  });
```

- [ ] **Step 2: Run direct, property, and public redirect paths**

Run:

```bash
FAST_CHECK_SEED=2047983838 FAST_CHECK_NUM_RUNS=100 pnpm exec vitest run tests/redirect-policy.test.ts tests/url-redirect-policy-property.test.ts tests/router-security.test.ts
```

Expected: all selected tests pass, including `/safe//` as an explicit compatibility sentinel.

- [ ] **Step 3: Run and compare the redirect mutation report**

Run:

```bash
env -u FAST_CHECK_PATH TD_MUTATION_RUN_ID=candidate-redirect-policy TD_MUTATION_TARGET=src/redirect-policy.ts FAST_CHECK_SEED=2047983838 FAST_CHECK_NUM_RUNS=100 pnpm exec stryker run .codex/candidate-tournaments/security-mutation-debt/stryker.validator.config.mjs --force --concurrency 1 --cleanTempDir always
node .codex/candidate-tournaments/security-mutation-debt/compare-reports.mjs .codex/candidate-tournaments/security-mutation-debt/raw/baseline-redirect-policy.mutation.json .codex/candidate-tournaments/security-mutation-debt/raw/candidate-redirect-policy.mutation.json src/redirect-policy.ts
```

Expected: the `startsWith("//")` replacement, missing origin guards, HTTP/HTTPS condition changes, and malformed-URL fail-open mutation are killed. Catch-block mutants that only exchange explicit and implicit falsy values may remain equivalent.

- [ ] **Step 4: Commit the redirect boundary group**

```bash
git add tests/redirect-policy.test.ts
git commit -m "test: cover redirect origin and scheme boundaries"
```

## Task 6: Format and Run the Complete Test Matrix

**Files:**

- Modify only files changed by formatting if required.

- [ ] **Step 1: Format changed test files**

Run:

```bash
pnpm exec oxfmt --write tests/constant-time.test.ts tests/head-policy-property.test.ts tests/stream-segments.test.ts tests/redirect-policy.test.ts
git diff --check
```

Expected: OxFmt succeeds and `git diff --check` reports no whitespace error.

- [ ] **Step 2: Run the property suite**

Run:

```bash
FAST_CHECK_SEED=2047983838 FAST_CHECK_NUM_RUNS=100 pnpm test:property
```

Expected: all property files pass, including the new head-policy file if the property config discovers `tests/*-property.test.ts`.

- [ ] **Step 3: Run the full normal suite**

Run:

```bash
pnpm test
```

Expected: all 83 existing files plus the 2 new files pass; the exact test total is recorded.

- [ ] **Step 4: Run lint and build**

Run:

```bash
pnpm lint
pnpm build
```

Expected: both commands exit zero. The existing `no-control-regex` warning in `src/redirect-policy.ts`, if unchanged, is recorded rather than attributed to this tests-only change.

- [ ] **Step 5: Commit formatting changes if any**

If OxFmt changed tracked files after the four component commits:

```bash
git add tests/constant-time.test.ts tests/head-policy-property.test.ts tests/stream-segments.test.ts tests/redirect-policy.test.ts
git commit -m "style: format security mutation tests"
```

If there is no diff, do not create an empty commit.

## Task 7: Classify Remaining Debt and Record Evidence

**Files:**

- Modify: `/Users/tk/work/tachyon-dom/.coverage-ledger/mutation-property-testing.md`
- Modify: `/Users/tk/work/tachyon-dom/docs.local/logs/2026-08-27/2026-08-27-001-mutation-property-testing-design.md`

- [ ] **Step 1: Resolve every improvement to a test name**

For each of the four comparator outputs, map every `killedBy` ID through the report's `testFiles` entries. Record the source, mutator, location, baseline status, candidate status, and killing test. Do not claim an improvement from aggregate score alone.

- [ ] **Step 2: Classify every remaining target survivor and no-coverage mutant**

Use only these labels with a written reason:

```text
killed_by_independent_test
equivalent_with_reason
unreachable_with_reason
timeout_liveness_debt
observable_test_debt
```

Expected equivalence candidates include the constant-time `Math.max`/`Math.min`, loop `<`/`<=`, implicit/explicit `undefined` catch behavior, and stream terminal state assignments that have identical observable results. Fresh results override these expectations.

- [ ] **Step 3: Update the Japanese local coverage ledger and work log**

Append a dated section containing:

- fresh baseline and candidate counts for each target;
- obligation status for `M-SEC-CT-01` through `M-SEC-REDIRECT-03`;
- each remaining target mutant classification;
- focused and full verification counts;
- mutation elapsed times;
- confirmation that no process leaked.

These ignored local documents are intentionally updated in `/Users/tk/work/tachyon-dom`, not the linked worktree, and are not committed.

## Task 8: Resolve Security Review Findings

**Files:**

- Modify: `tests/head-policy-property.test.ts`
- Modify: `tests/router-security.test.ts`
- Modify: `tests/router-client.test.ts`
- Modify: `src/head-policy.ts`
- Modify: `tests/constant-time.test.ts`
- Modify: `tests/stream-segments.test.ts`
- Modify: `tests/stream-segments-property.test.ts`

- [ ] **Step 1: Add direct failing tests for case-fold duplicate head attributes**

Add these examples to `tests/head-policy-property.test.ts`:

```ts
  it("keeps the first case-folded attribute and discards later duplicates", () => {
    expect(
      sanitizeHeadAttributes("meta", {
        "http-equiv": "not-refresh",
        "HTTP-EQUIV": "refresh",
        content: "0;url=javascript:alert(1)",
      }),
    ).toEqual({ "http-equiv": "not-refresh", content: "0;url=javascript:alert(1)" });
  });

  it("does not let a later duplicate rescue an unsafe first value", () => {
    expect(
      sanitizeHeadAttributes("meta", {
        "http-equiv": "refresh",
        CONTENT: "0;url=javascript:alert(1)",
        content: "0;url=/safe",
      }),
    ).toEqual({ "http-equiv": "refresh" });
  });
```

Add a generator whose first character cannot create an `on` prefix:

```ts
const caseFoldedName = fc
  .tuple(
    fc.constantFrom(...Array.from("abcdefghijklmnpqrstuvwxyz")),
    fc.array(fc.constantFrom(...Array.from("abcdefghijklmnopqrstuvwxyz")), { maxLength: 11 }),
  )
  .map(([first, remaining]) => `${first}${remaining.join("")}`);
```

Add this bounded property:

```ts
  it("returns at most one attribute for each ASCII case-folded name", () => {
    fc.assert(
      fc.property(caseFoldedName, (name) => {
        const result = sanitizeHeadAttributes("meta", {
          [name]: "first",
          [name.toUpperCase()]: "second",
          "data-safe": "kept",
        });
        expect(result).toEqual({ [name]: "first", "data-safe": "kept" });
        expect(new Set(Object.keys(result ?? {}).map((key) => key.toLowerCase())).size).toBe(
          Object.keys(result ?? {}).length,
        );
      }),
      propertyParameters({ numRuns: 64 }),
    );
  });
```

- [ ] **Step 2: Add failing SSR and client parity regressions**

Add to `tests/router-security.test.ts`:

```ts
  it("renders only the first case-folded head attribute", () => {
    expect(
      renderHead({
        metas: [
          {
            "http-equiv": "not-refresh",
            "HTTP-EQUIV": "refresh",
            content: "0;url=javascript:alert(1)",
          },
        ],
      }),
    ).toBe('<meta http-equiv="not-refresh" content="0;url=javascript:alert(1)">');
  });
```

Extend the descriptor in `tests/router-client.test.ts` within `applies the same URL policy to server and client head elements`:

```ts
      metas: [
        { "http-equiv": "refresh", content: "0;url=javascript:alert(1)", "data-id": "refresh" },
        {
          "http-equiv": "not-refresh",
          "HTTP-EQUIV": "refresh",
          content: "0;url=javascript:alert(1)",
          "data-id": "case-fold-refresh",
        },
      ],
```

Add these assertions after the existing unsafe refresh assertion:

```ts
    const caseFoldRefresh = document.head.querySelector(`[data-id="case-fold-refresh"]`);
    expect(caseFoldRefresh?.getAttribute("http-equiv")).toBe("not-refresh");
    expect(caseFoldRefresh?.attributes).toHaveLength(4);
```

- [ ] **Step 3: Run the head regressions and verify RED**

Run:

```bash
FAST_CHECK_SEED=2047983838 FAST_CHECK_NUM_RUNS=64 pnpm exec vitest run tests/head-policy-property.test.ts tests/router-security.test.ts tests/router-client.test.ts
```

Expected: the direct duplicate tests, exact SSR output, property, or server/client parity test fails because the original implementation preserves both case-folded keys. Confirm the failure is the duplicate-attribute contract, not a fixture or type error.

- [ ] **Step 4: Implement first-wins case-fold deduplication**

Replace the construction of `safeNames` in `src/head-policy.ts` with:

```ts
  const normalizedNames = new Set<string>();
  const safeNames = Object.fromEntries(
    Object.entries(attributes).filter(([name]) => {
      if (!headAttributeNamePattern.test(name) || name.toLowerCase().startsWith("on")) return false;
      const normalizedName = name.toLowerCase();
      if (normalizedNames.has(normalizedName)) return false;
      normalizedNames.add(normalizedName);
      return true;
    }),
  );
```

Keep `Object.fromEntries` so dangerous property names remain own data properties and cannot mutate the result prototype.

- [ ] **Step 5: Run the head regressions and verify GREEN**

Run:

```bash
FAST_CHECK_SEED=2047983838 FAST_CHECK_NUM_RUNS=64 pnpm exec vitest run tests/head-policy-property.test.ts tests/router-security.test.ts tests/router-client.test.ts
```

Expected: all selected files pass, SSR/client normalized head output agrees, and case-fold duplicate groups have one first-write attribute.

- [ ] **Step 6: Regenerate the changed-source head mutation report**

Run:

```bash
env -u FAST_CHECK_PATH TD_MUTATION_RUN_ID=review-head-policy TD_MUTATION_TARGET=src/head-policy.ts FAST_CHECK_SEED=2047983838 FAST_CHECK_NUM_RUNS=64 pnpm exec stryker run .codex/candidate-tournaments/security-mutation-debt/stryker.validator.config.mjs --force --concurrency 1 --cleanTempDir always
```

Expected: no `NoCoverage`, `CompileError`, or `RuntimeError`. Inspect every mutant introduced in the deduplication block and resolve its `killedBy` test name. Do not compare the complete signature set to the old report because the source changed.

- [ ] **Step 7: Make the digest fixture realistic**

In `tests/constant-time.test.ts`, replace the one-byte result:

```ts
            return new Uint8Array(32).fill(7).buffer;
```

Run:

```bash
pnpm exec vitest run tests/constant-time.test.ts
```

Expected: all 16 tests pass. No production change is required.

- [ ] **Step 8: Add the native async-generator ordering test**

Add to `tests/stream-segments.test.ts`:

```ts
  it("preserves async-generator request order when return follows a pending next", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const settled: string[] = [];

    async function* source(): AsyncIterable<string> {
      await gate;
      yield "late";
    }

    const composed = await composeSingleOutlet(source(), { before: "", after: "after", outlet: "once" });
    const iterator = composed[Symbol.asyncIterator]();
    const pendingNext = iterator.next().then((result) => {
      settled.push("next");
      return result;
    });
    const pendingReturn = iterator.return!().then((result) => {
      settled.push("return");
      return result;
    });

    release();

    await expect(pendingNext).resolves.toEqual({ done: false, value: "late" });
    await expect(pendingReturn).resolves.toEqual({ done: true, value: undefined });
    expect(settled).toEqual(["next", "return"]);
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });
```

Run `pnpm exec vitest run tests/stream-segments.test.ts` and expect all tests to pass. This documents standard async-generator request ordering and does not require a source change.

- [ ] **Step 9: Bound generated stream collection**

Replace the helper in `tests/stream-segments-property.test.ts` with:

```ts
const collect = async (source: AsyncIterable<string>, maxChunks = Number.POSITIVE_INFINITY): Promise<string[]> => {
  const output: string[] = [];
  const iterator = source[Symbol.asyncIterator]();
  while (true) {
    const next = await iterator.next();
    if (next.done) return output;
    if (output.length === maxChunks) throw new Error(`stream exceeded ${maxChunks} chunks`);
    output.push(next.value);
  }
};
```

In the included-source property, construct `expected` before collection and pass its length:

```ts
        const expected = [...(before ? [before] : []), ...values, ...(after ? [after] : [])];
        expect(await collect(composed, expected.length)).toEqual(expected);
```

Run focused tests, then a fresh stream mutation report:

```bash
FAST_CHECK_SEED=2047983838 FAST_CHECK_NUM_RUNS=100 pnpm exec vitest run tests/stream-segments.test.ts tests/stream-segments-property.test.ts
env -u FAST_CHECK_PATH TD_MUTATION_RUN_ID=review-stream-segments TD_MUTATION_TARGET=src/stream-segments.ts FAST_CHECK_SEED=2047983838 FAST_CHECK_NUM_RUNS=100 pnpm exec stryker run .codex/candidate-tournaments/security-mutation-debt/stryker.validator.config.mjs --force --concurrency 1 --cleanTempDir always
node .codex/candidate-tournaments/security-mutation-debt/compare-reports.mjs .codex/candidate-tournaments/security-mutation-debt/raw/baseline-stream-segments.mutation.json .codex/candidate-tournaments/security-mutation-debt/raw/review-stream-segments.mutation.json src/stream-segments.ts
```

Expected: the observable condition mutants at lines 44 and 48 and the `done: false` terminal mutant at line 64 become `Killed`. Only the two synchronous infinite-loop mutants remain Timeout.

- [ ] **Step 10: Format, verify, and commit the review fixes**

Run:

```bash
pnpm exec oxfmt --write src/head-policy.ts tests/head-policy-property.test.ts tests/router-security.test.ts tests/router-client.test.ts tests/constant-time.test.ts tests/stream-segments.test.ts tests/stream-segments-property.test.ts
pnpm test:property
pnpm test
pnpm lint
pnpm build
git diff --check
```

Expected: all commands pass. Commit the coherent review response:

```bash
git add src/head-policy.ts tests/head-policy-property.test.ts tests/router-security.test.ts tests/router-client.test.ts tests/constant-time.test.ts tests/stream-segments.test.ts tests/stream-segments-property.test.ts
git commit -m "fix: reject ambiguous head attribute casing"
```

## Task 9: Repeat Security and Correctness Review

**Files:**

- Review the complete branch diff and the target mutation artifacts.

- [ ] **Step 1: Run Security Specialist review**

Provide the reviewer with the design, test diff, four baseline reports, four candidate reports, and coverage-ledger classifications. Require output in this format:

```text
Must Fix
- ...

Should Fix
- ...

Notes
- ...
```

Expected: no unresolved Must Fix finding. Any Must Fix blocks completion and starts systematic debugging before changes are made.

- [ ] **Step 2: Run clean-context correctness review**

Ask the reviewer to check false-positive assertions, fast-check generator validity, iterator edge cases, mutation comparison logic, test isolation, and missing regression coverage. Resolve all correctness-critical findings and rerun affected focused tests and mutation targets.

- [ ] **Step 3: Re-run final verification after review changes**

Run:

```bash
pnpm test:property
pnpm test
pnpm lint
pnpm build
git diff --check
ps -axo pid=,ppid=,comm=,args= | rg '([s]tryker|[v]itest|tinypool|[v]ite.*tachyon-dom)' || true
git status --short --branch
```

Expected: all commands pass, no Stryker or Vitest process remains, and the branch contains only intentional commits.

- [ ] **Step 4: Commit any review-driven test correction**

Use a narrow message that describes the correction, for example:

```bash
git add tests
git commit -m "test: address security mutation review"
```

Do not create a commit when no tracked file changed.

## Task 10: Integrate the Completed Branch

**Files:**

- No additional tracked edits expected.

- [ ] **Step 1: Verify the branch is ready**

Run:

```bash
git status --short --branch
git log --oneline --decorate main..HEAD
```

Expected: clean tracked state and a small sequence of design and test commits.

- [ ] **Step 2: Fast-forward main after user approval**

From `/Users/tk/work/tachyon-dom`, run:

```bash
git merge --ff-only test/security-mutation-debt
pnpm build
pnpm test
```

Expected: main advances without a merge commit, ignored `dist` artifacts are refreshed, and the full suite passes in the main checkout.

- [ ] **Step 3: Remove the completed worktree and branch**

After confirming that main contains the commits and both worktrees are clean:

```bash
git worktree remove /Users/tk/work/tachyon-dom/.worktree/security-mutation-debt
git worktree prune
git branch -d test/security-mutation-debt
```

Expected: the linked worktree is removed, metadata is pruned, and the merged feature branch is deleted. Mutation reports and ignored coverage documentation remain in the main checkout.
