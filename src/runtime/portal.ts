export type PortalHandle = {
  target: Element;
  nodes: Node[];
  remove: () => void;
};

export const mountPortal = (target: Element, nodes: readonly Node[]): PortalHandle => {
  target.append(...nodes);
  return {
    target,
    nodes: [...nodes],
    remove: () => {
      for (const node of nodes) {
        node.parentNode?.removeChild(node);
      }
    },
  };
};
