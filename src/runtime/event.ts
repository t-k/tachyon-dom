export const delegate = (
  root: Element,
  eventName: string,
  path: readonly number[],
  handler: EventListener,
): (() => void) => {
  const listener: EventListener = (event) => {
    let target: Node = root;
    for (const index of path) {
      target = target.childNodes[index] as Node;
    }
    if (!(target instanceof Element) || !(event.target instanceof Node) || !target.contains(event.target)) {
      return;
    }
    const descriptor = Object.getOwnPropertyDescriptor(event, "currentTarget");
    try {
      Object.defineProperty(event, "currentTarget", { configurable: true, value: target });
      handler(event);
    } finally {
      if (descriptor) {
        Object.defineProperty(event, "currentTarget", descriptor);
      } else {
        Reflect.deleteProperty(event, "currentTarget");
      }
    }
  };
  root.addEventListener(eventName, listener);
  return () => root.removeEventListener(eventName, listener);
};
