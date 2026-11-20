import * as parse5 from "parse5";
import { expect, it, vi } from "vitest";
import { normalizeHtmlTagWhitespace } from "../src/html-whitespace";

vi.mock("parse5", async (importOriginal) => {
  const original = await importOriginal<typeof parse5>();
  return { ...original, parse: vi.fn(original.parse), parseFragment: vi.fn(original.parseFragment) };
});

it.each([
  ["none", "tag", "fragment"],
  ["none", "text", "document"],
  ["adjacent", "tag", "fragment"],
  ["before-close", "tag", "document"],
  ["control", "tag", "document"],
  ["adjacent", "text", "document"],
  ["before-close", "text", "fragment"],
  ["adjacent", "quote", "fragment"],
  ["control", "quote", "document"],
  ["before-close", "quote", "fragment"],
  ["none", "quote", "fragment"],
  ["control", "text", "fragment"],
] as const)("normalizes %s whitespace in %s of a %s", (probe, location, root) => {
  const changes = probe === "control" ? ["\t", "\n", "\f", "\r"] : [{
    none: " ",
    adjacent: "  ",
    "before-close": " >",
  }[probe]];
  for (const whitespace of changes) {
    vi.clearAllMocks();
    const wrap = (content: string) =>
      root === "document" ? `<!doctype html><html><head></head><body>${content}</body></html>` : content;
    const tag = (space: string) =>
      probe === "before-close" ? `<main id="x"${space}` : `<main id="x"${space}title="y">`;
    const content = (space: string) => {
      if (location === "tag") return `${tag(space)}ok</main>`;
      if (location === "quote") return `<main title="x${space}y">ok</main>`;
      return `<main>x${space}y</main>`;
    };
    const source = wrap(content(whitespace));
    const expected = location === "tag" ? wrap(content(probe === "before-close" ? ">" : " ")) : source;
    expect(normalizeHtmlTagWhitespace(source)).toBe(expected);
    expect(root === "document" ? parse5.parse : parse5.parseFragment).toHaveBeenCalledTimes(probe === "none" ? 0 : 1);
  }
});
