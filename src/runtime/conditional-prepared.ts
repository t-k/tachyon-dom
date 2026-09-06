type PreparedAnchor = {
  root: Node;
  key: string;
};

const preparedAnchors = new WeakMap<Comment, PreparedAnchor>();
const preparedAdoptions = new WeakMap<Comment, Node[]>();
const preparedNodeCounts = new WeakMap<Node, Map<string, number>>();

export const registerPreparedAnchor = (root: Node, key: string, anchor: Comment): void => {
  preparedAnchors.set(anchor, { root, key });
};

export const setPreparedConditionalNodes = (anchor: Comment, nodes: Node[]): void => {
  preparedAdoptions.set(anchor, nodes);
};

export const takePreparedConditionalNodes = (anchor: Comment): Node[] | undefined => {
  const nodes = preparedAdoptions.get(anchor);
  preparedAdoptions.delete(anchor);
  return nodes;
};

export const setPreparedConditionalNodeCount = (anchor: Comment, count: number): void => {
  const prepared = preparedAnchors.get(anchor);
  if (!prepared) return;
  const counts = preparedNodeCounts.get(prepared.root) ?? new Map<string, number>();
  counts.set(prepared.key, count);
  preparedNodeCounts.set(prepared.root, counts);
};

export const preparedConditionalNodeCount = (root: Node, key: string): number | undefined =>
  preparedNodeCounts.get(root)?.get(key);
