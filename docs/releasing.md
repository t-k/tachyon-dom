# Releasing

Releases are published from GitHub Actions, not from a local workstation.

1. Update `package.json` to the intended version.
2. Run `pnpm build`, `pnpm verify:package`, `pnpm check:exports`, `pnpm check:size`, and `pnpm test`.
3. Commit the version change.
4. Push a version tag that starts with `v`, for example `v0.1.1`.

The `Release` workflow installs with the lockfile, builds the package, verifies packaged files, runs `publint`, runs `attw --pack --no-emoji`, checks the per-subpath size budgets, and publishes with:

```sh
npm publish --access public
```

The workflow requires an `NPM_TOKEN` repository secret with publish access for the package. Because this source repository is private, the workflow intentionally does not request npm provenance; npm rejects provenance bundles from private source repositories.
