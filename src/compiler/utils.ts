import type { Attribute, ElementNode, HydrationBoundary, TemplateNode } from "./types.js";
import { evaluateExpression, expressionToJs } from "./expression.js";
import { escapeHtml } from "../html-escape.js";
export { escapeHtml } from "../html-escape.js";

export const expressionPattern = /\{([^{}]+)\}/g;
export const identifierNamePattern = /^[A-Za-z_$][\w$]*$/;
export const identifierPattern = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

const reservedIdentifierNames = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

export const isSafeIdentifierName = (name: string): boolean =>
  identifierNamePattern.test(name) && !reservedIdentifierNames.has(name);

export const assertSafeIdentifierName = (name: string, context: string): void => {
  if (!isSafeIdentifierName(name)) {
    throw new TypeError(`${context} must be a safe identifier.`);
  }
};

export type TextExpressionSegment =
  | { kind: "text"; value: string; start: number; end: number }
  | { kind: "expression"; value: string; start: number; end: number };

const findExpressionEnd = (value: string, start: number): number => {
  let depth = 0;
  let quote: '"' | "'" | "`" | undefined;
  let escaped = false;
  for (let index = start; index < value.length; index++) {
    const char = value[index] as string;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (quote === "`" && char === "$" && value[index + 1] === "{") {
        depth++;
        index++;
        continue;
      }
      if (quote === "`" && char === "}" && depth > 0) {
        depth--;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === `"` || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") {
      depth++;
      continue;
    }
    if (char === "}") {
      if (depth === 0) {
        return index;
      }
      depth--;
    }
  }
  return -1;
};

export const textExpressionSegments = (value: string): TextExpressionSegment[] => {
  const segments: TextExpressionSegment[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf("{", cursor);
    if (start < 0) {
      segments.push({ kind: "text", value: value.slice(cursor), start: cursor, end: value.length });
      break;
    }
    if (start > cursor) {
      segments.push({ kind: "text", value: value.slice(cursor, start), start: cursor, end: start });
    }
    const end = findExpressionEnd(value, start + 1);
    if (end < 0) {
      segments.push({ kind: "text", value: value.slice(start), start, end: value.length });
      break;
    }
    segments.push({ kind: "expression", value: value.slice(start + 1, end).trim(), start, end: end + 1 });
    cursor = end + 1;
  }
  return segments;
};

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

export const isHydrationAttribute = (name: string): boolean => name === "hydrate" || name.startsWith("hydrate:");

const hydrationStrategies = new Set(["load", "idle", "visible", "media", "interaction"]);

export const isKnownHydrationAttribute = (name: string): boolean =>
  name === "hydrate" ||
  name === "hydrate:id" ||
  (name.startsWith("hydrate:") && hydrationStrategies.has(name.slice("hydrate:".length)));

export const automaticHydrationId = (path: readonly number[]): string =>
  `td-h-${path.length === 0 ? "root" : path.join("-")}`;

export const hydrationBoundaryFor = (node: ElementNode, path: readonly number[]): HydrationBoundary | undefined => {
  const explicitId = attrExpression(node, "hydrate:id");
  const strategyAttr = node.attrs.find(
    (attr) =>
      attr.name.startsWith("hydrate:") && attr.name !== "hydrate:id" && hydrationStrategies.has(attr.name.slice(8)),
  );
  const hasAutoHydrate = node.attrs.some(
    (attr) => attr.name === "hydrate" || (attr.name.startsWith("hydrate:") && attr.name !== "hydrate:id"),
  );
  if (!explicitId && !hasAutoHydrate) {
    return undefined;
  }
  const boundary: HydrationBoundary = explicitId
    ? { path: [...path], id: explicitId, idKind: "expression" }
    : { path: [...path], id: automaticHydrationId(path), idKind: "static" };
  if (!strategyAttr) {
    return boundary;
  }
  const strategy = strategyAttr.name.slice(8) as NonNullable<HydrationBoundary["strategy"]>;
  boundary.strategy = strategy;
  if (strategy === "visible") {
    const rootMargin = typeof strategyAttr.value === "string" ? strategyAttr.value : undefined;
    if (rootMargin) {
      boundary.rootMargin = rootMargin;
    }
  }
  if (strategy === "interaction") {
    const interaction = typeof strategyAttr.value === "string" ? strategyAttr.value : undefined;
    if (interaction) {
      boundary.interaction = interaction;
    }
  }
  if (strategy === "media") {
    const media = typeof strategyAttr.value === "string" ? strategyAttr.value : undefined;
    if (media) {
      boundary.media = media;
    }
  }
  return boundary;
};

export const childPathEntries = (
  children: readonly TemplateNode[],
  basePath: readonly number[],
): Array<{ child: TemplateNode; path: number[] }> => {
  let domIndex = 0;
  return children.map((child) => {
    const path =
      child.type === "element" && (child.tagName === "store" || child.tagName === "for")
        ? [...basePath]
        : [...basePath, domIndex++];
    return { child, path };
  });
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

export const escapeMarker = (value: unknown): string =>
  String(value ?? "")
    .replaceAll("--", "- -")
    .replaceAll(">", "&gt;");

export const readPath = (scope: Record<string, unknown>, expression: string): unknown => {
  return evaluateExpression(expression, scope);
};

export const serializeStaticAttr = (attr: Attribute): string => {
  if (attr.value === true) {
    return ` ${attr.name}`;
  }
  return ` ${attr.name}="${escapeHtml(attr.value)}"`;
};

export const voidElementNames = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

export const isVoidElement = (node: ElementNode): boolean => voidElementNames.has(node.tagName);

export const expressionToScopeAccess = (
  expression: string,
  locals: ReadonlySet<string> = new Set(),
  scopeName = "scope",
): string => {
  return expressionToJs(expression, locals, scopeName);
};

export const jsString = (value: string): string => JSON.stringify(value);

export const jsOptionalPropertyAccess = (objectExpression: string, propertyName: string): string =>
  identifierNamePattern.test(propertyName)
    ? `${objectExpression}?.${propertyName}`
    : `${objectExpression}?.[${jsString(propertyName)}]`;
