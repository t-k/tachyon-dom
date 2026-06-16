import type { Attribute, ElementNode, TemplateNode } from "./types";

export const expressionPattern = /\{([^{}]+)\}/g;
export const identifierPattern = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

export const readExpressionAttribute = (value: string | true): string | undefined => {
  if (value === true) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return undefined;
  }
  return trimmed.slice(1, -1).trim();
};

export const attrExpression = (node: ElementNode, name: string): string | undefined => {
  const attr = node.attrs.find((candidate) => candidate.name === name);
  return attr ? readExpressionAttribute(attr.value) : undefined;
};

export const attrString = (node: ElementNode, name: string): string | undefined => {
  const attr = node.attrs.find((candidate) => candidate.name === name);
  return typeof attr?.value === "string" ? attr.value : undefined;
};

export const isForNode = (node: TemplateNode): node is ElementNode => node.type === "element" && node.tagName === "for";

export const isStoreNode = (node: TemplateNode): node is ElementNode =>
  node.type === "element" && node.tagName === "store";

export const itemNameFromKey = (key: string): string => {
  const [itemName] = key.split(".");
  return itemName && identifierPattern.test(itemName) ? itemName : "item";
};

export const renderableChildren = (node: ElementNode): TemplateNode[] =>
  node.children.filter((child) => child.type !== "text" || child.value.length > 0);

export const escapeHtml = (value: unknown): string =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll(`"`, "&quot;");

export const escapeMarker = (value: unknown): string =>
  String(value ?? "")
    .replaceAll("--", "- -")
    .replaceAll(">", "&gt;");

export const readPath = (scope: Record<string, unknown>, expression: string): unknown => {
  if (!identifierPattern.test(expression)) {
    return undefined;
  }
  const parts = expression.split(".");
  let current: unknown = scope;
  for (const part of parts) {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
};

export const serializeStaticAttr = (attr: Attribute): string => {
  if (attr.value === true) {
    return ` ${attr.name}`;
  }
  return ` ${attr.name}="${attr.value}"`;
};

export const expressionToScopeAccess = (expression: string, locals: ReadonlySet<string> = new Set()): string => {
  if (!identifierPattern.test(expression)) {
    return "undefined";
  }
  const [head] = expression.split(".");
  if (head && locals.has(head)) {
    return expression;
  }
  return `scope.${expression}`;
};

export const jsString = (value: string): string => JSON.stringify(value);
