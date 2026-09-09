# Releasing

Releases are published from GitHub Actions, not from a local workstation.

1. Align the root version, `packages/create-tachyon-dom/package.json` version and its `tachyon-dom` dependency, refresh the lockfile with `pnpm install --lockfile-only`, and finalize the candidate notes with a matching dated version heading in `CHANGELOG.md`.
2. Run `pnpm build`, `pnpm verify:url-policy-codegen`, `pnpm verify:package`, `pnpm verify:clean-consumer`, `pnpm check:exports`, `pnpm check:size`, and `pnpm test`.
3. Commit the version and changelog changes.
4. Push a version tag that starts with `v`, for example `v0.1.1`.

The `Release` workflow first calls the local reusable CI workflow at the tagged commit. Artifact preparation depends on all required CI jobs, including three-browser tests, clean consumers, starter production builds, type contracts, and size gates. Tests are not duplicated in the artifact job. Only the later publish job has OIDC write permission.

The `Release` workflow rejects a tag whose version is absent from `CHANGELOG.md`, installs with the lockfile, builds the package, verifies the built URL-policy helper against the source policy, verifies packaged files, runs `publint`, runs `attw --pack --no-emoji`, checks the per-subpath size budgets, and publishes with npm Trusted Publishing:

```sh
npm publish --access public
```

The regular CI workflow also runs `pnpm verify:clean-consumer` on every pull request and push to `main`. This check packs the package, installs it into isolated runtime-only and tooling consumers, verifies that optional compiler peers are not installed for runtime consumers, and verifies the dependency-install diagnostics. It is kept as a blocking CI gate because it catches package-manager behavior that manifest-only tests cannot cover and completes quickly enough to run on every change.

Configure the same GitHub Actions Trusted Publisher (`t-k/tachyon-dom`, `release.yml`) for both `tachyon-dom` and `create-tachyon-dom`. The workflow grants `id-token: write` only to the publish job, so the two `npm publish` commands authenticate with GitHub OIDC instead of a long-lived npm token. It publishes `tachyon-dom` before the dependent `create-tachyon-dom` package, directly to the release dist-tag (`latest` for stable versions and `next` for prereleases). Because the repository and packages are public, npm automatically generates provenance for the OIDC publishes.

`0.2.0` is the current release. It supersedes the `0.2.0-rc.1` manifest, which was prepared and verified locally but never tagged or published; that candidate number was not consumed on the registry.

A prerelease version resolves to the `next` dist-tag and a stable version to `latest`, decided by `verifyReleaseIdentity()` from the version string alone. While a candidate is being prepared, keep its changelog heading marked Unreleased and replace Unreleased with the release date when approving publication. Do not publish a tag from a different SHA than the one verified by the shared workflow, and re-pack `release-artifacts/` from the tagged SHA rather than reusing tarballs left over from an earlier candidate.
