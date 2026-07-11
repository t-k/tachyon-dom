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

const decodeAcrossByteBoundaries = (bytes: Uint8Array, first: number, second: number): string => {
  const decoder = new TextDecoder();
  return (
    decoder.decode(bytes.slice(0, first), { stream: true }) +
    decoder.decode(bytes.slice(first, second), { stream: true }) +
    decoder.decode(bytes.slice(second), { stream: true }) +
    decoder.decode()
  );
};

describe("progressive stream trusted HTML contract", () => {
  it(`keeps ${budget} seeded attacker inputs in a text node`, async () => {
    let state = seed >>> 0;
    for (let index = 0; index < budget; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const value = `${fragments[state % fragments.length]}:${index}`;
      const escaped = trustedHtmlChunk(escapeToHtml(value));
      const firstSplit = state % (escaped.length + 1);
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const secondSplit = firstSplit + (state % (escaped.length - firstSplit + 1));
      const routes: RouteDefinition[] = [
        {
          path: "/search",
          loader: () => value,
          render: () => "",
          stream: async function* () {
            yield "<p>";
            yield escaped.slice(0, firstSplit);
            yield escaped.slice(firstSplit, secondSplit);
            yield escaped.slice(secondSplit);
            yield "</p>";
          },
        },
      ];
      const result = await renderRouteStream(routes, "https://example.test/search");
      if (!result.ok) throw new Error(result.error.message);
      const chunks: string[] = [];
      for await (const chunk of result.value.chunks) chunks.push(chunk);
      expect(chunks[0], `seed=${seed} case=${index}`).toBe("<p>");
      const html = chunks.join("");
      const bytes = new TextEncoder().encode(html);
      const firstByteSplit = state % (bytes.length + 1);
      const secondByteSplit = firstByteSplit + ((state >>> 8) % (bytes.length - firstByteSplit + 1));
      const decoded = decodeAcrossByteBoundaries(bytes, firstByteSplit, secondByteSplit);
      const parsed = elementsAndText(parseFragment(decoded) as Node);
      expect(parsed.elements, `seed=${seed} case=${index}`).toEqual(["p"]);
      expect(parsed.text, `seed=${seed} case=${index}`).toBe(parserNormalizedText(value));
    }
  });

  it("preserves early flush and propagates cancellation while using the safe helper path", async () => {
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    let cleanedUp = false;
    const routes: RouteDefinition[] = [
      {
        path: "/search",
        loader: () => `<script>alert(1)</script>`,
        render: () => "",
        stream: async function* ({ data }) {
          try {
            yield `<p>${trustedHtmlChunk(escapeToHtml(data))}`;
            await delayed;
            yield "</p>";
          } finally {
            cleanedUp = true;
          }
        },
      },
    ];
    const result = await renderRouteStream(routes, "https://example.test/search");
    if (!result.ok) throw new Error(result.error.message);
    const iterator = result.value.chunks[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: "<p>&lt;script&gt;alert(1)&lt;/script&gt;",
    });
    expect(cleanedUp).toBe(false);
    await iterator.return?.();
    expect(cleanedUp).toBe(true);
    release();
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
