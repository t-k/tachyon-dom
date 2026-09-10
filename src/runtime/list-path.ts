import { logicalNodesBetween } from "../conditional-marker.js";

/**
 * Kept for modules compiled before list regions carried markers. Every path walker now steps over a list
 * region's rows, so a compiler path is valid as written and the list offset is always zero.
 */
export type DynamicListPath = {
  path: readonly number[];
  region?: { index?: number; at?: number; before?: number; after?: number };
};

/** Returns the expanded child count for lists owned by one logical parent: always zero now. */
export const dynamicListChildOffset = (
  _container: Node | undefined,
  _parentPath: readonly number[],
  _childIndex: number,
  _lists: readonly DynamicListPath[],
): number => 0;

/** Resolves a compiler path, stepping over list regions. */
export const nodeAtWithDynamicLists = (
  root: Node,
  path: readonly number[],
  _lists: readonly DynamicListPath[],
): Node => {
  let current: Node | undefined = root;
  for (const index of path) current = current ? logicalNodesBetween(current.firstChild, null)[index] : undefined;
  if (!current) throw new TypeError(`Missing generated binding node at path ${path.join(".")}.`);
  return current;
};
