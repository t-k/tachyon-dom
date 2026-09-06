/** Child at a template path index, ignoring SSR hydration marker comments. */
const childAt = (node: Node, index: number): Node | undefined => {
  let cursor = 0;
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 8 && (child.nodeValue ?? "").startsWith("tachyon-hydrate:")) continue;
    if (cursor++ === index) return child;
  }
  return undefined;
};

export const textAt = (root: Node, path: readonly number[]): Text => {
  let current: Node = root;
  for (const index of path) {
    const next = childAt(current, index);
    if (!next) {
      throw new TypeError(`Missing text binding node at path ${path.join(".")}.`);
    }
    current = next;
  }
  if (current.nodeType === 8 && current.nodeValue === "td:text") {
    const text = current.ownerDocument?.createTextNode("");
    if (!text || !current.parentNode) {
      throw new TypeError(`Cannot materialize text binding marker at path ${path.join(".")}.`);
    }
    current.parentNode.replaceChild(text, current);
    return text;
  }
  if (current.nodeType !== 3) {
    throw new TypeError(
      `Text binding path ${path.join(".")} resolved to ${current.nodeName} instead of a Text node.`,
    );
  }
  return current as Text;
};

export const setText = (text: Text, value: unknown): void => {
  text.nodeValue = value == null ? "" : String(value);
};
