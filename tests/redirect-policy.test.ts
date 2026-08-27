import { describe, expect, it } from "vitest";
import { redirect } from "../src/router";
import { redirectResponse } from "../src/server/form-action";
import { validateRedirectTarget } from "../src/redirect-policy";

const cases: readonly {
  location: string;
  options: { allowExternal?: boolean; allowedOrigins?: readonly string[] };
  allowed: boolean;
}[] = [
  { location: "/dashboard", options: {}, allowed: true },
  { location: "/dashboard?next=%2Fsettings", options: {}, allowed: true },
  { location: "/safe//", options: {}, allowed: true },
  { location: "//evil.example/path", options: {}, allowed: false },
  { location: "/%2f%2fevil.example/path", options: {}, allowed: false },
  { location: "/%5C%5Cevil.example/path", options: {}, allowed: false },
  { location: "/\t/evil.example/path", options: {}, allowed: false },
  { location: "https://accounts.example/callback", options: { allowExternal: true }, allowed: false },
  {
    location: "https://accounts.example/callback",
    options: { allowExternal: true, allowedOrigins: [] },
    allowed: false,
  },
  {
    location: "https://evil.example/path",
    options: { allowExternal: true, allowedOrigins: ["https://accounts.example"] },
    allowed: false,
  },
  {
    location: "https://accounts.example/callback",
    options: { allowExternal: true, allowedOrigins: ["https://accounts.example"] },
    allowed: true,
  },
  {
    location: "http://accounts.example/callback",
    options: { allowExternal: true, allowedOrigins: ["http://accounts.example"] },
    allowed: true,
  },
  {
    location: "ftp://accounts.example/file",
    options: { allowExternal: true, allowedOrigins: ["ftp://accounts.example"] },
    allowed: false,
  },
  {
    location: "https://[",
    options: { allowExternal: true, allowedOrigins: ["https://accounts.example"] },
    allowed: false,
  },
  {
    location: "javascript:alert(1)",
    options: { allowExternal: true, allowedOrigins: ["https://accounts.example"] },
    allowed: false,
  },
];

describe("shared redirect policy", () => {
  it.each(cases)("case %# returns $allowed for $location on every redirect path", ({ location, options, allowed }) => {
    const decision = validateRedirectTarget(location, options);
    const routeCall = (): unknown => redirect(location, options);
    const formCall = (): unknown => redirectResponse(location, options);

    expect(decision.ok).toBe(allowed);
    if (allowed) {
      expect(routeCall).not.toThrow();
      expect(formCall).not.toThrow();
    } else {
      expect(routeCall).toThrow("Unsafe redirect target.");
      expect(formCall).toThrow("Unsafe redirect target.");
    }
  });
});
