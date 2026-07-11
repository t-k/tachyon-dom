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

The `create-tachyon-dom` tarball must contain its executable entry, README, package metadata, and the repository MIT `LICENSE` text. The package build copies the root license into the package directory before packing. The verifier creates both real tarballs once, records each SHA-512 integrity in a release manifest, reads required files and package metadata from those tarballs, and compares the packed LICENSE bytes. Dry runs and publication consume those exact tarball paths rather than rebuilding mutable package directories.

## Workflow

An unprivileged verification job performs installation, build, tests and existing package checks, creates both release tarballs, verifies them, dry-runs those exact tarballs, and uploads them with their integrity manifest. A separate publication job has the OIDC permission and npm token, downloads the artifacts, reverifies their SHA-512 values and contents, then publishes the root tarball before the initializer tarball. All third-party Actions are pinned to full commit SHAs.

Publishing the root package first ensures the initializer's exact dependency exists when the initializer becomes installable. Before each publication, the publisher queries the registry. A missing version is published, an existing version with identical integrity is safely skipped while its fixed dist-tag is restored, and an existing version with different integrity fails closed. A retry after partial publication can therefore continue to the initializer without ignoring unrelated registry errors.

## Verification Design

Tests use temporary real package files, real `npm pack --json` tarballs, tar extraction to standard output, and exact-tarball npm publication dry runs. Coverage includes:

- Matching stable and prerelease tags.
- Tag/root version mismatch.
- Root/create version mismatch.
- Non-exact or mismatched initializer dependency.
- Malformed tags and build metadata.
- Actual initializer tarball contents, including byte-equal MIT license text.
- Source mutation after packing does not change the verified artifacts, while tarball mutation fails integrity validation.
- Registry retry decisions for missing, identical, and conflicting versions.
- Workflow ordering and privilege separation: validation and both dry runs precede artifact upload, the publication job reverifies after download, and root publish precedes initializer publish.

The release verifier is a local script with no GitHub API dependency, so CI and maintainers can run the same checks. No registry publish is performed by tests.

## Security Boundary

The workflow has no top-level permissions. The verification job has only `contents: read`; only the publication job receives `contents: read` and `id-token: write`, and the npm token is scoped to its two publication steps. Version, tarball content, and integrity validation fail closed before registry writes. The publisher uses argument arrays rather than a shell, selects only the fixed root/create manifest entries, and never derives commands, paths, or npm dist-tags from unvalidated tag text.
