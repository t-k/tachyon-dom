// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  clearConditionalRegion,
  clientShapedNodes,
  conditionalEndMarker,
  conditionalRegionEnd,
  conditionalStartMarker,
  insertionRegionEnd,
  isInsertionEndMarker,
  isInsertionStartMarker,
  isPathInvisibleNode,
  logicalNodeAt,
  logicalNodeCount,
  logicalNodesBetween,
  outletEndMarker,
  outletStartMarker,
  removeConditionalRegion,
  slotEndMarker,
  slotStartMarker,
  templateNodeAt,
} from "../src/conditional-marker";

const region = (html: string): { parent: HTMLElement; start: Comment } => {
  const parent = document.createElement("div");
  parent.innerHTML = html;
  const start = parent.firstChild;
  if (!(start instanceof Comment)) throw new Error("Expected a start marker.");
  return { parent, start };
};

describe("conditional region markers", () => {
  it("finds the end marker of the region a start marker opens, past nested regions", () => {
    const { parent, start } = region(
      `${conditionalStartMarker}<p>a</p>${conditionalStartMarker}<em>b</em>${conditionalEndMarker}<p>c</p>${conditionalEndMarker}<p>after</p>`,
    );
    const end = conditionalRegionEnd(start);
    expect(end?.nextSibling).toBe(parent.lastChild);
    const nestedStart = parent.childNodes[2] as Comment;
    expect(conditionalRegionEnd(nestedStart)).toBe(parent.childNodes[4]);
  });

  it("returns no end for an anchor comment without one", () => {
    const { start } = region(`<!----><p>a</p>`);
    expect(conditionalRegionEnd(start)).toBeUndefined();
  });

  it("lists a region's nodes in client shape, collapsing nested regions to their start marker", () => {
    const { parent, start } = region(
      `${conditionalStartMarker}<!--tachyon-hydrate:x:start--><p>a</p><!--tachyon-hydrate:x:end-->${conditionalStartMarker}<em>b</em>${conditionalEndMarker}<p>c</p>${conditionalEndMarker}`,
    );
    const end = conditionalRegionEnd(start);
    const nodes = clientShapedNodes(start.nextSibling, end ?? null);
    expect(nodes.map((node) => node.nodeName)).toEqual(["P", "#comment", "P"]);
    expect(nodes[1]).toBe(parent.childNodes[4]);
  });

  it("treats end markers and hydration markers as invisible to paths, but not start markers", () => {
    const { parent } = region(`${conditionalStartMarker}${conditionalEndMarker}<!--tachyon-hydrate:x:start--><!---->`);
    const [start, end, hydrate, plain] = Array.from(parent.childNodes);
    expect(isPathInvisibleNode(start as Node)).toBe(false);
    expect(isPathInvisibleNode(end as Node)).toBe(true);
    expect(isPathInvisibleNode(hydrate as Node)).toBe(true);
    expect(isPathInvisibleNode(plain as Node)).toBe(false);
  });

  it("clears a region's content and can remove its end marker while keeping the start marker", () => {
    const { parent, start } = region(
      `${conditionalStartMarker}<p>a</p>${conditionalStartMarker}<em>b</em>${conditionalEndMarker}${conditionalEndMarker}<p>after</p>`,
    );
    clearConditionalRegion(start);
    expect(parent.innerHTML).toBe(`${conditionalStartMarker}${conditionalEndMarker}<p>after</p>`);
    removeConditionalRegion(start);
    expect(parent.innerHTML).toBe(`${conditionalStartMarker}<p>after</p>`);
    expect(parent.firstChild).toBe(start);
  });
});

describe("insertion markers", () => {
  const html = (inner: string): HTMLElement => {
    const parent = document.createElement("div");
    parent.innerHTML = inner;
    return parent;
  };

  it("recognises outlet and named slot markers, and nothing else", () => {
    const parent = html(
      `<!--tachyon-outlet--><!--/tachyon-outlet--><!--tachyon-slot:header--><!--/tachyon-slot:header--><!--tachyon-if--><!--note-->text<!--x:tachyon-slot:-->`,
    );
    const [outletStart, outletEnd, slotStart, slotEnd, ifStart, note, text, suffix] = Array.from(parent.childNodes);
    expect([outletStart, slotStart].map((node) => isInsertionStartMarker(node as Node))).toEqual([true, true]);
    expect([outletEnd, slotEnd].map((node) => isInsertionEndMarker(node as Node))).toEqual([true, true]);
    expect(
      [outletEnd, slotEnd, ifStart, note, text, suffix].map((node) => isInsertionStartMarker(node as Node)),
    ).toEqual([false, false, false, false, false, false]);
    expect([outletStart, slotStart, ifStart, note, text].map((node) => isInsertionEndMarker(node as Node))).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(isPathInvisibleNode(outletEnd as Node)).toBe(true);
    expect(isPathInvisibleNode(slotEnd as Node)).toBe(true);
    expect(isPathInvisibleNode(outletStart as Node)).toBe(false);
    expect(outletStartMarker + outletEndMarker + slotStartMarker("h") + slotEndMarker("h")).toBe(
      `<!--tachyon-outlet--><!--/tachyon-outlet--><!--tachyon-slot:h--><!--/tachyon-slot:h-->`,
    );
  });

  it("finds the end marker of an insertion past a nested insertion", () => {
    const parent = html(
      `<!--tachyon-slot:a--><b>x</b><!--tachyon-slot:a--><i>y</i><!--/tachyon-slot:a--><u>z</u><!--/tachyon-slot:a--><p>after</p>`,
    );
    const end = insertionRegionEnd(parent.firstChild as Comment);
    expect(end?.nodeValue).toBe("/tachyon-slot:a");
    expect(end?.nextSibling).toBe(parent.querySelector("p"));
    expect(insertionRegionEnd(html(`<!--tachyon-outlet--><b>x</b>`).firstChild as Comment)).toBeUndefined();
  });

  it("treats an insertion as one logical node in every node view", () => {
    const parent = html(
      `<!--tachyon-slot:a--><b>x</b><i>y</i><!--/tachyon-slot:a--><!--tachyon-outlet--><!--/tachyon-outlet--><p>after</p>`,
    );
    const names = (nodes: Node[]): string[] => nodes.map((node) => node.nodeValue ?? node.nodeName);
    expect(names(clientShapedNodes(parent.firstChild, null))).toEqual(["tachyon-slot:a", "tachyon-outlet", "P"]);
    expect(names(logicalNodesBetween(parent.firstChild, null))).toEqual(["tachyon-slot:a", "tachyon-outlet", "P"]);
    expect(templateNodeAt(parent, [2])).toBe(parent.querySelector("p"));
    expect(templateNodeAt(parent, [0])).toBe(parent.firstChild);
    expect(templateNodeAt(parent, [2, 0])).toBe(parent.querySelector("p")?.firstChild);
  });

  it.each(["tachyon-if", "tachyon-outlet"])("returns a selected %s anchor before finding its end", (marker) => {
    const { parent, start } = region(`<!--${marker}--><span></span><!--/${marker}--><p></p>`);
    const nextSibling = Object.getOwnPropertyDescriptor(Node.prototype, "nextSibling")?.get;
    if (!nextSibling) throw new Error("Expected a DOM nextSibling accessor.");
    let reads = 0;
    Object.defineProperty(start, "nextSibling", {
      get: () => {
        reads++;
        return nextSibling.call(start);
      },
    });
    expect(templateNodeAt(parent, [0])).toBe(start);
    expect(reads).toBe(0);
    expect(templateNodeAt(parent, [1])).toBe(parent.querySelector("p"));
  });

  it("leaves visible siblings after a hydration marker before an unmatched list end", () => {
    const parent = html("<!--tachyon-hydrate:id:start--><p></p><!--/tachyon-for--><i></i>");
    const visible = [parent.querySelector("p"), parent.querySelector("i")];
    expect(logicalNodesBetween(parent.firstChild, null)).toEqual(visible);
    expect(clientShapedNodes(parent.firstChild, null)).toEqual(visible);
    expect(templateNodeAt(parent, [0])).toBe(visible[0]);
    expect(templateNodeAt(parent, [1])).toBe(visible[1]);
  });

  it("stops a node view at the given end even inside an insertion", () => {
    const parent = html(`<!--tachyon-slot:a--><b>x</b><i>y</i><!--/tachyon-slot:a-->`);
    const inner = parent.childNodes[2] as Node;
    expect(clientShapedNodes(parent.firstChild, inner)).toEqual([parent.firstChild]);
    expect(logicalNodesBetween(parent.firstChild, inner)).toEqual([parent.firstChild]);
  });
});

describe("logical node aggregation", () => {
  it.each([
    ["list", "matching-marker", "visible", 1],
    ["insertion", "end", "visible", 1],
    ["conditional", "none", "invisible", 2],
    ["conditional", "end", "visible", 2],
    ["list", "end", "invisible", 0],
    ["insertion", "none", "invisible", 2],
    ["insertion", "matching-marker", "invisible", 1],
    ["conditional", "matching-marker", "invisible", 1],
    ["list", "none", "visible", 1],
  ] as const)("counts the logical %s siblings with %s and %s content", (kind, boundary, content, expected) => {
    const marker = { list: "tachyon-for", insertion: "tachyon-outlet", conditional: "tachyon-if" }[kind];
    const inner = content === "visible" ? "<span></span>" : "<!--tachyon-hydrate:inner:start-->";
    const { parent } = region(`<!--${marker}-->${inner}<!--/${marker}--><i></i>`);
    const first = parent.firstChild;
    const end = boundary === "none" ? null : parent.childNodes[boundary === "end" ? 3 : 2]!;
    expect(logicalNodesBetween(first, end)).toHaveLength(expected);
    expect(logicalNodeCount(first, end)).toBe(expected);
    expect(logicalNodeAt(first, end, 0) !== undefined).toBe(expected > 0);
  });
});
