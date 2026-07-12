# Releasing

Releases are published from GitHub Actions, not from a local workstation.

1. Update `package.json` to the intended version.
2. Run `pnpm build`, `pnpm verify:package`, `pnpm check:exports`, `pnpm check:size`, and `pnpm test`.
3. Commit the version change.
4. Push a version tag that starts with `v`, for example `v0.1.1`.

The `Release` workflow installs with the lockfile, builds the package, verifies packaged files, runs `publint`, runs `attw --pack --no-emoji`, checks the per-subpath size budgets, and publishes with npm Trusted Publishing:

```sh
npm publish --access public
```

Configure the same GitHub Actions Trusted Publisher (`t-k/tachyon-dom`, `release.yml`) for both `tachyon-dom` and `create-tachyon-dom`. The workflow grants `id-token: write` only to the publish job, so the two `npm publish` commands authenticate with GitHub OIDC instead of a long-lived npm token. Because the repository and packages are public, npm automatically generates provenance for the OIDC publishes. The `NPM_TOKEN` repository secret remains required for the final `npm dist-tag` operations because npm Trusted Publishing currently covers package publication, not those tag mutations.
