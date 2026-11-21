import { describe, expect, it, vi } from "vitest";
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

describe("TypeScript compiler API selection", () => {
  const legacy = { createSourceFile: () => undefined };
  const compatibility = { createSourceFile: () => undefined };

  it.each([
    { installed: legacy, expected: legacy, requests: ["typescript"] },
    { installed: { version: "7.0.2" }, expected: compatibility, requests: ["typescript", "@typescript/typescript6"] },
    { installed: undefined, expected: compatibility, requests: ["typescript", "@typescript/typescript6"] },
  ])("selects an available JavaScript compiler API ($requests)", async ({ installed, expected, requests }) => {
    vi.resetModules();
    const { requireTypeScriptApi } = await import("../src/optional-peer");
    const require = vi.fn((specifier: string) => {
      if (specifier === "@typescript/typescript6") return compatibility;
      if (specifier === "typescript" && installed) return installed;
      throw new Error("Module not found");
    });
    const builtin = vi.spyOn(process, "getBuiltinModule").mockReturnValue({ createRequire: () => require });
    try {
      expect(requireTypeScriptApi("Compiler")).toBe(expected);
      expect(requireTypeScriptApi("Code preview")).toBe(expected);
      expect(require.mock.calls.flat()).toEqual(requests);
    } finally {
      builtin.mockRestore();
    }
  });
});
