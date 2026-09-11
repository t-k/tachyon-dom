export const delegate = (
  root: Element,
  eventName: string,
  path: readonly number[],
  handler: EventListener,
): (() => void) => {
  let target: Node = root;
  for (const index of path) {
    // Skip SSR hydration marker comments so template paths stay valid.
    let cursor = 0;
    let next: Node | undefined;
    for (let child = target.firstChild; child; child = child.nextSibling) {
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
    if (!next) return () => undefined;
    target = next;
  }
  if (!(target instanceof Element)) {
    return () => undefined;
  }
  target.addEventListener(eventName, handler);
  return () => target.removeEventListener(eventName, handler);
};

export const delegateTarget = (
  _root: Element,
  eventName: string,
  target: Node,
  handler: EventListener,
): (() => void) => {
  if (!(target instanceof Element)) {
    return () => undefined;
  }
  target.addEventListener(eventName, handler);
  return () => target.removeEventListener(eventName, handler);
};
