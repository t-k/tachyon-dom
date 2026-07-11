import type { ElementNode, TemplateNode, TemplateWhitespacePolicy, TextNode } from "./types.js";
import { textExpressionSegments } from "./utils.js";

const protectedTextElements = new Set([
  "iframe",
  "listing",
  "noembed",
  "noframes",
  "plaintext",
  "pre",
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
]);
const asciiWhitespaceOnly = /^[\t\n\f\r ]+$/;
const internalFormattingLine = /[\t\f\r ]*(?:\r\n?|\n)[\t\n\f\r ]*/g;

const condenseStaticTextValue = (value: string): string => {
  if (!value.includes("\n") && !value.includes("\r")) return value;
  if (asciiWhitespaceOnly.test(value)) return " ";
  return value.replace(internalFormattingLine, " ");
};

const condenseTextValue = (value: string): string =>
  textExpressionSegments(value)
    .map((segment) =>
      segment.kind === "text" ? condenseStaticTextValue(segment.value) : value.slice(segment.start, segment.end),
    )
    .join("");

type WhitespaceContext = {
  protectedHtmlText: boolean;
  foreignContent: "html" | "svg" | "math";
  xmlSpace: "default" | "preserve";
};

const childForeignContent = (
  parent: WhitespaceContext["foreignContent"],
  tagName: string,
): WhitespaceContext["foreignContent"] => {
  if (parent === "svg" && tagName === "foreignobject") return "html";
  if (parent === "html" && tagName === "svg") return "svg";
  if (parent === "html" && tagName === "math") return "math";
  return parent;
};

const staticXmlSpace = (node: ElementNode): WhitespaceContext["xmlSpace"] | undefined => {
  const attribute = node.attrs.find((candidate) => candidate.name === "xml:space");
  return attribute?.value === "preserve" || attribute?.value === "default" ? attribute.value : undefined;
};

const transformNode = (node: TemplateNode, context: WhitespaceContext): TemplateNode => {
  if (node.type === "text") {
    const text: TextNode = { ...node };
    if (!context.protectedHtmlText && context.xmlSpace !== "preserve") text.value = condenseTextValue(text.value);
    return text;
  }
  const tagName = node.tagName.toLowerCase();
  const foreignContent = childForeignContent(context.foreignContent, tagName);
  const entersForeignContent = context.foreignContent === "html" && foreignContent !== "html";
  const xmlSpace =
    foreignContent === "html"
      ? "default"
      : (staticXmlSpace(node) ?? (entersForeignContent ? "default" : context.xmlSpace));
  const nextContext: WhitespaceContext = {
    protectedHtmlText: context.protectedHtmlText || protectedTextElements.has(tagName),
    foreignContent,
    xmlSpace,
  };
  return {
    ...node,
    attrs: node.attrs.map((attribute) => ({ ...attribute })),
    children: node.children.map((child) => transformNode(child, nextContext)),
  } satisfies ElementNode;
};

export const applyTemplateWhitespace = (root: ElementNode, policy: TemplateWhitespacePolicy): ElementNode =>
  policy === "condense"
    ? (transformNode(root, { protectedHtmlText: false, foreignContent: "html", xmlSpace: "default" }) as ElementNode)
    : root;
