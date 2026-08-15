import { describe, expect, it } from "vitest";
import { generatedUrlAttributeHelperLines } from "../src/compiler/url-policy-codegen";
import { sanitizeUrlAttributeValue } from "../src/url-policy";

const loadGeneratedHelper = async (): Promise<(element: string, attribute: string, value: string) => string> => {
  const code = `${generatedUrlAttributeHelperLines.join("\n")}\nexport { __tachyonSafeUrlAttribute };`;
  const module = (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as {
    __tachyonSafeUrlAttribute: (element: string, attribute: string, value: string) => string;
  };
  return module.__tachyonSafeUrlAttribute;
};

const outcome = (run: () => string): { ok: true; value: string } | { ok: false; message: string } => {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
};

describe("generated URL policy", () => {
  it("uses explicit standalone source instead of Function source serialization", () => {
    const source = generatedUrlAttributeHelperLines.join("\n");

    expect(source).not.toContain(".toString()");
    expect(source).not.toContain("Function.prototype.toString");
    expect(source).toContain("__tachyonUrlAttributeRules");
  });

  it("matches the source policy over the shared URL corpus", async () => {
    const generated = await loadGeneratedHelper();
    const corpus = [
      ["a", "href", "/safe"],
      ["a", "href", "https://example.com/?q=100%"],
      ["a", "href", "https://example.com/a%zz"],
      ["a", "href", "javascript:alert(1)"],
      ["a", "href", "java%73cript:alert(1)"],
      ["a", "href", "//evil.example/path"],
      ["object", "data", "data:text/html,<script>alert(1)</script>"],
      ["video", "poster", "/poster.jpg"],
      ["img", "srcset", "/a.jpg 1x, /b.jpg 2x"],
      ["img", "srcset", "/a.jpg 1x, javascript:alert(1) 2x"],
      ["source", "srcset", "/a%2Cb.jpg 640w, /b.jpg 1280w"],
    ] as const;

    for (const [element, attribute, value] of corpus) {
      expect(
        outcome(() => generated(element, attribute, value)),
        `${element}[${attribute}]=${value}`,
      ).toEqual(outcome(() => sanitizeUrlAttributeValue(element, attribute, value)));
    }
  });
});
