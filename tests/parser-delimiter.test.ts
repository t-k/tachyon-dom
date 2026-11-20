import { expect, it, vi } from "vitest";
import { parseTemplate } from "../src/compiler/parser";

it.each([
  ["small", "double", "early"],
  ["boundary", "text", "late"],
  ["large", "single", "absent"],
  ["small", "single", "absent"],
  ["large", "double", "late"],
  ["large", "text", "early"],
  ["small", "text", "absent"],
  ["boundary", "double", "absent"],
  ["small", "single", "late"],
  ["boundary", "single", "early"],
] as const)("retains %s source spans for a %s delimiter with a %s match", (size, kind, match) => {
  const length = { small: 2047, boundary: 2048, large: 4096 }[size];
  const delimiter = { text: "<", single: "'", double: '"' }[kind];
  const opening = kind === "text" ? "<main>" : `<main title=${delimiter}`;
  const closing = match === "absent" ? "" : kind === "text" ? "</main>" : `${delimiter}></main>`;
  const valueLength = match === "early" ? 4 : length - opening.length - closing.length;
  const otherQuote = kind === "double" ? "'" : '"';
  const value = (`😀${otherQuote}x`.repeat(Math.ceil(valueLength / 4))).slice(0, valueLength);
  const source = (opening + value + closing).padEnd(length);
  const indexOf = vi.spyOn(String.prototype, "indexOf");
  let result: ReturnType<typeof parseTemplate>;
  let nativeFinds = 0;
  try {
    result = parseTemplate(source);
    nativeFinds = indexOf.mock.calls.filter(([needle, start]) => needle === delimiter && start === opening.length).length;
  } finally {
    indexOf.mockRestore();
  }
  if (match === "absent") {
    expect(result).toEqual({
      ok: false,
      error: {
        message: kind === "text" ? "Missing closing tag for <main>." : "Unclosed attribute value.",
        offset: source.length,
      },
    });
  } else {
    if (!result.ok) throw new Error(result.error.message);
    const valueEnd = opening.length + value.length;
    if (kind === "text") {
      expect(result.value.children[0]).toEqual({ type: "text", value, start: opening.length, end: valueEnd });
    } else {
      expect(result.value.attrs[0]).toMatchObject({ value, valueStart: opening.length - 1, valueEnd: valueEnd + 1 });
    }
  }
  expect(nativeFinds).toBe(size === "small" ? 0 : 1);
});
