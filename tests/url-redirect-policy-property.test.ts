import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { validateRedirectTarget } from "../src/redirect-policy";
import { decideSrcset, decideUrlAttribute, urlKindForAttribute, urlPurposeForAttribute } from "../src/url-policy";
import { propertyParameters } from "./fast-check-config";

const ruleCases = [
  ["object", "data", "subresource", "url"],
  ["video", "poster", "subresource", "url"],
  ["img", "srcset", "subresource", "srcset"],
  ["a", "href", "document-navigation", "url"],
  ["link", "href", "subresource", "url"],
  ["form", "action", "form-submission", "url"],
] as const;

const mixedCase = (value: string, mask: readonly boolean[]): string =>
  Array.from(value, (character, index) => (mask[index % mask.length] ? character.toUpperCase() : character)).join("");

const segment = fc.string({
  unit: fc.constantFrom(...Array.from("abcdefghijklmnopqrstuvwxyz0123456789")),
  maxLength: 24,
});
const mask = fc.array(fc.boolean(), { minLength: 12, maxLength: 12 });
const hazard = fc
  .tuple(fc.constantFrom("//", "/\\", "/%5c", "/%5C", "/%00", "javascript:", "java%73cript:"), segment)
  .map(([prefix, suffix]) => `${prefix}${suffix}`);
const descriptor = fc.oneof(
  fc.integer({ min: 1, max: 4096 }).map((value) => `${value}w`),
  fc.integer({ min: 1, max: 40 }).map((value) => `${value / 10}x`),
);
const candidate = fc.tuple(segment, descriptor).map(([path, size]) => `/assets/${path || "x"}.png ${size}`);

describe("URL and redirect policy properties", () => {
  it("selects the same rule regardless of ASCII case", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ruleCases), mask, ([element, attribute, purpose, kind], caseMask) => {
        expect(urlPurposeForAttribute(mixedCase(element, caseMask), mixedCase(attribute, caseMask))).toBe(purpose);
        expect(urlKindForAttribute(mixedCase(element, caseMask), mixedCase(attribute, caseMask))).toBe(kind);
      }),
      propertyParameters(),
    );
  });

  it("rejects generated raw and decoded structural hazards", () => {
    fc.assert(
      fc.property(hazard, (value) => {
        expect(decideUrlAttribute({ element: "a", attribute: "href", purpose: "document-navigation", value }).ok).toBe(
          false,
        );
        expect(validateRedirectTarget(value).ok).toBe(false);
      }),
      propertyParameters({ numRuns: 256 }),
    );
  });

  it("keeps configured absolute origins authoritative", () => {
    fc.assert(
      fc.property(segment, (path) => {
        const allowed = `https://accounts.example/${path}`;
        const denied = `https://evil.example/${path}`;
        expect(
          decideUrlAttribute({
            element: "a",
            attribute: "href",
            purpose: "document-navigation",
            allowedOrigins: ["https://accounts.example"],
            value: allowed,
          }).ok,
        ).toBe(true);
        expect(
          decideUrlAttribute({
            element: "a",
            attribute: "href",
            purpose: "document-navigation",
            allowedOrigins: ["https://accounts.example"],
            value: denied,
          }).ok,
        ).toBe(false);
        expect(
          validateRedirectTarget(allowed, {
            allowExternal: true,
            allowedOrigins: ["https://accounts.example"],
          }).ok,
        ).toBe(true);
        expect(
          validateRedirectTarget(denied, {
            allowExternal: true,
            allowedOrigins: ["https://accounts.example"],
          }).ok,
        ).toBe(false);
      }),
      propertyParameters(),
    );
  });

  it("accepts generated local redirect paths", () => {
    fc.assert(
      fc.property(segment, (path) => {
        expect(validateRedirectTarget(`/${path}`).ok).toBe(true);
      }),
      propertyParameters(),
    );
  });

  it("accepts generated valid srcset candidates", () => {
    fc.assert(
      fc.property(fc.array(candidate, { minLength: 1, maxLength: 4 }), (candidates) => {
        const value = candidates.join(", ");
        expect(decideSrcset({ value })).toEqual({ ok: true, value });
      }),
      propertyParameters(),
    );
  });

  it("rejects a generated srcset containing one invalid candidate", () => {
    const invalid = fc.constantFrom("javascript:alert(1) 1x", "/asset.png 0x", "/asset.png 1q", "/asset.png 1x 2x");
    fc.assert(
      fc.property(fc.array(candidate, { maxLength: 3 }), invalid, fc.nat(), (safe, unsafe, offset) => {
        const insertion = offset % (safe.length + 1);
        const candidates = [...safe.slice(0, insertion), unsafe, ...safe.slice(insertion)];
        expect(decideSrcset({ value: candidates.join(", ") }).ok).toBe(false);
      }),
      propertyParameters(),
    );
  });
});
