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
    for (const child of Array.from(target.childNodes)) {
      if (child.nodeType === 8 && (child.nodeValue ?? "").startsWith("tachyon-hydrate:")) continue;
      if (cursor++ === index) {
        next = child;
        break;
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
