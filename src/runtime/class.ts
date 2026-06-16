export const elementAt = (root: Node, path: readonly number[]): Element => {
  let current: Node = root;
  for (const index of path) {
    current = current.childNodes[index] as Node;
  }
  return current as Element;
};

export const setClassPresence = (element: Element, className: string, value: unknown): void => {
  element.classList.toggle(className, Boolean(value));
};
