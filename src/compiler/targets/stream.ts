import type { CompiledTemplate, ElementNode, TemplateNode, TextNode } from "../types";
import {
  attrExpression,
  attrString,
  expressionToScopeAccess,
  itemNameFromKey,
  jsString,
  readExpressionAttribute,
  textExpressionSegments,
} from "../utils";
import { renderOpenTagExpression } from "./server";

const renderTextYieldStatements = (node: TextNode, locals: ReadonlySet<string>, indent: string): string[] => {
  const statements: string[] = [];
  for (const segment of textExpressionSegments(node.value)) {
    if (segment.kind === "text") {
      if (segment.value) {
        statements.push(`${indent}yield ${jsString(segment.value)};`);
      }
      continue;
    }
    statements.push(`${indent}yield escapeHtml(${expressionToScopeAccess(segment.value, locals)});`);
  }
  return statements;
};

const renderForYieldStatements = (node: ElementNode, locals: ReadonlySet<string>, indent: string): string[] => {
  const each = attrExpression(node, "each") ?? "[]";
  const key = attrExpression(node, "key") ?? "item";
  const itemName = itemNameFromKey(key);
  const eachAccess = expressionToScopeAccess(each, locals);
  const childLocals = new Set(locals);
  childLocals.add(itemName);
  const statements = [
    `${indent}if (Array.isArray(${eachAccess})) {`,
    `${indent}  for (const ${itemName} of ${eachAccess}) {`,
  ];
  for (const child of node.children) {
    statements.push(...renderNodeYieldStatements(child, childLocals, `${indent}    `));
  }
  statements.push(`${indent}  }`, `${indent}}`);
  return statements;
};

const renderElementYieldStatements = (node: ElementNode, locals: ReadonlySet<string>, indent: string): string[] => {
  if (node.tagName === "outlet") {
    return [`${indent}yield String(scope.outlet ?? "");`];
  }
  if (node.tagName === "slot") {
    return [`${indent}yield String(scope.slots?.${attrString(node, "name") ?? "default"} ?? "");`];
  }
  if (node.tagName === "for") {
    return renderForYieldStatements(node, locals, indent);
  }
  if (node.tagName === "if") {
    const statements = [`${indent}if (${expressionToScopeAccess(attrExpression(node, "test") ?? "false", locals)}) {`];
    for (const child of node.children) {
      statements.push(...renderNodeYieldStatements(child, locals, `${indent}  `));
    }
    statements.push(`${indent}}`);
    return statements;
  }
  if (node.tagName === "store") {
    return [];
  }
  if (node.tagName === "component") {
    return renderComponentYieldStatements(node, locals, indent);
  }
  if (node.tagName === "await") {
    const thenName = attrString(node, "then") ?? "value";
    const fallback = attrString(node, "fallback");
    const errorText = attrString(node, "error");
    const childLocals = new Set(locals);
    childLocals.add(thenName);
    const statements = [`${indent}{`];
    if (fallback) {
      statements.push(`${indent}  yield ${jsString(fallback)};`);
    }
    if (errorText) {
      statements.push(`${indent}  try {`);
      statements.push(
        `${indent}    const ${thenName} = await ${expressionToScopeAccess(attrExpression(node, "value") ?? "undefined", locals)};`,
      );
      for (const child of node.children) {
        statements.push(...renderNodeYieldStatements(child, childLocals, `${indent}    `));
      }
      statements.push(`${indent}  } catch {`);
      statements.push(`${indent}    yield ${jsString(errorText)};`);
      statements.push(`${indent}  }`);
      statements.push(`${indent}}`);
      return statements;
    }
    statements.push(
      `${indent}  const ${thenName} = await ${expressionToScopeAccess(attrExpression(node, "value") ?? "undefined", locals)};`,
    );
    for (const child of node.children) {
      statements.push(...renderNodeYieldStatements(child, childLocals, `${indent}  `));
    }
    statements.push(`${indent}}`);
    return statements;
  }
  const hydrateId = attrExpression(node, "hydrate:id");
  const statements: string[] = [];
  if (hydrateId) {
    statements.push(
      `${indent}yield ${jsString("<!--tachyon-hydrate:")} + escapeMarker(${expressionToScopeAccess(
        hydrateId,
        locals,
      )}) + ${jsString(":start-->")};`,
    );
  }
  statements.push(`${indent}yield ${renderOpenTagExpression(node, locals)};`);
  for (const child of node.children) {
    statements.push(...renderNodeYieldStatements(child, locals, indent));
  }
  statements.push(`${indent}yield ${jsString(`</${node.tagName}>`)};`);
  if (hydrateId) {
    statements.push(
      `${indent}yield ${jsString("<!--tachyon-hydrate:")} + escapeMarker(${expressionToScopeAccess(
        hydrateId,
        locals,
      )}) + ${jsString(":end-->")};`,
    );
  }
  return statements;
};

const renderComponentYieldStatements = (node: ElementNode, locals: ReadonlySet<string>, indent: string): string[] => {
  const localNames = new Set(locals);
  const statements = [`${indent}{`];
  for (const attr of node.attrs) {
    if (attr.name === "name") {
      continue;
    }
    const expression = readExpressionAttribute(attr.value);
    if (expression) {
      statements.push(`${indent}  const ${attr.name} = ${expressionToScopeAccess(expression, localNames)};`);
      localNames.add(attr.name);
    }
  }
  for (const child of node.children) {
    if (child.type !== "element" || child.tagName !== "store") {
      continue;
    }
    for (const attr of child.attrs) {
      const initial = readExpressionAttribute(attr.value);
      if (initial) {
        statements.push(`${indent}  const ${attr.name} = ${expressionToScopeAccess(initial, localNames)};`);
        localNames.add(attr.name);
      }
    }
  }
  for (const child of node.children) {
    statements.push(...renderNodeYieldStatements(child, localNames, `${indent}  `));
  }
  statements.push(`${indent}}`);
  return statements;
};

const renderNodeYieldStatements = (node: TemplateNode, locals: ReadonlySet<string>, indent: string): string[] => {
  if (node.type === "text") {
    return renderTextYieldStatements(node, locals, indent);
  }
  return renderElementYieldStatements(node, locals, indent);
};

export const generateServerStreamModule = (template: CompiledTemplate): string => {
  const lines = [
    `const escapeHtml = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");`,
    `const escapeMarker = (value) => String(value ?? "").replaceAll("--", "- -").replaceAll(">", "&gt;");`,
    `export const stream = async function* (scope) {`,
    ...renderNodeYieldStatements(template.root, new Set(), "  "),
    `};`,
  ];
  return `${lines.join("\n")}\n`;
};
