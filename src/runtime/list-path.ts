type DynamicListRegion = {
  before: number;
  after: number;
  /** Logical child index used by generated binding paths. */
  logicalBefore?: number;
  /** Logical child count after the list used to bound dynamic output. */
  logicalAfter?: number;
};

export type DynamicListPath = {
  path: readonly number[];
  region?: DynamicListRegion;
};

const logicalChildren = (node: Node): Node[] =>
  Array.from(node.childNodes).filter(
    (child) =>
      child.nodeType !== 8 ||
      (!(child.nodeValue ?? "").startsWith("tachyon-hydrate:") &&
        (child.nodeValue ?? "") !== "tachyon-list" &&
        (child.nodeValue ?? "") !== "/tachyon-if"),
  );

const nodeAt = (root: Node, path: readonly number[]): Node | undefined => {
  let current: Node | undefined = root;
  for (const index of path) current = current ? logicalChildren(current)[index] : undefined;
  return current;
};

const dynamicChildCount = (container: Node, region: DynamicListRegion | undefined): number => {
  const children = logicalChildren(container);
  if (!region || !(container instanceof Element)) return children.length;
  const elements = children.filter((child): child is Element => child instanceof Element);
  const firstAfter = region.after > 0 ? elements.at(-region.after) : undefined;
  const firstDynamic = elements[region.before];
  const startNode = firstDynamic ?? firstAfter;
  const legacyStart = startNode ? children.indexOf(startNode) : children.length;
  const legacyEnd = firstAfter ? children.indexOf(firstAfter) : children.length;
  const start =
    region.logicalBefore === undefined
      ? legacyStart
      : Math.min(children.length, Math.max(0, region.logicalBefore));
  const end =
    region.logicalAfter === undefined
      ? legacyEnd
      : Math.max(start, children.length - Math.max(0, region.logicalAfter));
  return Math.max(0, end - start);
};

const isStrictPathPrefix = (prefix: readonly number[], path: readonly number[]): boolean =>
  prefix.length < path.length && prefix.every((part, index) => part === path[index]);

const pathEquals = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length && left.every((part, index) => part === right[index]);

const listAffectsChild = (list: DynamicListPath, childIndex: number): boolean =>
  !list.region || childIndex >= (list.region.logicalBefore ?? list.region.before);

/** Returns the expanded child count for lists owned by one logical parent. */
export const dynamicListChildOffset = (
  container: Node | undefined,
  parentPath: readonly number[],
  childIndex: number,
  lists: readonly DynamicListPath[],
): number =>
  container
    ? lists
        .filter((list) => pathEquals(list.path, parentPath) && listAffectsChild(list, childIndex))
        .reduce((offset, list) => offset + dynamicChildCount(container, list.region), 0)
    : 0;

/** Resolves a compiler path after preceding keyed-list output has expanded. */
export const nodeAtWithDynamicLists = (
  root: Node,
  path: readonly number[],
  lists: readonly DynamicListPath[],
): Node => {
  const actualPath = [...path];
  const orderedLists = [...lists].sort((left, right) => left.path.length - right.path.length);
  for (const list of orderedLists) {
    if (!isStrictPathPrefix(list.path, path)) continue;
    const container = nodeAt(root, actualPath.slice(0, list.path.length));
    const index = list.path.length;
    actualPath[index] =
      (actualPath[index] ?? 0) + dynamicListChildOffset(container, list.path, actualPath[index] ?? 0, [list]);
  }
  const node = nodeAt(root, actualPath);
  if (!node) throw new TypeError(`Missing generated binding node at path ${path.join(".")}.`);
  return node;
};
