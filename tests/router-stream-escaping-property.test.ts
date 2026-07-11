import { readFileSync } from "node:fs";
import path from "node:path";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { describe, expect, it } from "vitest";

import {
  escapeToHtml,
  renderRouteStream,
  trustedHtmlChunk,
  type RouteDefinition,
  type TrustedHtml,
} from "../src/router";

const seed = 0x5afe4004;
const budget = 256;
const fragments = [
  `<img src=x onerror=alert(1)>`,
  `</p><script>alert(1)</script>`,
  `&lt;svg onload=alert(1)&gt;`,
  `"'&<>`,
  `javascript:alert(1)`,
  `line\r\nnext`,
  `nul\0value`,
  `雪🙂`,
  `<a href=//evil.example>open</a>`,
] as const;

type Node = DefaultTreeAdapterMap["node"] & {
  nodeName?: string;
  value?: string;
  childNodes?: Node[];
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

// HTML parsing drops NUL and normalizes CR/CRLF in text nodes.
const parserNormalizedText = (value: string): string => value.replaceAll("\0", "").replace(/\r\n?/g, "\n");

describe("progressive stream trusted HTML contract", () => {
  it(`keeps ${budget} seeded attacker inputs in a text node`, async () => {
    let state = seed >>> 0;
    for (let index = 0; index < budget; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const value = `${fragments[state % fragments.length]}:${index}`;
      const routes: RouteDefinition[] = [
        {
          path: "/search",
          loader: () => value,
          render: () => "",
          stream: async function* ({ data }) {
            yield "<p>";
            yield trustedHtmlChunk(escapeToHtml(data));
            yield "</p>";
          },
        },
      ];
      const result = await renderRouteStream(routes, "https://example.test/search");
      if (!result.ok) throw new Error(result.error.message);
      const chunks: string[] = [];
      for await (const chunk of result.value.chunks) chunks.push(chunk);
      expect(chunks[0], `seed=${seed} case=${index}`).toBe("<p>");
      const parsed = elementsAndText(parseFragment(chunks.join("")) as Node);
      expect(parsed.elements, `seed=${seed} case=${index}`).toEqual(["p"]);
      expect(parsed.text, `seed=${seed} case=${index}`).toBe(parserNormalizedText(value));
    }
  });

  it("rejects forged TrustedHtml values", () => {
    const forged = { __tachyonTrustedHtml: true, value: "<img src=x onerror=alert(1)>" } as TrustedHtml;
    expect(() => trustedHtmlChunk(forged)).toThrow("must be created by tachyon-dom helpers");
  });

  it("keeps the raw sink contract adjacent to the API and in public docs", () => {
    const root = path.resolve(import.meta.dirname, "..");
    expect(readFileSync(path.join(root, "src/router.ts"), "utf8")).toContain(
      "adapters do not escape or sanitize chunks",
    );
    expect(readFileSync(path.join(root, "README.md"), "utf8")).toContain("trustedHtmlChunk(escapeToHtml");
    expect(readFileSync(path.join(root, "docs/routing.md"), "utf8")).toContain("trusted raw HTML");
  });
});
