import { describe, expect, it } from "vitest";
import { redirect } from "../src/router";
import { redirectResponse } from "../src/server/form-action";
import { validateRedirectTarget } from "../src/redirect-policy";

const cases = [
  { location: "/dashboard", allowedOrigins: undefined, allowed: true },
  { location: "/dashboard?next=%2Fsettings", allowedOrigins: undefined, allowed: true },
  { location: "//evil.example/path", allowedOrigins: undefined, allowed: false },
  { location: "/%2f%2fevil.example/path", allowedOrigins: undefined, allowed: false },
  { location: "/%5C%5Cevil.example/path", allowedOrigins: undefined, allowed: false },
  { location: "/\t/evil.example/path", allowedOrigins: undefined, allowed: false },
  { location: "https://evil.example/path", allowedOrigins: ["https://accounts.example"], allowed: false },
  {
    location: "https://accounts.example/callback",
    allowedOrigins: ["https://accounts.example"],
    allowed: true,
  },
  { location: "javascript:alert(1)", allowedOrigins: ["https://accounts.example"], allowed: false },
] as const;

describe("shared redirect policy", () => {
  it.each(cases)("returns $allowed for $location on every redirect path", ({ location, allowedOrigins, allowed }) => {
    const options = allowedOrigins ? { allowExternal: true, allowedOrigins } : {};
    const decision = validateRedirectTarget(location, options);
    const routeCall = (): unknown => redirect(location, options);
    const formCall = (): unknown => redirectResponse(location, options);

    expect(decision.ok).toBe(allowed);
    if (allowed) {
      expect(routeCall).not.toThrow();
      expect(formCall).not.toThrow();
    } else {
      expect(routeCall).toThrow(`Unsafe redirect target: ${location}`);
      expect(formCall).toThrow(`Unsafe redirect target: ${location}`);
    }
  });
});
