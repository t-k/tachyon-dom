// Self-contained (no module-level helpers): tests serialise this function
// with toString() and run it inside a real browser page.
export const elementAt = (root: Node, path: readonly number[]): Element => {
  let current: Node = root;
  for (const index of path) {
    // Skip SSR hydration marker comments so template paths stay valid.
    let cursor = 0;
    let next: Node | undefined;
    for (const child of Array.from(current.childNodes)) {
      if (child.nodeType === 8 && (child.nodeValue ?? "").startsWith("tachyon-hydrate:")) continue;
      if (cursor++ === index) {
        next = child;
        break;
      }
    }
    current = next as Node;
  }
  return current as Element;
};

type DynamicListRegion = {
  before: number;
  after: number;
};

export type DynamicListPath = {
  path: readonly number[];
  region?: DynamicListRegion;
};

const logicalChildren = (node: Node): Node[] =>
  Array.from(node.childNodes).filter(
    (child) => child.nodeType !== 8 || !(child.nodeValue ?? "").startsWith("tachyon-hydrate:"),
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
  const start = startNode ? children.indexOf(startNode) : children.length;
  const end = firstAfter ? children.indexOf(firstAfter) : children.length;
  return Math.max(0, end - start);
};

const isStrictPathPrefix = (prefix: readonly number[], path: readonly number[]): boolean =>
  prefix.length < path.length && prefix.every((part, index) => part === path[index]);

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
    const count = container ? dynamicChildCount(container, list.region) : 0;
    const index = list.path.length;
    actualPath[index] = (actualPath[index] ?? 0) + count;
  }
  const node = nodeAt(root, actualPath);
  if (!node) throw new TypeError(`Missing generated binding node at path ${path.join(".")}.`);
  return node;
};

type ManagedClassState = {
  base: string;
  directives: Map<string, boolean>;
};

const managedClasses = new WeakMap<Element, ManagedClassState>();

const classStateFor = (element: Element): ManagedClassState => {
  const existing = managedClasses.get(element);
  if (existing) return existing;
  const state = { base: element.getAttribute("class") ?? "", directives: new Map<string, boolean>() };
  managedClasses.set(element, state);
  return state;
};

const applyClassState = (element: Element, state: ManagedClassState): void => {
  const tokens = new Set(state.base.trim().split(/\s+/).filter(Boolean));
  for (const [className, enabled] of state.directives) {
    if (enabled) tokens.add(className);
  }
  const value = Array.from(tokens).join(" ");
  if (value) element.setAttribute("class", value);
  else element.removeAttribute("class");
};

export const setClassValue = (element: Element, value: unknown): void => {
  const state = classStateFor(element);
  state.base = value == null || value === false || value === true ? "" : String(value);
  applyClassState(element, state);
};

export const setClassPresence = (element: Element, className: string, value: unknown): void => {
  const state = classStateFor(element);
  state.directives.set(className, Boolean(value));
  applyClassState(element, state);
};
