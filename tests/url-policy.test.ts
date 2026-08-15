import { describe, expect, it } from "vitest";
import {
  decideUrlAttribute,
  sanitizeElementUrlAttributes,
  sanitizeMetaRefreshContent,
  sanitizeUrlAttributeValue,
  urlKindForAttribute,
  urlPurposeForAttribute,
} from "../src/url-policy";

describe("URL attribute policy", () => {
  it.each([
    ["object", "data", "subresource", "url"],
    ["video", "poster", "subresource", "url"],
    ["audio", "poster", "subresource", "url"],
    ["img", "srcset", "subresource", "srcset"],
    ["source", "srcset", "subresource", "srcset"],
    ["audio", "src", "subresource", "url"],
    ["embed", "src", "subresource", "url"],
    ["iframe", "src", "subresource", "url"],
    ["base", "href", "document-navigation", "url"],
    ["a", "href", "document-navigation", "url"],
    ["link", "href", "subresource", "url"],
    ["script", "src", "subresource", "url"],
    ["use", "xlink:href", "subresource", "url"],
    ["form", "action", "form-submission", "url"],
    ["button", "formaction", "form-submission", "url"],
  ])("maps %s[%s] to its canonical policy", (element, attribute, purpose, kind) => {
    expect(urlPurposeForAttribute(element as string, attribute as string)).toBe(purpose);
    expect(urlKindForAttribute(element as string, attribute as string)).toBe(kind);
  });

  it.each(["https://example.com/?q=100%", "https://example.com/a%zz", "/search?q=100%", "/search?q=%20", "/検索?q=値"])(
    "allows a safe URL containing percent or non-ASCII text: %s",
    (value) => {
      expect(decideUrlAttribute({ element: "a", attribute: "href", purpose: "document-navigation", value })).toEqual({
        ok: true,
        value,
      });
    },
  );

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "//evil.example/path",
    "java\tscript:alert(1)",
    "java%73cript:alert(1)",
    "/%5C%5Cevil.example/path",
  ])("rejects an unsafe or obfuscated URL: %s", (value) => {
    expect(decideUrlAttribute({ element: "a", attribute: "href", purpose: "document-navigation", value }).ok).toBe(
      false,
    );
  });

  it("validates every srcset candidate and descriptor", () => {
    expect(sanitizeUrlAttributeValue("img", "srcset", "/a.jpg 1x, https://cdn.example/b.jpg 2x")).toBe(
      "/a.jpg 1x, https://cdn.example/b.jpg 2x",
    );
    expect(sanitizeUrlAttributeValue("source", "srcset", "/a%2Cb.jpg 640w, /b.jpg 1280w")).toBe(
      "/a%2Cb.jpg 640w, /b.jpg 1280w",
    );
    for (const value of [
      "/safe.jpg 1x, javascript:alert(1) 2x",
      "data:image/png;base64,AAAA 1x",
      "/a.jpg 0x",
      "/a.jpg 1x 2x",
      "/a.jpg 1q",
      "/a.jpg 1x,",
    ]) {
      expect(() => sanitizeUrlAttributeValue("img", "srcset", value), value).toThrow("Unsafe URL for srcset");
    }
  });

  it("validates meta refresh as a whole-element policy", () => {
    expect(sanitizeMetaRefreshContent("0; url=/login")).toEqual({ ok: true, value: "0; url=/login" });
    expect(sanitizeMetaRefreshContent("5")).toEqual({ ok: true, value: "5" });
    expect(sanitizeMetaRefreshContent("0; URL=javascript:alert(1)").ok).toBe(false);
    expect(sanitizeMetaRefreshContent("0; url=/safe; url=//evil.example").ok).toBe(false);

    const safe = sanitizeElementUrlAttributes("meta", { "http-equiv": " Refresh ", content: "0;url=/safe" });
    const unsafe = sanitizeElementUrlAttributes("meta", {
      content: "0;url=javascript:alert(1)",
      "HTTP-EQUIV": "REFRESH",
    });
    expect(safe.ok && safe.value.content).toBe("0;url=/safe");
    expect(unsafe.ok).toBe(false);
  });

  it.each([
    ["object", "data", "javascript:alert(1)"],
    ["object", "data", "data:text/html,<script>alert(1)</script>"],
    ["video", "poster", "javascript:alert(1)"],
  ])("rejects dangerous %s[%s] values", (element, attribute, value) => {
    expect(() => sanitizeUrlAttributeValue(element, attribute, value)).toThrow(`Unsafe URL for ${attribute}`);
  });
});
