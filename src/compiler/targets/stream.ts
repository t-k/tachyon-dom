import type { CompiledTemplate, ElementNode, TemplateNode, TextNode } from "../types.js";
import {
  attrExpression,
  attrString,
  expressionToScopeAccess,
  hydrationBoundaryFor,
  isVoidElement,
  itemNameFromKey,
  jsOptionalPropertyAccess,
  jsString,
  readExpressionAttribute,
  renderableChildren,
  textExpressionSegments,
} from "../utils.js";
import { renderOpenTagExpression } from "./server.js";

const renderTextYieldStatements = (node: TextNode, locals: ReadonlySet<string>, indent: string): string[] => {
  const statements: string[] = [];
  let lastEmittedWasText = false;
  const separateTextNode = (): void => {
    if (lastEmittedWasText) {
      statements.push(`${indent}yield "<!---->";`);
    }
  };
  for (const segment of textExpressionSegments(node.value)) {
    if (segment.kind === "text") {
      if (segment.value) {
        separateTextNode();
        statements.push(`${indent}yield ${jsString(segment.value)};`);
        lastEmittedWasText = true;
      }
      continue;
    }
    separateTextNode();
    statements.push(`${indent}yield escapeHtml(${expressionToScopeAccess(segment.value, locals)});`);
    lastEmittedWasText = true;
  }
  return statements;
};

const childPathEntries = (
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

const renderForYieldStatements = (
  node: ElementNode,
  locals: ReadonlySet<string>,
  indent: string,
  path: number[],
): string[] => {
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
  for (const entry of childPathEntries(node.children, path)) {
    statements.push(...renderNodeYieldStatements(entry.child, childLocals, `${indent}    `, entry.path));
  }
  statements.push(`${indent}  }`, `${indent}}`);
  return statements;
};

const renderElementYieldStatements = (
  node: ElementNode,
  locals: ReadonlySet<string>,
  indent: string,
  path: number[],
): string[] => {
  if (node.tagName === "outlet") {
    return [`${indent}yield String(scope.outlet ?? "");`];
  }
  if (node.tagName === "slot") {
    return [
      `${indent}yield String(${jsOptionalPropertyAccess("scope.slots", attrString(node, "name") ?? "default")} ?? "");`,
    ];
  }
  if (node.tagName === "for") {
    return renderForYieldStatements(node, locals, indent, path);
  }
  if (node.tagName === "if") {
    const statements = [`${indent}if (${expressionToScopeAccess(attrExpression(node, "test") ?? "false", locals)}) {`];
    for (const entry of childPathEntries(node.children, path)) {
      statements.push(...renderNodeYieldStatements(entry.child, locals, `${indent}  `, entry.path));
    }
    statements.push(`${indent}}`);
    return statements;
  }
  if (node.tagName === "store") {
    return [];
  }
  if (node.tagName === "component") {
    return renderComponentYieldStatements(node, locals, indent, path);
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
      for (const entry of childPathEntries(node.children, path)) {
        statements.push(...renderNodeYieldStatements(entry.child, childLocals, `${indent}    `, entry.path));
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
    for (const entry of childPathEntries(node.children, path)) {
      statements.push(...renderNodeYieldStatements(entry.child, childLocals, `${indent}  `, entry.path));
    }
    statements.push(`${indent}}`);
    return statements;
  }
  const hydrateBoundary = hydrationBoundaryFor(node, path);
  const statements: string[] = [];
  if (hydrateBoundary) {
    const marker =
      hydrateBoundary.idKind === "static"
        ? jsString(hydrateBoundary.id)
        : expressionToScopeAccess(hydrateBoundary.id, locals);
    statements.push(
      `${indent}yield ${jsString("<!--tachyon-hydrate:")} + escapeMarker(${marker}) + ${jsString(":start-->")};`,
    );
  }
  statements.push(`${indent}yield ${renderOpenTagExpression(node, locals)};`);
  for (const entry of childPathEntries(node.children, path)) {
    statements.push(...renderNodeYieldStatements(entry.child, locals, indent, entry.path));
  }
  if (!isVoidElement(node)) {
    statements.push(`${indent}yield ${jsString(`</${node.tagName}>`)};`);
  }
  if (hydrateBoundary) {
    const marker =
      hydrateBoundary.idKind === "static"
        ? jsString(hydrateBoundary.id)
        : expressionToScopeAccess(hydrateBoundary.id, locals);
    statements.push(
      `${indent}yield ${jsString("<!--tachyon-hydrate:")} + escapeMarker(${marker}) + ${jsString(":end-->")};`,
    );
  }
  return statements;
};

const renderComponentYieldStatements = (
  node: ElementNode,
  locals: ReadonlySet<string>,
  indent: string,
  path: number[],
): string[] => {
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
  const children = renderableChildren(node);
  if (children.length === 1) {
    statements.push(...renderNodeYieldStatements(children[0] as TemplateNode, localNames, `${indent}  `, path));
  } else {
    for (const [index, child] of children.entries()) {
      statements.push(...renderNodeYieldStatements(child, localNames, `${indent}  `, [...path, index]));
    }
  }
  statements.push(`${indent}}`);
  return statements;
};

const renderNodeYieldStatements = (
  node: TemplateNode,
  locals: ReadonlySet<string>,
  indent: string,
  path: number[] = [],
): string[] => {
  if (node.type === "text") {
    return renderTextYieldStatements(node, locals, indent);
  }
  return renderElementYieldStatements(node, locals, indent, path);
};

export const generateServerStreamModule = (template: CompiledTemplate): string => {
  const coalescedStatements = renderNodeYieldStatements(template.root, new Set(), "  ").flatMap((line) => {
    const yieldMatch = /^(\s*)yield (.*);$/.exec(line);
    if (yieldMatch) {
      return [
        `${yieldMatch[1]}__tachyonPush(${yieldMatch[2]});`,
        `${yieldMatch[1]}if (__tachyonBufferBytes >= __tachyonFlushBytes) { yield __tachyonBuffer; __tachyonBuffer = ""; __tachyonBufferBytes = 0; }`,
      ];
    }
    if (line.includes(" await ")) {
      const indent = line.match(/^\s*/)?.[0] ?? "";
      return [
        `${indent}if (__tachyonBuffer) { yield __tachyonBuffer; __tachyonBuffer = ""; __tachyonBufferBytes = 0; }`,
        line,
      ];
    }
    return [line];
  });
  const lines = [
    `const HTML_ESCAPE = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };`,
    `const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => HTML_ESCAPE[char]);`,
    `const escapeMarker = (value) => String(value ?? "").replaceAll("--", "- -").replaceAll(">", "&gt;");`,
    `export const stream = async function* (scope) {`,
    `  const __tachyonEncoder = new TextEncoder();`,
    `  const __tachyonFlushBytes = 8192;`,
    `  let __tachyonBuffer = "";`,
    `  let __tachyonBufferBytes = 0;`,
    `  const __tachyonPush = (chunk) => { const text = String(chunk ?? ""); __tachyonBuffer += text; __tachyonBufferBytes += __tachyonEncoder.encode(text).byteLength; };`,
    ...coalescedStatements,
    `  if (__tachyonBuffer) { yield __tachyonBuffer; }`,
    `};`,
  ];
  return `${lines.join("\n")}\n`;
};
