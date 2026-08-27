import fc from "fast-check";
import { parseFragment, serialize } from "parse5";
import { describe, expect, it } from "vitest";

import { normalizeHtmlTagWhitespace } from "../src/html-whitespace";
import { propertyParameters } from "./fast-check-config";

const htmlSpace = fc.string({
  unit: fc.constantFrom(" ", "\t", "\n", "\f", "\r"),
  minLength: 1,
  maxLength: 8,
});
const doubleQuotedAttributeText = fc
  .array(fc.constantFrom("a", "b", "c", " ", "\t", "雪", "'", ">", "=", "&", "&amp;", "&#39;"), {
    maxLength: 24,
  })
  .map((parts) => parts.join(""));
const singleQuotedAttributeText = fc
  .array(fc.constantFrom("a", "b", "c", " ", "\t", "雪", '"', ">", "=", "&", "&amp;", "&quot;"), {
    maxLength: 24,
  })
  .map((parts) => parts.join(""));
const bodyText = fc.string({ unit: fc.constantFrom("a", "b", "c", " ", "雪"), maxLength: 32 });

describe("HTML tag whitespace properties", () => {
  it("is idempotent and preserves parsed semantics", () => {
    fc.assert(
      fc.property(
        htmlSpace,
        htmlSpace,
        htmlSpace,
        doubleQuotedAttributeText,
        singleQuotedAttributeText,
        bodyText,
        (first, second, last, title, data, text) => {
          const source = `<div${first}title="${title}"${second}data-value='${data}'${last}>${text}</div>`;
          const output = normalizeHtmlTagWhitespace(source);
          expect(normalizeHtmlTagWhitespace(output)).toBe(output);
          expect(serialize(parseFragment(output))).toBe(serialize(parseFragment(source)));
          expect(output).toContain(`title="${title}"`);
          expect(output).toContain(`data-value='${data}'`);
          expect(output).toContain(`>${text}</div>`);
        },
      ),
      propertyParameters(),
    );
  });

  it("preserves generated unterminated quoted tags", () => {
    fc.assert(
      fc.property(htmlSpace, doubleQuotedAttributeText, (space, value) => {
        const source = `<div${space}title="${value}>`;
        expect(normalizeHtmlTagWhitespace(source)).toBe(source);
      }),
      propertyParameters(),
    );
  });
});
