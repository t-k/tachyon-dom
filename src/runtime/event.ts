export const delegate = (
  root: Element,
  eventName: string,
  path: readonly number[],
  handler: EventListener,
): (() => void) => {
  let target: Node = root;
  for (const index of path) {
    target = target.childNodes[index] as Node;
  }
  if (!(target instanceof Element)) {
    return () => undefined;
  }
  target.addEventListener(eventName, handler);
  return () => target.removeEventListener(eventName, handler);
};
