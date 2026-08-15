# Open Issue Package and Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the `agent-dag` skill to implement this plan task-by-task (it decides whether to use subagents and builds a Single-Writer Agent DAG). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close issues 011, 012, 018, 020, 021, and 028 with executable documentation, a smaller runtime install, correct diagnostics, resilient size policy, and complete package metadata.

**Architecture:** Turn public documentation and release expectations into machine-checked contracts. Keep heavyweight compiler tools optional for runtime consumers, verify packed tarballs in clean projects, and isolate Brotli variance from exact minified-byte and absolute-budget checks.

**Tech Stack:** TypeScript, Node ESM, pnpm pack/install, Vitest, npm package metadata, Brotli/zlib, publint, Are the Types Wrong.

---

### Task 1: Verify public Markdown imports (Issue 011)

**Files:**
- Modify: `README.md`
- Modify: `tests/dx.test.ts`

- [ ] **Step 1: Write the failing README import contract**

```ts
it("resolves every tachyon-dom import in public Markdown", async () => {
  const markdownFiles = ["README.md", ...(await publicMarkdownFiles("docs"))];
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const imports = await collectTachyonImports(markdownFiles);
  for (const imported of imports) {
    expect(resolvePackageExport(imported.specifier, packageJson.exports)).toBeDefined();
    expect(await builtExportNames(imported.specifier)).toContain(imported.name);
  }
});
```

The collector reads JavaScript and TypeScript fenced code blocks, extracts named imports from `tachyon-dom` subpaths, and reports filename and line on failure.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run tests/dx.test.ts -t 'public Markdown'`

Expected: README imports nonexistent `createRouter` from `tachyon-dom/router`.

- [ ] **Step 3: Correct the README example**

```ts
import { createClientRouter } from "tachyon-dom";

const router = createClientRouter({
  routes,
});
```

Keep server route rendering examples on the documented `tachyon-dom/router` functions rather than inventing a factory.

- [ ] **Step 4: Verify GREEN and exports**

```bash
pnpm build
pnpm exec vitest run tests/dx.test.ts -t 'public Markdown'
pnpm check:exports
```

Expected: every public Markdown import resolves to a built export.

- [ ] **Step 5: Commit**

```bash
git add README.md tests/dx.test.ts
git commit -m "docs: fix public router imports"
```

### Task 2: Make heavyweight compiler dependencies optional (Issue 012)

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `src/optional-dependency.ts`
- Modify: `src/compiler/sfc.ts`
- Modify: `src/html-whitespace.ts`
- Modify: `src/compiler/expression.ts`
- Modify: `src/language-server.ts`
- Create: `scripts/verify-clean-consumer.mjs`
- Modify: `tests/dx.test.ts`
- Modify: `tests/language-server.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Record the clean-install baseline**

```bash
TD_BENCH_RUN="2026-08-15-012-node-$(node -p 'process.version')-pnpm-$(pnpm --version)"
mkdir -p "benchmark/package-install/results/$TD_BENCH_RUN"
pnpm build
TD_PACK_DIR=$(mktemp -d)
TD_CONSUMER_DIR=$(mktemp -d)
trap 'rm -rf "$TD_PACK_DIR" "$TD_CONSUMER_DIR"' EXIT
pnpm pack --pack-destination "$TD_PACK_DIR"
TD_TARBALL=$(find "$TD_PACK_DIR" -maxdepth 1 -name 'tachyon-dom-*.tgz' -print -quit)
cd "$TD_CONSUMER_DIR"
pnpm init
pnpm add "$TD_TARBALL"
{
  node --version
  pnpm --version
  du -sk node_modules
  pnpm list --depth Infinity
} | tee "/home/tk/work/tachyon-dom/.worktrees/open-issues-2026-08-15/benchmark/package-install/results/$TD_BENCH_RUN/before.txt"
cd /home/tk/work/tachyon-dom/.worktrees/open-issues-2026-08-15
```

Expected: the report records tarball bytes, `node_modules` KiB, package names, Node, and pnpm versions.

- [ ] **Step 2: Write failing package-shape and clean-consumer tests**

```ts
it("keeps compiler tooling out of runtime dependencies", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  for (const name of ["typescript", "oxc-parser", "parse5", "vscode-languageserver", "vscode-languageserver-textdocument"]) {
    expect(manifest.dependencies?.[name]).toBeUndefined();
    expect(manifest.peerDependenciesMeta?.[name]).toEqual({ optional: true });
    expect(manifest.devDependencies?.[name]).toBeDefined();
  }
});
```

Run the clean consumer script from the test and assert runtime root import succeeds without those packages, while a compiler feature reports the missing package and an install command.

- [ ] **Step 3: Verify RED**

Run: `pnpm exec vitest run tests/dx.test.ts tests/language-server.test.ts -t 'runtime dependencies|clean consumer'`

Expected: all heavyweight packages are ordinary dependencies and runtime-only installation includes them.

- [ ] **Step 4: Add a deterministic optional dependency loader**

```ts
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const requireOptionalDependency = <T>(name: string, feature: string): T => {
  try {
    return require(name) as T;
  } catch (cause) {
    throw new Error(`${feature} requires the optional peer dependency "${name}". Install it with: pnpm add ${name}`, {
      cause,
    });
  }
};
```

Convert runtime imports in SFC transformation, whitespace parsing, expression parsing, and language-server startup to type-only imports plus the loader at the first feature call. Do not import this Node-only helper from the browser/runtime root graph.

- [ ] **Step 5: Move manifest entries and regenerate the lockfile**

```json
{
  "peerDependencies": {
    "typescript": "npm:@typescript/typescript6@^6.0.2",
    "oxc-parser": "^0.136.0",
    "parse5": "^7.3.0",
    "vscode-languageserver": "^10.0.1",
    "vscode-languageserver-textdocument": "^1.0.12"
  },
  "peerDependenciesMeta": {
    "typescript": { "optional": true },
    "oxc-parser": { "optional": true },
    "parse5": { "optional": true },
    "vscode-languageserver": { "optional": true },
    "vscode-languageserver-textdocument": { "optional": true }
  }
}
```

Keep the same versions in `devDependencies`, then run `pnpm install --lockfile-only`.

- [ ] **Step 6: Implement the packed clean-consumer verifier**

The script creates two temporary consumers, packs the current package, installs the tarball with optional dependencies omitted in the first consumer, imports `createSignal`, and confirms heavyweight package directories are absent. The second consumer installs the documented compiler peers and runs `compileTemplate` plus language-server import. Both temporary directories are removed in `finally`.

```js
const runtimeCheck = 'import { createSignal } from "tachyon-dom"; const value=createSignal(1); if(value()!==1)process.exit(1)';
await run("pnpm", ["add", "--config.optional=false", tarball], runtimeDir);
await run("node", ["--input-type=module", "-e", runtimeCheck], runtimeDir);
```

- [ ] **Step 7: Verify GREEN, measure, and commit**

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm exec vitest run tests/dx.test.ts tests/language-server.test.ts
node scripts/verify-clean-consumer.mjs | tee "benchmark/package-install/results/$TD_BENCH_RUN/after.txt"
pnpm check:browser-entry
pnpm check:exports
pnpm check:size
git add package.json pnpm-lock.yaml src/optional-dependency.ts src/compiler/sfc.ts src/html-whitespace.ts src/compiler/expression.ts src/language-server.ts scripts/verify-clean-consumer.mjs tests/dx.test.ts tests/language-server.test.ts README.md
git commit -m "perf: keep compiler tooling optional for runtime installs"
```

### Task 3: Restore released changelog entries and enforce the process (Issue 018)

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `scripts/release-contract.mjs`
- Modify: `tests/release-contract.test.ts`
- Modify: `docs/releasing.md`

- [ ] **Step 1: Write the failing release-history tests**

```ts
it.each(["0.1.1", "0.1.2", "0.1.3"])("contains a changelog entry for release %s", async (version) => {
  const changelog = await readFile("CHANGELOG.md", "utf8");
  expect(changelog).toMatch(new RegExp(`^## \\[${version.replaceAll(".", "\\.")}\\]`, "m"));
});

it("requires the current release version in CHANGELOG", () => {
  expect(verifyChangelogVersion("# Changelog\n", "0.2.0")).toEqual({
    ok: false,
    error: "CHANGELOG.md must contain a 0.2.0 release heading.",
  });
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run tests/release-contract.test.ts -t 'changelog|release history'`

Expected: 0.1.2 and 0.1.3 headings are missing and the release contract does not inspect CHANGELOG.

- [ ] **Step 3: Add the missing release notes and release check**

Add these dated release sections before 0.1.1, preserving the existing Keep a Changelog structure.

```markdown
## [0.1.3] - 2026-07-26

### Fixed

- Rechecked the npm tag immediately before publishing and published each release to its matching npm tag.

## [0.1.2] - 2026-07-26

### Changed

- Refreshed client layouts after query navigation and hardened release and package verification gates.

### Fixed

- Preserved request-body ownership across progressive, superseded, guarded, and terminal middleware paths.
- Kept generated form patterns frozen and aligned adapter, cookie, Vite, CLI, and runtime boundaries.

### Security

- Failed closed on malformed CSRF bodies and enforced form-key and action-body limits.
- Hardened request, cookie-signature, middleware authorization, and reconstructed-context boundaries.
```

Update `[Unreleased]` to compare from 0.1.3, add 0.1.3 and 0.1.2 compare links, export a pure `verifyChangelogVersion(changelog, version)`, and call it during release preparation before artifacts are packed.

```js
export const verifyChangelogVersion = (changelog, version) =>
  new RegExp(`^## \\[${version.replaceAll(".", "\\.")}\\]`, "m").test(changelog)
    ? { ok: true }
    : failure(`CHANGELOG.md must contain a ${version} release heading.`);
```

- [ ] **Step 4: Verify GREEN**

Run:

```bash
pnpm exec vitest run tests/release-contract.test.ts
TD_RELEASE_DIR=$(mktemp -d)
pnpm prepare:release --tag v0.1.1 --output "$TD_RELEASE_DIR"
node scripts/release-contract.mjs --verify-artifacts "$TD_RELEASE_DIR" --tag v0.1.1
rm -rf "$TD_RELEASE_DIR"
```

Expected: release history and current-version fixtures pass; missing-heading fixtures fail with the documented message.

- [ ] **Step 5: Document and commit**

```bash
git add CHANGELOG.md scripts/release-contract.mjs tests/release-contract.test.ts docs/releasing.md
git commit -m "docs: restore missing release history"
```

### Task 4: Correct route parity diagnostics (Issue 020)

**Files:**
- Modify: `src/testing.ts`
- Test: `tests/testing-utils.test.ts`

- [ ] **Step 1: Write the failing diagnostic assertion**

```ts
it("reports caller HTML as expected and rendered HTML as received", async () => {
  await expect(assertRouteParity(routes, [{ path: "/", clientHtml: "<p>client</p>" }])).rejects.toThrow(
    "expected <p>client</p>, received <p>server</p>",
  );
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run tests/testing-utils.test.ts -t 'caller HTML as expected'`

Expected: the current message reports the values in reverse order.

- [ ] **Step 3: Swap the diagnostic operands**

```ts
throw new Error(
  `Route parity mismatch for ${testCase.path}: expected ${testCase.clientHtml}, received ${rendered.html}`,
);
```

- [ ] **Step 4: Verify GREEN**

Run: `pnpm exec vitest run tests/testing-utils.test.ts`

Expected: the exact message and existing prefix tests pass; no unrelated helper uses an inverted pair.

- [ ] **Step 5: Commit**

```bash
git add src/testing.ts tests/testing-utils.test.ts
git commit -m "fix: correct route parity diagnostics"
```

### Task 5: Tolerate bounded Brotli variance (Issue 021)

**Files:**
- Create: `scripts/quick-example-size-policy.mjs`
- Modify: `scripts/verify-quick-example-bundle.mjs`
- Modify: `scripts/browser-bundle-sizes.json`
- Modify: `README.md`
- Create: `tests/quick-example-size-policy.test.ts`

- [ ] **Step 1: Write the failing pure policy tests**

```ts
it.each([
  [3850, 3849, true],
  [3850, 3850, true],
  [3850, 3851, true],
  [3850, 3889, true],
  [3850, 3890, false],
])("checks Brotli baseline %i against %i", (expected, actual, accepted) => {
  expect(checkQuickExampleSizes({
    expectedMinified: 11571,
    actualMinified: 11571,
    expectedBrotli: expected,
    actualBrotli: actual,
    maxMinified: 12000,
    maxBrotli: 4000,
  }).ok).toBe(accepted);
});

it("keeps minified bytes exact", () => {
  expect(checkQuickExampleSizes({ ...validSizes, actualMinified: validSizes.expectedMinified + 1 }).ok).toBe(false);
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run tests/quick-example-size-policy.test.ts`

Expected: the pure policy module does not exist and the current CLI requires exact Brotli bytes.

- [ ] **Step 3: Extract and apply the policy**

```js
export const checkQuickExampleSizes = (sizes) => {
  if (sizes.actualMinified !== sizes.expectedMinified) return { ok: false, reason: "minified baseline" };
  if (sizes.actualMinified > sizes.maxMinified || sizes.actualBrotli > sizes.maxBrotli) {
    return { ok: false, reason: "absolute budget" };
  }
  const tolerance = Math.max(16, Math.ceil(sizes.expectedBrotli * 0.01));
  return Math.abs(sizes.actualBrotli - sizes.expectedBrotli) <= tolerance
    ? { ok: true, tolerance }
    : { ok: false, reason: "Brotli baseline", tolerance };
};
```

Make the CLI report `process.version` and `process.versions.zlib`. Update the measured Brotli record and README together only if the current same-environment measurement establishes the new center value.

- [ ] **Step 4: Verify GREEN and record the run**

```bash
pnpm build
TD_BENCH_RUN="2026-08-15-021-node-$(node -p 'process.version')-zlib-$(node -p 'process.versions.zlib')"
mkdir -p "benchmark/package-size/results/$TD_BENCH_RUN"
pnpm exec vitest run tests/quick-example-size-policy.test.ts tests/readme-landing.test.ts
node scripts/verify-quick-example-bundle.mjs | tee "benchmark/package-size/results/$TD_BENCH_RUN/after.txt"
```

Expected: minified mismatch and absolute budget failures are rejected, bounded Brotli variance passes, and README matches the recorded center value.

- [ ] **Step 5: Commit**

```bash
git add scripts/quick-example-size-policy.mjs scripts/verify-quick-example-bundle.mjs scripts/browser-bundle-sizes.json README.md tests/quick-example-size-policy.test.ts
git commit -m "test: tolerate bounded Brotli variance"
```

### Task 6: Add create-package repository directory metadata (Issue 028)

**Files:**
- Modify: `packages/create-tachyon-dom/package.json`
- Modify: `tests/dx.test.ts`
- Modify: `tests/release-contract.test.ts`
- Modify: `scripts/release-contract.mjs`

- [ ] **Step 1: Write the failing metadata contract**

```ts
it("declares the create package repository directory", async () => {
  const manifest = JSON.parse(await readFile("packages/create-tachyon-dom/package.json", "utf8"));
  expect(manifest.repository).toEqual({
    type: "git",
    url: "git+https://github.com/t-k/tachyon-dom.git",
    directory: "packages/create-tachyon-dom",
  });
  expect(await stat(manifest.repository.directory)).toMatchObject({});
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run tests/dx.test.ts tests/release-contract.test.ts -t 'repository directory|repository metadata'`

Expected: the create package has only type and URL.

- [ ] **Step 3: Add and validate the directory**

```json
{
  "repository": {
    "type": "git",
    "url": "git+https://github.com/t-k/tachyon-dom.git",
    "directory": "packages/create-tachyon-dom"
  }
}
```

Extend release validation to require this directory only for the create package while leaving root repository metadata unchanged.

- [ ] **Step 4: Verify GREEN and package tools**

```bash
pnpm exec vitest run tests/dx.test.ts tests/release-contract.test.ts
pnpm build
pnpm check:exports
```

Expected: metadata tests, publint, and Are the Types Wrong pass.

- [ ] **Step 5: Commit**

```bash
git add packages/create-tachyon-dom/package.json tests/dx.test.ts tests/release-contract.test.ts scripts/release-contract.mjs
git commit -m "fix: identify create package repository directory"
```

### Task 7: Run package and documentation verification

**Files:**
- No source changes expected.

- [ ] **Step 1: Run focused and publication gates**

```bash
pnpm exec vitest run tests/dx.test.ts tests/language-server.test.ts tests/release-contract.test.ts tests/testing-utils.test.ts tests/quick-example-size-policy.test.ts tests/readme-landing.test.ts
pnpm build
pnpm verify:package
pnpm verify:starters
pnpm check:exports
pnpm check:size
pnpm check:browser-entry
pnpm check:quick-example-size
TD_RELEASE_DIR=$(mktemp -d)
pnpm prepare:release --tag v0.1.1 --output "$TD_RELEASE_DIR"
node scripts/release-contract.mjs --verify-artifacts "$TD_RELEASE_DIR" --tag v0.1.1
rm -rf "$TD_RELEASE_DIR"
```

Expected: every command exits 0 and the clean consumer leaves no temporary directory behind.
