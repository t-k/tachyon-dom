// @vitest-environment jsdom
// The self-contained path walkers in text, class, and event resolve template paths through server markers the
// same way: a list region and a region's content and end marker occupy no logical slot, while the start marker
// of a conditional or of a server-only insertion (<outlet>, <slot>) keeps one.
import { describe, expect, it } from "vitest";
import { elementAt } from "../src/runtime/class";
import { delegate } from "../src/runtime/event";
import { textAt } from "../src/runtime/text";

const rootFor = (html: string): Element => {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
};

const nodeAt = (root: Element, path: number[]): Node | undefined => {
  const seen: Node[] = [];
  delegate(root, "probe", path, (event) => seen.push(event.target as Node));
  const element = elementAt(root, path);
  element?.dispatchEvent(new Event("probe"));
  return seen[0] === element ? element : undefined;
};

describe("template path walkers", () => {
  it.each([
    ["a list region", `<!--tachyon-for--><li>r1</li><li>r2</li><!--/tachyon-for-->`, 0],
    ["a conditional region", `<!--tachyon-if--><b>x</b><!--/tachyon-if-->`, 1],
    ["an outlet insertion", `<!--tachyon-outlet--><b>x</b><i>y</i><!--/tachyon-outlet-->`, 1],
    ["a named slot insertion", `<!--tachyon-slot:header--><b>x</b><i>y</i><!--/tachyon-slot:header-->`, 1],
    ["an empty slot insertion", `<!--tachyon-slot:header--><!--/tachyon-slot:header-->`, 1],
    ["a hydration marker", `<!--tachyon-hydrate:td-h-1:start-->`, 0],
    [
      "a nested region of the same kind",
      `<!--tachyon-if--><!--tachyon-if--><b>x</b><!--/tachyon-if--><i>y</i><!--/tachyon-if-->`,
      1,
    ],
    [
      "a slot holding conditional and list markers",
      `<!--tachyon-slot:s--><!--tachyon-if--><b>x</b><!--/tachyon-if--><!--tachyon-for--><i>y</i><!--/tachyon-for--><!--/tachyon-slot:s-->`,
      1,
    ],
  ])("steps over %s before a bound sibling", (_label, prefix, offset) => {
    const root = rootFor(`<section>${prefix}<p>target</p></section>`);
    const target = root.querySelector("p") as HTMLParagraphElement;
    expect(textAt(root, [0, offset, 0])).toBe(target.firstChild);
    expect(elementAt(root, [0, offset])).toBe(target);
    expect(nodeAt(root, [0, offset])).toBe(target);
  });

  it("addresses a conditional's start marker by its own slot", () => {
    const root = rootFor(`<section><!--tachyon-if--><b>x</b><!--/tachyon-if--><p>t</p></section>`);
    expect(elementAt(root, [0, 0])).toBe(root.firstChild?.firstChild);
    expect(elementAt(root, [0, 1])).toBe(root.querySelector("p"));
  });

  it("does not treat a comment that merely starts with a slash-less marker text as a region", () => {
    const root = rootFor(`<section><!--note--><p>t</p></section>`);
    expect(elementAt(root, [0, 1])).toBe(root.querySelector("p"));
    expect(textAt(root, [0, 1, 0])).toBe(root.querySelector("p")?.firstChild);
  });

  it("reports a missing text node instead of resolving past an unterminated region", () => {
    const root = rootFor(`<section><!--tachyon-slot:s--><p>t</p></section>`);
    expect(() => textAt(root, [0, 1, 0])).toThrow(/Missing text binding node/);
    expect(delegate(root, "click", [0, 1], () => undefined)).toBeTypeOf("function");
  });
});
