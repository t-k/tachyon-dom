export type FragmentHandle = {
  nodes: Node[];
  remove: () => void;
};

export const createFragmentNodes = (templateHtml: string): Node[] => {
  const template = document.createElement("template");
  template.innerHTML = templateHtml;
  return Array.from(template.content.childNodes).map((node) => node.cloneNode(true));
};

export const mountFragment = (parent: ParentNode, before: Node | null, nodes: readonly Node[]): FragmentHandle => {
  for (const node of nodes) {
    parent.insertBefore(node, before);
  }
  return {
    nodes: [...nodes],
    remove: () => {
      for (const node of nodes) {
        node.parentNode?.removeChild(node);
      }
    },
  };
};
