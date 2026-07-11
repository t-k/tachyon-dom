import { describe, expect, it } from "vitest";

import { verifyReleaseIdentity } from "../scripts/release-contract.mjs";

const packages = (version = "1.2.3", dependency = version) => ({
  rootPackage: { name: "tachyon-dom", version },
  createPackage: {
    name: "create-tachyon-dom",
    version,
    dependencies: { "tachyon-dom": dependency },
  },
});

describe("npm release identity", () => {
  it.each([
    ["v1.2.3", "1.2.3", "latest"],
    ["v1.2.3-beta.1", "1.2.3-beta.1", "next"],
  ])("accepts matching release identity %s", (tag, version, npmTag) => {
    expect(verifyReleaseIdentity({ tag, ...packages(version) })).toEqual({ ok: true, version, npmTag });
  });

  it.each([
    ["malformed tag", "1.2.3", "1.2.3", "1.2.3", /tag must be v/],
    ["build metadata", "v1.2.3+build.1", "1.2.3+build.1", "1.2.3+build.1", /tag must be v/],
    ["tag and root mismatch", "v1.2.4", "1.2.3", "1.2.3", /root package version/],
    ["root and create mismatch", "v1.2.3", "1.2.3", "1.2.4", /create-tachyon-dom version/],
    ["dependency range", "v1.2.3", "1.2.3", "1.2.3", /dependency must equal/],
    ["dependency mismatch", "v1.2.3", "1.2.3", "1.2.3", /dependency must equal/],
  ])("rejects %s", (_label, tag, rootVersion, createVersion, expected) => {
    const fixture = packages(rootVersion);
    fixture.createPackage.version = createVersion;
    fixture.createPackage.dependencies["tachyon-dom"] =
      _label === "dependency range" ? `^${rootVersion}` : _label === "dependency mismatch" ? "1.2.2" : rootVersion;
    expect(verifyReleaseIdentity({ tag, ...fixture })).toEqual({ ok: false, error: expect.stringMatching(expected) });
  });
});
