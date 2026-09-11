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

/** The end marker that closes the region `start` opens, skipping nested regions of the same kind. */
const regionEnd = (
  start: Comment,
  isStart: (node: Node) => boolean,
  isEnd: (node: Node) => boolean,
): Comment | undefined => {
  let depth = 0;
  for (let node = start.nextSibling; node; node = node.nextSibling) {
    if (isStart(node)) depth++;
    else if (isEnd(node)) {
      if (depth === 0) return node as Comment;
      depth--;
    }
  }
  return undefined;
};

/** The end marker that closes the list region `start` opens, skipping nested list regions. */
export const listRegionEnd = (start: Comment): Comment | undefined =>
  regionEnd(start, isListStartMarker, isListEndMarker);

/**
 * The start marker of the container's `index`-th own list region. Regions inside a sibling conditional or list
 * region belong to that region's content and are skipped.
 */
export const listRegionStartAt = (container: Node, index: number): Comment | undefined =>
  listRegionStartBetween(container.firstChild, null, index);

/**
 * The nth list start marker among the nodes from `first` up to (excluding) `end`, counting only regions at
 * this level: a list inside a sibling `<if>` or `<for>` region belongs to that region. A branch mounts its
 * own direct `<for>` by searching the nodes between its conditional markers this way.
 */
export const listRegionStartBetween = (first: Node | null, end: Node | null, index: number): Comment | undefined => {
  let depth = 0;
  let ordinal = 0;
  for (let node = first; node && node !== end; node = node.nextSibling) {
    if (isConditionalStartMarker(node) || isListStartMarker(node)) {
      if (depth === 0 && isListStartMarker(node) && ordinal++ === index) return node;
      depth++;
    } else if (isConditionalEndMarker(node) || isListEndMarker(node)) {
      depth--;
    }
  }
  return undefined;
};

/** Removes a list region's rows and its end marker; the start marker is the caller's to remove. */
export const removeListRegion = (start: Comment): void => {
  const end = listRegionEnd(start);
  while (end && start.nextSibling && start.nextSibling !== end) start.nextSibling.remove();
  end?.remove();
};

/**
 * The end marker that closes the region `start` opens, skipping nested regions, or `undefined` when the
 * region has no end marker (a hand-built anchor comment without one).
 */
export const conditionalRegionEnd = (start: Comment): Comment | undefined =>
  regionEnd(start, isConditionalStartMarker, isConditionalEndMarker);

/** Removes every node between a region's markers; the markers themselves stay. */
export const clearConditionalRegion = (start: Comment): void => {
  const end = conditionalRegionEnd(start);
  while (end && start.nextSibling && start.nextSibling !== end) start.nextSibling.remove();
};

/**
 * Comment markers that delimit a server-only insertion: `<outlet>` renders `<!--tachyon-outlet-->` and
 * `<slot name="x">` renders `<!--tachyon-slot:x-->`, each closed by the same value prefixed with `/`. The
 * server and stream targets put the inserted HTML between the pair; the client template carries the empty pair.
 * The start marker occupies one logical slot, exactly like a conditional's, and the content and end marker
 * occupy none, so a binding after the insertion keeps its template path however many nodes the server inserted.
 * Nothing inside the pair is bound or managed by the parent template.
 */
export const outletMarkerValue = "tachyon-outlet";
export const slotMarkerPrefix = "tachyon-slot:";
export const outletStartMarker = `<!--${outletMarkerValue}-->`;
export const outletEndMarker = `<!--/${outletMarkerValue}-->`;
export const slotStartMarker = (name: string): string => `<!--${slotMarkerPrefix}${name}-->`;
export const slotEndMarker = (name: string): string => `<!--/${slotMarkerPrefix}${name}-->`;

export const isInsertionStartMarker = (node: Node): node is Comment => {
  if (node.nodeType !== Node.COMMENT_NODE) return false;
  const value = node.nodeValue ?? "";
  return value === outletMarkerValue || value.startsWith(slotMarkerPrefix);
};

export const isInsertionEndMarker = (node: Node): node is Comment => {
  if (node.nodeType !== Node.COMMENT_NODE) return false;
  const value = node.nodeValue ?? "";
  return value === `/${outletMarkerValue}` || value.startsWith(`/${slotMarkerPrefix}`);
};

/** The end marker that closes the insertion `start` opens, skipping nested insertions. */
export const insertionRegionEnd = (start: Comment): Comment | undefined =>
  regionEnd(start, isInsertionStartMarker, isInsertionEndMarker);

/** Removes an insertion's content and its end marker; the start marker is the caller's to remove. */
export const removeInsertionRegion = (start: Comment): void => {
  const end = insertionRegionEnd(start);
  while (end && start.nextSibling && start.nextSibling !== end) start.nextSibling.remove();
  end?.remove();
};

/**
 * For the start marker of a region whose content the parent template never addresses (a conditional's branch
 * or a server-only insertion), the matching end marker; `undefined` for any other node.
 */
const opaqueRegionEnd = (node: Node): Comment | undefined =>
  isConditionalStartMarker(node)
    ? conditionalRegionEnd(node)
    : isInsertionStartMarker(node)
      ? insertionRegionEnd(node)
      : undefined;

/**
 * Hydration markers, region end markers, both list markers, and insertion end markers occupy no logical slot:
 * paths count past them.
 */
export const isPathInvisibleNode = (node: Node): boolean =>
  node.nodeType === Node.COMMENT_NODE &&
  ((node.nodeValue ?? "").startsWith("tachyon-hydrate:") ||
    isConditionalEndMarker(node) ||
    isListStartMarker(node) ||
    isListEndMarker(node) ||
    isInsertionEndMarker(node));

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
    // A branch or server-inserted content is opaque to the parent template; the start marker stands in for it.
    const nestedEnd = opaqueRegionEnd(node);
    if (nestedEnd && nestedEnd !== end) node = nestedEnd;
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
      const opaqueEnd = list ? undefined : opaqueRegionEnd(child);
      if (!list && !opaqueEnd && isPathInvisibleNode(child)) continue;
      if (!list && cursor++ === index) {
        next = child;
        break;
      }
      if (list) child = listRegionEnd(child as Comment) ?? child;
      else if (opaqueEnd) child = opaqueEnd;
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
    if (isPathInvisibleNode(node)) continue;
    nodes.push(node);
    if (isInsertionStartMarker(node)) {
      const nestedEnd = insertionRegionEnd(node);
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
