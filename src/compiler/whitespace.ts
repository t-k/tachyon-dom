import type { ElementNode, TemplateNode, TemplateWhitespacePolicy, TextNode } from "./types.js";
import { textExpressionSegments } from "./utils.js";

const protectedTextElements = new Set(["pre", "script", "style", "textarea"]);
const asciiWhitespaceOnly = /^[\t\n\f\r ]+$/;
const internalFormattingLine = /[\t\f\r ]*(?:\r\n?|\n)[\t\n\f\r ]*/g;

const condenseStaticTextValue = (value: string): string => {
  if (!value.includes("\n") && !value.includes("\r")) return value;
  if (asciiWhitespaceOnly.test(value)) return " ";
  return value.replace(internalFormattingLine, " ");
};

const condenseTextValue = (value: string): string =>
  textExpressionSegments(value)
    .map((segment) => segment.kind === "text"
      ? condenseStaticTextValue(segment.value)
      : value.slice(segment.start, segment.end))
    .join("");

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
    children: node.children.map((child) => transformNode(child, nextProtectedContext)),
  } satisfies ElementNode;
};

export const applyTemplateWhitespace = (
  root: ElementNode,
  policy: TemplateWhitespacePolicy,
): ElementNode => policy === "condense" ? transformNode(root, false) as ElementNode : root;
