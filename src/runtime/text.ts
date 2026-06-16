export const textAt = (root: Node, path: readonly number[]): Text => {
  let current: Node = root;
  for (const index of path) {
    current = current.childNodes[index] as Node;
  }
  return current as Text;
};

export const setText = (text: Text, value: unknown): void => {
  text.nodeValue = value == null ? "" : String(value);
};
