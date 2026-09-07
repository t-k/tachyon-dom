// Self-contained (no module-level helpers): tests serialise this function
// with toString() and run it inside a real browser page.
export const textAt = (root: Node, path: readonly number[]): Text => {
  let current: Node = root;
  for (const index of path) {
    // Skip SSR hydration marker comments so template paths stay valid.
    let cursor = 0;
    let next: Node | undefined;
    for (const child of Array.from(current.childNodes)) {
      if (
        child.nodeType === 8 &&
        ((child.nodeValue ?? "").startsWith("tachyon-hydrate:") || (child.nodeValue ?? "") === "tachyon-list")
      ) continue;
      if (cursor++ === index) {
        next = child;
        break;
      }
    }
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
