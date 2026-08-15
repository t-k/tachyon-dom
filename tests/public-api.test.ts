import { describe, expect, it } from "vitest";
import { catchError, sanitizeUrlAttribute, untrack } from "../src/index";

describe("public API", () => {
  it("exports catchError from the main entry", () => {
    expect(catchError).toBeTypeOf("function");
  });

  it("exports untrack from the main entry", () => {
    expect(untrack).toBeTypeOf("function");
  });

  it("exports a contextual Result-returning URL policy", () => {
    expect(
      sanitizeUrlAttribute({
        element: "a",
        attribute: "href",
        purpose: "document-navigation",
        value: "/account",
      }),
    ).toEqual({ ok: true, value: "/account" });
    expect(
      sanitizeUrlAttribute({
        element: "a",
        attribute: "href",
        purpose: "document-navigation",
        value: "javascript:alert(1)",
      }).ok,
    ).toBe(false);
  });

  it("applies URL purpose and explicit origin policies without a context-free safety boolean", () => {
    expect(
      sanitizeUrlAttribute({
        element: "img",
        attribute: "src",
        purpose: "document-navigation",
        value: "/image.png",
      }).ok,
    ).toBe(false);
    expect(
      sanitizeUrlAttribute({
        element: "img",
        attribute: "src",
        purpose: "subresource",
        value: "https://assets.example/image.png",
        allowedOrigins: [],
      }).ok,
    ).toBe(false);
    expect(
      sanitizeUrlAttribute({
        element: "img",
        attribute: "src",
        purpose: "subresource",
        value: "https://assets.example/image.png",
        allowedOrigins: ["https://assets.example"],
      }),
    ).toEqual({ ok: true, value: "https://assets.example/image.png" });
    expect(
      sanitizeUrlAttribute({
        element: "a",
        attribute: "href",
        purpose: "document-navigation",
        value: "tel:+12025550123",
      }).ok,
    ).toBe(true);
  });
});
