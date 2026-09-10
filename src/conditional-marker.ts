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
 * Comment markers that delimit a `<for>` region the same way. Both markers are invisible to logical paths, so a
 * `<for>` keeps occupying no slot in its parent: the rows between the markers are the only nodes it adds, and
 * they are what shifts later siblings. A container can hold several regions side by side, each identified by
 * its ordinal among the container's own regions (regions nested inside another region do not count).
 */
export const listStartMarkerValue = "tachyon-for";
export const listEndMarkerValue = "/tachyon-for";
export const listStartMarker = `<!--${listStartMarkerValue}-->`;
export const listEndMarker = `<!--${listEndMarkerValue}-->`;

export const isListStartMarker = (node: Node): node is Comment =>
  node.nodeType === Node.COMMENT_NODE && node.nodeValue === listStartMarkerValue;

export const isListEndMarker = (node: Node): node is Comment =>
  node.nodeType === Node.COMMENT_NODE && node.nodeValue === listEndMarkerValue;

/** The end marker that closes the list region `start` opens, skipping nested list regions. */
export const listRegionEnd = (start: Comment): Comment | undefined => {
  let depth = 0;
  for (let node = start.nextSibling; node; node = node.nextSibling) {
    if (isListStartMarker(node)) depth++;
    else if (isListEndMarker(node)) {
      if (depth === 0) return node;
      depth--;
    }
  }
  return undefined;
};

/**
 * The start marker of the container's `index`-th own list region. Regions inside a sibling conditional or list
 * region belong to that region's content and are skipped.
 */
export const listRegionStartAt = (container: Node, index: number): Comment | undefined => {
  let depth = 0;
  let ordinal = 0;
  for (let node = container.firstChild; node; node = node.nextSibling) {
    if (isConditionalStartMarker(node) || isListStartMarker(node)) {
      if (depth === 0 && isListStartMarker(node) && ordinal++ === index) return node;
      depth++;
    } else if (isConditionalEndMarker(node) || isListEndMarker(node)) {
      depth--;
    }
  }
  return undefined;
};

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

/** Hydration markers, region end markers, and both list markers occupy no logical slot: paths count past them. */
export const isPathInvisibleNode = (node: Node): boolean =>
  node.nodeType === Node.COMMENT_NODE &&
  ((node.nodeValue ?? "").startsWith("tachyon-hydrate:") ||
    isConditionalEndMarker(node) ||
    isListStartMarker(node) ||
    isListEndMarker(node));

/**
 * The logical nodes from `first` up to (excluding) `end`: the shape the client template gives them, where a
 * nested region is its start marker alone, because its content belongs to the nested conditional.
 */
export const clientShapedNodes = (first: Node | null, end: Node | null): Node[] => {
  const nodes: Node[] = [];
  for (let node = first; node && node !== end; node = node.nextSibling) {
    if (isListStartMarker(node)) {
      // A list region occupies no slot, rows included; its start marker stands in for the whole region.
      const nestedEnd = listRegionEnd(node);
      if (nestedEnd && nestedEnd !== end) node = nestedEnd;
      continue;
    }
    if (isPathInvisibleNode(node)) continue;
    nodes.push(node);
    if (isConditionalStartMarker(node)) {
      const nestedEnd = conditionalRegionEnd(node);
      if (nestedEnd && nestedEnd !== end) node = nestedEnd;
    }
  }
  return nodes;
};

/**
 * The node a template path addresses from `root`. A region's content and end marker occupy no logical slot: a
 * list's rows are addressed by the list and a conditional's branch by the conditional, so a sibling after either
 * keeps the path the template gave it. Only a conditional's start marker keeps a slot, as its anchor.
 */
export const templateNodeAt = (root: Node, path: readonly number[]): Node | undefined => {
  let current: Node | undefined = root;
  for (const index of path) {
    let cursor = 0;
    let next: Node | undefined;
    for (let child: ChildNode | null = current?.firstChild ?? null; child; child = child.nextSibling) {
      const list = isListStartMarker(child);
      const conditional = isConditionalStartMarker(child);
      if (!list && !conditional && isPathInvisibleNode(child)) continue;
      if (!list && cursor++ === index) {
        next = child;
        break;
      }
      if (list) child = listRegionEnd(child as Comment) ?? child;
      else if (conditional) child = conditionalRegionEnd(child as Comment) ?? child;
    }
    current = next;
  }
  return current;
};

/**
 * The logical nodes among `first` up to (excluding) `end` for the conditional runtime, which accounts for the
 * branches it owns itself: invisible markers and every node inside a list region are skipped, so a path never
 * addresses a row from its container.
 */
export const logicalNodesBetween = (first: Node | null, end: Node | null): Node[] => {
  const nodes: Node[] = [];
  for (let node = first; node && node !== end; node = node.nextSibling) {
    if (isListStartMarker(node)) {
      const nestedEnd = listRegionEnd(node);
      if (nestedEnd && nestedEnd !== end) node = nestedEnd;
      continue;
    }
    if (!isPathInvisibleNode(node)) nodes.push(node);
  }
  return nodes;
};

/** Removes a region's content and its end marker; the start marker is the caller's to remove. */
export const removeConditionalRegion = (start: Comment): void => {
  clearConditionalRegion(start);
  conditionalRegionEnd(start)?.remove();
};
