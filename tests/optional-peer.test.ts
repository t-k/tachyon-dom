import { describe, expect, it } from "vitest";
import { optionalPeerError, requireOptionalPeer } from "../src/optional-peer";

describe("optional peer diagnostics", () => {
  it("includes the feature, package name, and installation command", () => {
    const error = optionalPeerError("typescript", "Tachyon SFC compilation");

    expect(error.message).toBe(
      'Tachyon SFC compilation requires the optional peer dependency "typescript". Install it with "pnpm add typescript".',
    );
  });

  it("preserves the actionable diagnostic when module loading fails", () => {
    expect(() => requireOptionalPeer("missing-peer", "Test feature", "tachyon-dom-intentionally-missing-peer")).toThrow(
      'Test feature requires the optional peer dependency "missing-peer". Install it with "pnpm add missing-peer".',
    );
  });
});
