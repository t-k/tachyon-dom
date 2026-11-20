import { describe, expect, it } from "vitest";
import { logicalNodeAt, logicalNodesBetween } from "../src/conditional-marker.js";
import { nodeAt } from "../src/runtime/conditional.js";
import { mountConditionalCore, preparedNodeAt } from "../src/runtime/conditional-core.js";
import { nodeAtWithDynamicLists } from "../src/runtime/list-path.js";

const container = (html: string): HTMLDivElement => {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
};

describe("logical sibling lookup", () => {
  it.each([
    ["list", "plain", "none", "first"],
    ["list", "nested", "end", "later"],
    ["insertion", "nested", "inner", "first"],
    ["insertion", "unclosed", "none", "later"],
    ["conditional", "nested", "none", "later"],
    ["conditional", "plain", "inner", "later"],
    ["insertion", "plain", "end", "missing"],
    ["conditional", "unclosed", "none", "missing"],
    ["conditional", "nested", "end", "first"],
    ["list", "unclosed", "inner", "first"],
    ["list", "nested", "inner", "missing"],
  ] as const)("matches the logical list for a %s region (%s, %s, %s)", (region, shape, bound, position) => {
    const marker = { list: "tachyon-for", insertion: "tachyon-slot:example", conditional: "tachyon-if" }[region];
    const start = `<!--${marker}-->`;
    const end = `<!--/${marker}-->`;
    const nest = shape === "nested" ? `${start}<em></em>${end}` : "";
    const root = container(`<!--tachyon-hydrate:test:start-->${start}<span id="inner"></span>${nest}${shape === "unclosed" ? "" : end}<p></p>`);
    const stop = bound === "inner" ? root.querySelector("#inner") : bound === "end" ? root.lastChild!.previousSibling : null;
    const expected = logicalNodesBetween(root.firstChild, stop);
    const index = { first: 0, later: 1, missing: expected.length }[position];
    expect(logicalNodeAt(root.firstChild, stop, index)).toBe(expected[index]);
  });

  it("counts a live conditional branch and skips list rows and inserted content", () => {
    const root = container(
      "<!--tachyon-if--><span></span><!--/tachyon-if--><!--tachyon-for--><b></b><!--/tachyon-for-->" +
        "<!--tachyon-outlet--><i></i><!--/tachyon-outlet--><p></p>",
    );
    expect(logicalNodeAt(root.firstChild, null, 0)).toBe(root.firstChild);
    expect(logicalNodeAt(root.firstChild, null, 1)).toBe(root.querySelector("span"));
    expect(logicalNodeAt(root.firstChild, null, 2)).toBe(root.childNodes[6]);
    expect(logicalNodeAt(root.firstChild, null, 3)).toBe(root.querySelector("p"));
    expect(logicalNodeAt(root.firstChild, null, 4)).toBeUndefined();
  });

  it("never returns a visible boundary or its following siblings", () => {
    const root = container("<p></p><span></span><b></b>");
    expect(logicalNodeAt(root.firstChild, root.querySelector("span"), 1)).toBeUndefined();
  });

  it.each([
    ["tachyon-for", 0],
    ["tachyon-outlet", 1],
  ] as const)("counts the inner node when the %s closing marker is the boundary", (marker, index) => {
    const root = container(`<!--${marker}--><span></span><!--/${marker}--><b></b>`);
    const bound = root.childNodes[2] as Node;
    expect(logicalNodeAt(root.firstChild, bound, index)).toBe(root.querySelector("span"));
    expect(logicalNodeAt(root.firstChild, bound, index + 1)).toBeUndefined();
  });

  it("keeps a normal sibling in front of an unmatched insertion end", () => {
    const root = container("<p></p><span></span><!--/tachyon-outlet--><b></b>");
    expect(logicalNodeAt(root.firstChild, null, 1)).toBe(root.querySelector("span"));
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("returns no node for an invalid numeric index (%s)", (index) => {
    const root = container("<p></p><i></i>");
    expect(logicalNodeAt(root.firstChild, null, index)).toBeUndefined();
    expect(() => nodeAtWithDynamicLists(root, [index], [])).toThrow(TypeError);
    expect(() => preparedNodeAt(root, [index])).toThrow(TypeError);
  });

  it("treats sparse public paths as missing nodes", () => {
    const root = container("<p></p><i></i>");
    const sparse: number[] = [];
    sparse.length = 1;
    expect(nodeAt(root, sparse)).toBeUndefined();
    expect(() => nodeAtWithDynamicLists(root, sparse, [])).toThrow(TypeError);
    expect(() => preparedNodeAt(root, sparse)).toThrow(TypeError);
  });

  it("targets later roots of a mounted conditional for both text and element bindings", () => {
    const root = container("<!--tachyon-if--><!--/tachyon-if-->");
    mountConditionalCore(root, [0], true, { label: "updated", active: true }, {
      templateHtml: "<b>first</b><span>second</span>",
      bindings: [
        { kind: "text", path: [1, 0], expression: "label" },
        { kind: "class", path: [1], className: "active", expression: "active" },
      ],
    });
    expect(root.querySelector("b")?.textContent).toBe("first");
    expect(root.querySelector("span")?.outerHTML).toBe('<span class="active">updated</span>');
  });

  it("stops the public lookup without reading siblings after the requested node", () => {
    const root = container("<p><span></span><i></i></p><b></b>");
    const from = Object.getOwnPropertyDescriptor(Node.prototype, "nextSibling")?.get;
    if (!from || !root.firstChild?.firstChild) throw new Error("Expected a DOM nextSibling accessor and target.");
    let reads = 0;
    for (const node of [root.firstChild, root.firstChild.firstChild]) {
      Object.defineProperty(node, "nextSibling", {
        get: () => {
          reads++;
          return from.call(node);
        },
      });
    }
    const target = root.querySelector("span");
    expect(nodeAtWithDynamicLists(root, [0, 0], [])).toBe(target);
    expect(preparedNodeAt(root, [0, 0])).toBe(target);
    expect(reads).toBe(0);
  });
});
