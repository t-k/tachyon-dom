# Release Packages Design

## Problem

The public README recommends `npm create tachyon-dom`, but the tag-triggered release workflow publishes only the root `tachyon-dom` package. The separate `create-tachyon-dom` package also excludes the MIT license text from its tarball, and the workflow does not prove that the pushed `v*` tag matches either package version. A release can therefore omit the documented initializer, distribute an incomplete package, or publish an unintended version.

## Release Contract

A `vX.Y.Z` tag is authoritative only when all of the following values equal `X.Y.Z`:

- The root `tachyon-dom` package version.
- The `create-tachyon-dom` package version.
- The exact version requested by `create-tachyon-dom` for its `tachyon-dom` dependency.

The verifier rejects malformed tags, prerelease tags unless the package versions contain the same prerelease identifier, build metadata, missing package metadata, and version ranges that are not an exact release-to-release binding. Stable versions publish with the npm `latest` dist-tag. Prerelease versions publish with the fixed npm `next` dist-tag so they cannot replace `latest`; release-controlled tag text is never reused as an npm dist-tag. Validation runs before either publish command.

## Package Contents

The `create-tachyon-dom` tarball must contain its executable entry, README, package metadata, and the repository MIT `LICENSE` text. The package build copies the root license into the package directory before packing. Package verification inspects the actual dry-run tarball manifest rather than relying only on the `files` declaration.

## Workflow

The release job performs installation, build, tests and existing package checks, then runs the release-contract verifier with `GITHUB_REF_NAME`. A fixed `NPM_TAG` environment value maps stable tags to `latest` and prerelease tags to `next`. It performs `npm publish --dry-run` for both package directories before any external mutation. Once all checks pass, it publishes the root package first and `packages/create-tachyon-dom` second, both with provenance, public access, and the fixed dist-tag.

Publishing the root package first ensures the initializer's exact dependency exists when the initializer becomes installable. A failure between publishes is visible and retryable; npm's immutability means the workflow must not silently rewrite versions or continue after an error.

## Verification Design

Tests use temporary real package files and real `npm pack --json --dry-run` output. Coverage includes:

- Matching stable and prerelease tags.
- Tag/root version mismatch.
- Root/create version mismatch.
- Non-exact or mismatched initializer dependency.
- Malformed tags and build metadata.
- Actual initializer tarball contents, including byte-equal MIT license text.
- Workflow ordering: validation and both dry runs precede root publish, and root publish precedes initializer publish.

The release verifier is a local script with no GitHub API dependency, so CI and maintainers can run the same checks. No registry publish is performed by tests.

## Security Boundary

The workflow keeps the existing minimal `contents: read` and `id-token: write` permissions. Version and artifact validation is fail closed and happens before registry writes. Publish commands use fixed repository directories and do not derive shell commands or filesystem paths from the tag value. The npm token remains scoped to publish steps through the existing environment mechanism.
