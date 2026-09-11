// Self-contained (no module-level helpers): tests serialise this function
// with toString() and run it inside a real browser page.
export const textAt = (root: Node, path: readonly number[]): Text => {
  let current: Node = root;
  for (const index of path) {
    // Skip SSR hydration marker comments so template paths stay valid.
    let cursor = 0;
    let next: Node | undefined;
    for (let child = current.firstChild; child; child = child.nextSibling) {
      const marker = child.nodeType === 8 ? (child.nodeValue ?? "") : "";
      const region =
        marker === "tachyon-for" ||
        marker === "tachyon-if" ||
        marker === "tachyon-outlet" ||
        marker.startsWith("tachyon-slot:");
      // A region's content and end marker occupy no logical slot; only the start marker of a conditional or of
      // a server-only insertion (<outlet>, <slot>) keeps one.
      if (!region && (marker.startsWith("tachyon-hydrate:") || marker[0] === "/")) continue;
      if (marker !== "tachyon-for" && cursor++ === index) {
        next = child;
        break;
      }
      if (region) {
        let depth = 0;
        for (child = child.nextSibling; child; child = child.nextSibling) {
          const nested = child.nodeType === 8 ? child.nodeValue : "";
          if (nested === marker) depth++;
          else if (nested === `/${marker}` && depth-- === 0) break;
        }
        if (!child) break;
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
    throw new TypeError(`Text binding path ${path.join(".")} resolved to ${current.nodeName} instead of a Text node.`);
  }
  return current as Text;
};

export const setText = (text: Text, value: unknown): void => {
  text.nodeValue = value == null ? "" : String(value);
};
