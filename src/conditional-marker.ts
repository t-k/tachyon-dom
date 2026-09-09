/**
 * Comment markers that delimit an `<if>` region. The client template and the server renderers emit the same
 * pair, so the region's nodes are exactly the siblings between the two comments in either DOM: whitespace text
 * around the region can no longer merge with the branch, nested regions nest their own pairs, and hydration
 * adopts a server branch by walking from the start marker to its matching end marker.
 */
export const conditionalStartMarkerValue = "tachyon-if";
export const conditionalEndMarkerValue = "/tachyon-if";
export const conditionalStartMarker = `<!--${conditionalStartMarkerValue}-->`;
export const conditionalEndMarker = `<!--${conditionalEndMarkerValue}-->`;

export const isConditionalStartMarker = (node: Node): node is Comment =>
  node.nodeType === Node.COMMENT_NODE && node.nodeValue === conditionalStartMarkerValue;

export const isConditionalEndMarker = (node: Node): node is Comment =>
  node.nodeType === Node.COMMENT_NODE && node.nodeValue === conditionalEndMarkerValue;

/**
 * The end marker that closes the region `start` opens, skipping nested regions, or `undefined` when the
 * region has no end marker (a hand-built anchor comment without one).
 */
export const conditionalRegionEnd = (start: Comment): Comment | undefined => {
  let depth = 0;
  for (let node = start.nextSibling; node; node = node.nextSibling) {
    if (isConditionalStartMarker(node)) depth++;
    else if (isConditionalEndMarker(node)) {
      if (depth === 0) return node;
      depth--;
    }
  }
  return undefined;
};

/** Removes every node between a region's markers; the markers themselves stay. */
export const clearConditionalRegion = (start: Comment): void => {
  const end = conditionalRegionEnd(start);
  while (end && start.nextSibling && start.nextSibling !== end) start.nextSibling.remove();
};

/** Hydration markers and region end markers occupy no logical slot: paths count past them. */
export const isPathInvisibleNode = (node: Node): boolean =>
  node.nodeType === Node.COMMENT_NODE &&
  ((node.nodeValue ?? "").startsWith("tachyon-hydrate:") || isConditionalEndMarker(node));

/**
 * The logical nodes from `first` up to (excluding) `end`: the shape the client template gives them, where a
 * nested region is its start marker alone, because its content belongs to the nested conditional.
 */
export const clientShapedNodes = (first: Node | null, end: Node | null): Node[] => {
  const nodes: Node[] = [];
  for (let node = first; node && node !== end; node = node.nextSibling) {
    if (isPathInvisibleNode(node)) continue;
    nodes.push(node);
    if (isConditionalStartMarker(node)) {
      const nestedEnd = conditionalRegionEnd(node);
      if (nestedEnd && nestedEnd !== end) node = nestedEnd;
    }
  }
  return nodes;
};

/** Removes a region's content and its end marker; the start marker is the caller's to remove. */
export const removeConditionalRegion = (start: Comment): void => {
  clearConditionalRegion(start);
  conditionalRegionEnd(start)?.remove();
};
