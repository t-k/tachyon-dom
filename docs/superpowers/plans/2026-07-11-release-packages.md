# Release Packages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the `agent-dag` skill to implement this plan task-by-task (it decides whether to use subagents and builds a Single-Writer Agent DAG). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish both documented npm packages from a version-locked tag and prove that the initializer tarball contains the MIT license and required executable artifacts before any registry write.

**Architecture:** Add one repository-internal ESM release verifier that validates the tag/package/dependency version contract and inspects `npm pack --dry-run --json` manifests. Keep asset copying in a separate build helper, then make the release workflow run all builds, validations, and dry runs before publishing root first and initializer second.

**Tech Stack:** Node.js ESM, TypeScript package builds, Vitest, npm pack/publish, pnpm, GitHub Actions.

---

## File Structure

- Create `scripts/release-contract.mjs`: parse and validate the release identity, inspect npm dry-run manifests, expose a CLI used by GitHub Actions.
- Create `scripts/copy-create-package-assets.mjs`: copy the root `LICENSE` bytes into the initializer package before packing.
- Create `tests/release-contract.test.ts`: exercise real temporary package metadata and real npm dry-run manifests without registry writes.
- Modify `packages/create-tachyon-dom/package.json`: include `LICENSE`, use the asset copier in its build, and bind `tachyon-dom` to the exact release version.
- Modify `package.json`: expose repository-level initializer build and release verification commands.
- Modify `.github/workflows/release.yml`: validate and dry-run both packages before ordered publication.
- Modify `tests/dx.test.ts`: lock down workflow ordering and public package metadata.
- Create `.coverage-ledger/release-packages/coverage-ledger.md`: map every release invariant to its test or workflow check.

### Task 1: Release identity contract

**Files:**
- Create: `scripts/release-contract.mjs`
- Create: `tests/release-contract.test.ts`
- Create: `.coverage-ledger/release-packages/coverage-ledger.md`

- [ ] **Step 1: Write failing identity tests**

Add table-driven Vitest cases that call `verifyReleaseIdentity({ tag, rootPackage, createPackage })` with real decoded objects. Assert success with `npmTag: "latest"` for `v1.2.3` and `npmTag: "next"` for `v1.2.3-beta.1`, then precise failures for a malformed tag, build metadata, tag/root mismatch, root/create mismatch, a caret dependency, and an exact but mismatched dependency.

```ts
expect(
  verifyReleaseIdentity({
    tag: "v1.2.3",
    rootPackage: { name: "tachyon-dom", version: "1.2.3" },
    createPackage: { name: "create-tachyon-dom", version: "1.2.3", dependencies: { "tachyon-dom": "1.2.3" } },
  }),
).toEqual({ ok: true, version: "1.2.3", npmTag: "latest" });
```

- [ ] **Step 2: Verify RED**

Run `pnpm exec vitest run tests/release-contract.test.ts`. Expected: FAIL because `scripts/release-contract.mjs` does not exist.

- [ ] **Step 3: Implement the minimal identity verifier**

Export `verifyReleaseIdentity`. Accept only `v` followed by a SemVer core with an optional prerelease and no build metadata. Return `{ ok: false, error }` for invalid or unequal values. Require `createPackage.dependencies["tachyon-dom"] === version`; do not normalize or accept ranges. Return `npmTag: "latest"` for stable versions and the fixed `npmTag: "next"` for prereleases.

- [ ] **Step 4: Verify GREEN**

Run `pnpm exec vitest run tests/release-contract.test.ts`. Expected: all identity cases pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/release-contract.mjs tests/release-contract.test.ts .coverage-ledger/release-packages/coverage-ledger.md
git commit -m "test: define npm release identity contract"
```

### Task 2: Initializer license and tarball contract

**Files:**
- Create: `scripts/copy-create-package-assets.mjs`
- Modify: `scripts/release-contract.mjs`
- Modify: `packages/create-tachyon-dom/package.json`
- Modify: `package.json`
- Test: `tests/release-contract.test.ts`

- [ ] **Step 1: Write failing real-pack tests**

Create a temporary package directory containing `package.json`, `README.md`, `dist/index.js`, and a copied license. Call `inspectPackageDryRun({ packageDir, requiredFiles })`, assert the real npm manifest contains `package.json`, `README.md`, `LICENSE`, and `dist/index.js`, then remove `LICENSE` and assert a precise missing-file error. Add a byte comparison test for `copyCreatePackageAssets({ rootDir, packageDir })`.

- [ ] **Step 2: Verify RED**

Run `pnpm exec vitest run tests/release-contract.test.ts`. Expected: FAIL because the pack inspector and asset copier are missing.

- [ ] **Step 3: Implement asset copying and dry-run inspection**

Use `copyFile` for the license helper. Use `execFile("npm", ["pack", "--dry-run", "--json"], { cwd: packageDir })`, parse the single manifest, normalize each `files[].path`, and fail if any required path is absent. Do not invoke `npm publish`.

- [ ] **Step 4: Wire package scripts and metadata**

Set initializer `files` to `["dist", "README.md", "LICENSE"]`, change its build to `tsc -p tsconfig.json && node ../../scripts/copy-create-package-assets.mjs`, add root `build:create-package`, and add root `verify:release` invoking the verifier CLI.

- [ ] **Step 5: Verify GREEN and inspect the actual repository package**

Run:

```bash
pnpm build:create-package
pnpm exec vitest run tests/release-contract.test.ts
npm pack --dry-run --json ./packages/create-tachyon-dom
```

Expected: tests pass and the manifest lists `LICENSE`, `README.md`, `dist/index.js`, and `package.json`.

- [ ] **Step 6: Commit**

```bash
git add scripts/copy-create-package-assets.mjs scripts/release-contract.mjs tests/release-contract.test.ts packages/create-tachyon-dom/package.json package.json
git commit -m "fix: package initializer license and release artifacts"
```

### Task 3: Fail-closed two-package release workflow

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `tests/dx.test.ts`
- Modify: `.coverage-ledger/release-packages/coverage-ledger.md`

- [ ] **Step 1: Write failing workflow contract assertions**

Read the workflow as text and locate commands by index. Assert that `pnpm verify:release --tag "$GITHUB_REF_NAME"`, both `npm publish --dry-run` commands, root publish, and initializer publish exist in that strict order. Assert the fixed `NPM_TAG` expression maps stable tags to `latest` and prerelease tags to `next`, and every dry-run and publish uses it. Assert the initializer package metadata uses an exact `tachyon-dom` dependency and includes `LICENSE`.

- [ ] **Step 2: Verify RED**

Run `pnpm exec vitest run tests/dx.test.ts`. Expected: the release workflow assertions fail because only the root package is published.

- [ ] **Step 3: Update the workflow**

After the existing checks, build the initializer, run the tests and `pnpm verify:release --tag "$GITHUB_REF_NAME"`, then dry-run root and initializer packages. Define `NPM_TAG` with the fixed GitHub expression `${{ contains(github.ref_name, '-') && 'next' || 'latest' }}` and use `--tag "$NPM_TAG"` for every dry-run and publish. Publish root before initializer:

```yaml
- run: npm publish --provenance --access public --tag latest
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

- run: npm publish --provenance --access public
  working-directory: packages/create-tachyon-dom
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

- [ ] **Step 4: Verify GREEN**

Run `pnpm exec vitest run tests/dx.test.ts tests/release-contract.test.ts`. Expected: both files pass.

- [ ] **Step 5: Update ledger and commit**

Mark tag identity, package identity, dependency binding, license bytes, dry-run manifests, workflow preflight, and publish ordering as covered.

```bash
git add .github/workflows/release.yml tests/dx.test.ts .coverage-ledger/release-packages/coverage-ledger.md
git commit -m "ci: publish both npm packages from validated tags"
```

### Task 4: Verification, security review, and integration

**Files:**
- Modify: `docs.local/issues/open/2026-07-11-release-package-publication-integrity.md` outside the worktree, then move it to `docs.local/issues/closed/`
- Create: `docs.local/logs/2026-07-11/2026-07-11-015-release-packages.md` outside the worktree

- [ ] **Step 1: Run focused release verification**

```bash
pnpm build
pnpm build:create-package
pnpm verify:release --tag v0.1.0
pnpm exec vitest run tests/release-contract.test.ts tests/dx.test.ts
```

Expected: all commands pass without contacting the publish endpoint.

- [ ] **Step 2: Run full repository verification**

```bash
pnpm test
pnpm lint
pnpm verify:package
pnpm check:exports
pnpm check:size
pnpm audit --prod
pnpm verify:starters
```

Expected: all checks pass; only the four existing `no-control-regex` lint warnings may remain.

- [ ] **Step 3: Run a clean-context Security Specialist review**

Review permissions, tag injection resistance, preflight-before-mutation ordering, fixed publish directories, npm token exposure, tarball contents, and retry behavior. Record `Must Fix / Should Fix / Notes`; do not merge with any Must Fix finding.

- [ ] **Step 4: Record closure evidence**

Write the Japanese local work log, append the implementation commits and verification evidence to the local issue, and move it from open to closed. Do not stage `docs.local` or the existing untracked `docs/issues/`.

- [ ] **Step 5: Merge, verify on main, and push**

```bash
git merge --no-ff fix/release-packages -m "merge: harden npm package releases"
pnpm build
pnpm test
git push origin main
```

- [ ] **Step 6: Clean up**

Remove the worktree and merged branch, remove generated temporary tarballs, and confirm `main...origin/main` is `0 0`, no task-owned processes remain, and only the pre-existing untracked `docs/issues/` remains.
