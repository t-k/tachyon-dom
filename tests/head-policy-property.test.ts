import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { sanitizeHeadAttributes } from "../src/head-policy";
import { propertyParameters } from "./fast-check-config";

const firstNameCharacter = fc.constantFrom(...Array.from("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_:"));
const remainingNameCharacter = fc.constantFrom(
  ...Array.from("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.:-"),
);
const validName = fc
  .tuple(firstNameCharacter, fc.array(remainingNameCharacter, { maxLength: 12 }))
  .map(([first, remaining]) => `${first}${remaining.join("")}`);
const malformedBoundaryName = fc.oneof(
  fc.tuple(fc.constantFrom("0", " ", "/", "="), validName).map(([prefix, name]) => `${prefix}${name}`),
  fc.tuple(validName, fc.constantFrom(" ", "/", "=", '"')).map(([name, suffix]) => `${name}${suffix}`),
);
const eventHandlerName = fc
  .tuple(fc.constantFrom("o", "O"), fc.constantFrom("n", "N"), validName)
  .map(([o, n, suffix]) => `${o}${n}${suffix}`);
const caseFoldedName = fc
  .tuple(
    fc.constantFrom(...Array.from("abcdefghijklmnpqrstuvwxyz")),
    fc.array(fc.constantFrom(...Array.from("abcdefghijklmnopqrstuvwxyz")), { maxLength: 11 }),
  )
  .map(([first, remaining]) => `${first}${remaining.join("")}`);

describe("head attribute policy properties", () => {
  it("rejects invalid name boundaries while retaining a valid sentinel", () => {
    expect(
      sanitizeHeadAttributes("meta", {
        "1data-id": "leading",
        "data-id ": "trailing",
        "data-safe": "kept",
      }),
    ).toEqual({ "data-safe": "kept" });
  });

  it("retains valid boundary characters", () => {
    expect(
      sanitizeHeadAttributes("meta", {
        _private: "underscore",
        ":namespace": "colon",
        "http-equiv": "hyphen",
      }),
    ).toEqual({ _private: "underscore", ":namespace": "colon", "http-equiv": "hyphen" });
  });

  it("keeps the first case-folded attribute and discards later duplicates", () => {
    expect(
      sanitizeHeadAttributes("meta", {
        "http-equiv": "not-refresh",
        "HTTP-EQUIV": "refresh",
        content: "0;url=javascript:alert(1)",
      }),
    ).toEqual({ "http-equiv": "not-refresh", content: "0;url=javascript:alert(1)" });
  });

  it("does not let a later duplicate rescue an unsafe first value", () => {
    expect(
      sanitizeHeadAttributes("meta", {
        "http-equiv": "refresh",
        CONTENT: "0;url=javascript:alert(1)",
        content: "0;url=/safe",
      }),
    ).toEqual({ "http-equiv": "refresh" });
  });

  it("rejects generated malformed boundaries and event-handler names", () => {
    fc.assert(
      fc.property(malformedBoundaryName, eventHandlerName, (malformedName, handlerName) => {
        expect(
          sanitizeHeadAttributes("meta", {
            [malformedName]: "blocked-boundary",
            [handlerName]: "blocked-handler",
            "data-safe": "kept",
          }),
        ).toEqual({ "data-safe": "kept" });
      }),
      propertyParameters({ numRuns: 64 }),
    );
  });

  it("returns at most one attribute for each ASCII case-folded name", () => {
    fc.assert(
      fc.property(caseFoldedName, (name) => {
        const result = sanitizeHeadAttributes("meta", {
          [name]: "first",
          [name.toUpperCase()]: "second",
          "data-safe": "kept",
        });
        expect(result).toEqual({ [name]: "first", "data-safe": "kept" });
        expect(new Set(Object.keys(result ?? {}).map((key) => key.toLowerCase())).size).toBe(
          Object.keys(result ?? {}).length,
        );
      }),
      propertyParameters({ numRuns: 64 }),
    );
  });
});
