import type { ElementNode, TemplateNode, TemplateWhitespacePolicy, TextNode } from "./types.js";

const protectedTextElements = new Set(["pre", "script", "style", "textarea"]);
const fragmentElements = new Set(["await", "component", "for", "if"]);
const asciiWhitespaceOnly = /^[\t\n\f\r ]+$/;
const startsWithFormattingLine = /^[\t\f\r ]*(?:\r\n?|\n)[\t\n\f\r ]*/;
const endsWithFormattingLine = /[\t\n\f\r ]*(?:\r\n?|\n)[\t\f\r ]*$/;
const internalFormattingLine = /[\t\f\r ]*(?:\r\n?|\n)[\t\n\f\r ]*/g;

const condenseTextValue = (value: string): string => {
  if (!value.includes("\n") && !value.includes("\r")) return value;
  if (asciiWhitespaceOnly.test(value)) return " ";
  return value
    .replace(startsWithFormattingLine, "")
    .replace(endsWithFormattingLine, "")
    .replace(internalFormattingLine, " ");
};

const isFormattingWhitespace = (node: TemplateNode): boolean =>
  node.type === "text" && (node.value.includes("\n") || node.value.includes("\r")) && asciiWhitespaceOnly.test(node.value);

const fragmentChildren = (node: ElementNode): TemplateNode[] => {
  if (!fragmentElements.has(node.tagName.toLowerCase())) return node.children;
  return node.children.filter((child, index, children) =>
    (index !== 0 && index !== children.length - 1) || !isFormattingWhitespace(child));
};

const transformNode = (node: TemplateNode, protectedContext: boolean): TemplateNode => {
  if (node.type === "text") {
    const text: TextNode = { ...node };
    if (!protectedContext) text.value = condenseTextValue(text.value);
    return text;
  }
  const nextProtectedContext = protectedContext || protectedTextElements.has(node.tagName.toLowerCase());
  return {
    ...node,
    attrs: node.attrs.map((attribute) => ({ ...attribute })),
    children: fragmentChildren(node).map((child) => transformNode(child, nextProtectedContext)),
  } satisfies ElementNode;
};

export const applyTemplateWhitespace = (
  root: ElementNode,
  policy: TemplateWhitespacePolicy,
): ElementNode => policy === "condense" ? transformNode(root, false) as ElementNode : root;
