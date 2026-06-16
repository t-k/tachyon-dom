import type { CompiledTemplate, ElementNode, TemplateNode, TextNode } from "../types";
import {
  attrExpression,
  escapeHtml,
  escapeMarker,
  expressionPattern,
  expressionToScopeAccess,
  jsString,
  itemNameFromKey,
  readExpressionAttribute,
  readPath,
  serializeStaticAttr,
} from "../utils";

const renderText = (node: TextNode, scope: Record<string, unknown>): string => {
  let output = "";
  let cursor = 0;
  for (const match of node.value.matchAll(expressionPattern)) {
    const start = match.index ?? 0;
    output += node.value.slice(cursor, start);
    output += escapeHtml(readPath(scope, (match[1] as string).trim()));
    cursor = start + match[0].length;
  }
  output += node.value.slice(cursor);
  return output;
};

const renderFor = (node: ElementNode, scope: Record<string, unknown>): string => {
  const each = attrExpression(node, "each");
  const key = attrExpression(node, "key") ?? "item";
  const itemName = itemNameFromKey(key);
  const items = each ? readPath(scope, each) : undefined;
  if (!Array.isArray(items)) {
    return "";
  }
  return items
    .map((item) => {
      const childScope = { ...scope, [itemName]: item };
      return node.children.map((child) => renderNode(child, childScope)).join("");
    })
    .join("");
};

const renderElement = (node: ElementNode, scope: Record<string, unknown>): string => {
  if (node.tagName === "for") {
    return renderFor(node, scope);
  }
  if (node.tagName === "if") {
    return readPath(scope, attrExpression(node, "test") ?? "false")
      ? node.children.map((child) => renderNode(child, scope)).join("")
      : "";
  }
  if (node.tagName === "store") {
    return "";
  }
  if (node.tagName === "component") {
    return node.children.map((child) => renderNode(child, scope)).join("");
  }

  const attrs: string[] = [];
  const classes: string[] = [];
  const hydrateId = attrExpression(node, "hydrate:id");
  for (const attr of node.attrs) {
    if (attr.name.startsWith("on:") || attr.name === "hydrate:id") {
      continue;
    }
    if (attr.name.startsWith("class:")) {
      const expression = readExpressionAttribute(attr.value);
      if (expression && readPath(scope, expression)) {
        classes.push(attr.name.slice(6));
      }
      continue;
    }
    if (attr.name === "class" && attr.value !== true) {
      classes.push(attr.value);
      continue;
    }
    const expression = readExpressionAttribute(attr.value);
    if (expression) {
      const value = readPath(scope, expression);
      if (value != null && value !== false) {
        attrs.push(` ${attr.name}="${escapeHtml(value)}"`);
      }
      continue;
    }
    attrs.push(serializeStaticAttr(attr));
  }
  if (classes.length > 0) {
    attrs.unshift(` class="${escapeHtml(classes.join(" "))}"`);
  }
  const children = node.children.map((child) => renderNode(child, scope)).join("");
  const html = `<${node.tagName}${attrs.join("")}>${children}</${node.tagName}>`;
  if (!hydrateId) {
    return html;
  }
  const marker = escapeMarker(readPath(scope, hydrateId));
  return `<!--tachyon-hydrate:${marker}:start-->${html}<!--tachyon-hydrate:${marker}:end-->`;
};

const renderNode = (node: TemplateNode, scope: Record<string, unknown>): string => {
  if (node.type === "text") {
    return renderText(node, scope);
  }
  return renderElement(node, scope);
};

export const renderServerTemplate = (template: CompiledTemplate, scope: Record<string, unknown>): string =>
  renderElement(template.root, scope);

const renderTextExpression = (node: TextNode, locals: ReadonlySet<string> = new Set()): string => {
  const parts: string[] = [];
  let cursor = 0;
  for (const match of node.value.matchAll(expressionPattern)) {
    const start = match.index ?? 0;
    const staticText = node.value.slice(cursor, start);
    if (staticText) {
      parts.push(jsString(staticText));
    }
    parts.push(`escapeHtml(${expressionToScopeAccess((match[1] as string).trim(), locals)})`);
    cursor = start + match[0].length;
  }
  const trailing = node.value.slice(cursor);
  if (trailing) {
    parts.push(jsString(trailing));
  }
  return parts.length > 0 ? parts.join(" + ") : `""`;
};

export const renderOpenTagExpression = (node: ElementNode, locals: ReadonlySet<string>): string => {
  const parts: string[] = [jsString(`<${node.tagName}`)];
  const staticClasses: string[] = [];
  const dynamicClasses: string[] = [];

  for (const attr of node.attrs) {
    if (attr.name.startsWith("on:") || attr.name === "hydrate:id") {
      continue;
    }
    if (attr.name.startsWith("class:")) {
      const expression = readExpressionAttribute(attr.value);
      if (expression) {
        dynamicClasses.push(
          `(${expressionToScopeAccess(expression, locals)} ? ${jsString(` ${attr.name.slice(6)}`)} : "")`,
        );
      }
      continue;
    }
    if (attr.name === "class" && attr.value !== true) {
      staticClasses.push(attr.value);
      continue;
    }
    const expression = readExpressionAttribute(attr.value);
    if (expression) {
      const value = expressionToScopeAccess(expression, locals);
      parts.push(
        `(${value} == null || ${value} === false ? "" : ${jsString(` ${attr.name}="`)} + escapeHtml(${value}) + ${jsString(`"`)} )`,
      );
      continue;
    }
    parts.push(jsString(serializeStaticAttr(attr)));
  }

  if (staticClasses.length > 0 || dynamicClasses.length > 0) {
    const classExpression = `${jsString(staticClasses.join(" "))}${
      dynamicClasses.length > 0 ? ` + ${dynamicClasses.join(" + ")}` : ""
    }`;
    parts.push(`(${classExpression} ? ${jsString(` class="`)} + (${classExpression}).trim() + ${jsString(`"`)} : "")`);
  }

  parts.push(jsString(">"));
  return parts.join(" + ");
};

export const renderNodeExpression = (node: TemplateNode, locals: ReadonlySet<string> = new Set()): string => {
  if (node.type === "text") {
    return renderTextExpression(node, locals);
  }
  return renderElementExpression(node, locals);
};

const renderForExpression = (node: ElementNode, locals: ReadonlySet<string>): string => {
  const each = attrExpression(node, "each") ?? "[]";
  const key = attrExpression(node, "key") ?? "item";
  const itemName = itemNameFromKey(key);
  const eachAccess = expressionToScopeAccess(each, locals);
  const childLocals = new Set(locals);
  childLocals.add(itemName);
  const childExpression = node.children.map((child) => renderNodeExpression(child, childLocals)).join(" + ");
  return `(Array.isArray(${eachAccess}) ? ${eachAccess}.map((${itemName}) => ${childExpression || `""`}).join("") : "")`;
};

const renderElementExpression = (node: ElementNode, locals: ReadonlySet<string> = new Set()): string => {
  if (node.tagName === "for") {
    return renderForExpression(node, locals);
  }
  if (node.tagName === "if") {
    const test = expressionToScopeAccess(attrExpression(node, "test") ?? "false", locals);
    const childExpression = node.children.map((child) => renderNodeExpression(child, locals)).join(" + ");
    return `(${test} ? ${childExpression || `""`} : "")`;
  }
  if (node.tagName === "store") {
    return `""`;
  }
  if (node.tagName === "component") {
    return node.children.map((child) => renderNodeExpression(child, locals)).join(" + ") || `""`;
  }

  const parts: string[] = [renderOpenTagExpression(node, locals)];
  parts.push(...node.children.map((child) => renderNodeExpression(child, locals)));
  parts.push(jsString(`</${node.tagName}>`));
  const expression = parts.join(" + ");
  const hydrateId = attrExpression(node, "hydrate:id");
  if (!hydrateId) {
    return expression;
  }
  const marker = expressionToScopeAccess(hydrateId, locals);
  return `${jsString("<!--tachyon-hydrate:")} + escapeMarker(${marker}) + ${jsString(":start-->")} + ${expression} + ${jsString("<!--tachyon-hydrate:")} + escapeMarker(${marker}) + ${jsString(":end-->")}`;
};

export const generateServerModule = (template: CompiledTemplate): string => {
  const lines = [
    `const escapeHtml = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");`,
    `const escapeMarker = (value) => String(value ?? "").replaceAll("--", "- -").replaceAll(">", "&gt;");`,
    `export const render = (scope) => ${renderElementExpression(template.root)};`,
  ];
  return `${lines.join("\n")}\n`;
};
