import fc from "fast-check";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { describe, expect, it } from "vitest";

import { escapeHtml } from "../src/html-escape";
import { propertyParameters } from "./fast-check-config";

type Node = DefaultTreeAdapterMap["node"] & {
  childNodes?: Node[];
  nodeName?: string;
  value?: string;
};

const elementsAndText = (node: Node): { elements: string[]; text: string } => {
  const elements: string[] = [];
  let text = "";
  const visit = (current: Node): void => {
    if (current.nodeName === "#text") text += current.value ?? "";
    else if (current.nodeName && !current.nodeName.startsWith("#")) elements.push(current.nodeName);
    for (const child of current.childNodes ?? []) visit(child);
  };
  visit(node);
  return { elements, text };
};

describe("HTML escaping properties", () => {
  it("keeps arbitrary printable Unicode inside one text node", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 64 }), (value) => {
        const parsed = elementsAndText(parseFragment(`<p>${escapeHtml(value)}</p>`) as Node);
        expect(parsed.elements).toEqual(["p"]);
        expect(parsed.text).toBe(value);
      }),
      propertyParameters({ numRuns: 256 }),
    );
  });

  it("returns text without escapable characters unchanged", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 64 }), (value) => {
        if (!/[&<>"']/.test(value)) expect(escapeHtml(value)).toBe(value);
      }),
      propertyParameters(),
    );
  });

  it("escapes every non-empty sequence made only of HTML metacharacters", () => {
    const metacharacters = fc.string({
      unit: fc.constantFrom("&", "<", ">", '"', "'"),
      minLength: 1,
      maxLength: 64,
    });
    fc.assert(
      fc.property(metacharacters, (value) => {
        const output = escapeHtml(value);
        expect(output).toBe(
          [...value]
            .map((character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character])
            .join(""),
        );
        expect(elementsAndText(parseFragment(`<p>${output}</p>`) as Node)).toEqual({ elements: ["p"], text: value });
      }),
      propertyParameters(),
    );
  });
});
