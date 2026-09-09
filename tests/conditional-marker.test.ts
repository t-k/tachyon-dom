// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  clearConditionalRegion,
  clientShapedNodes,
  conditionalEndMarker,
  conditionalRegionEnd,
  conditionalStartMarker,
  isPathInvisibleNode,
  removeConditionalRegion,
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
