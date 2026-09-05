import { err, ok, type Result } from "../../result.js";
import type { CompiledTemplate, CompilerError, ElementNode, TemplateNode, TextNode } from "../types.js";
import { generatedEscapeHtmlHelperLines } from "../../html-escape.js";
import { emptyTextMarker } from "../../text-marker.js";
import { generatedUrlAttributeHelperLines } from "../url-policy-codegen.js";
import {
  attrExpression,
  attrString,
  assertSafeIdentifierName,
  childPathEntries,
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
import { hasDynamicUrlAttribute, renderOpenTagExpression } from "./server.js";

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
    statements.push(
      `${indent}yield (escapeHtml(${expressionToScopeAccess(segment.value, locals)}) || ${jsString(emptyTextMarker)});`,
    );
    lastEmittedWasText = true;
  }
  return statements;
};

const renderForYieldStatements = (
  node: ElementNode,
  locals: ReadonlySet<string>,
  indent: string,
  path: number[],
): string[] => {
  const each = attrExpression(node, "each") ?? "[]";
  const key = attrExpression(node, "key") ?? "item";
  const itemName = attrString(node, "as")?.trim() || itemNameFromKey(key);
  const indexName = attrString(node, "index")?.trim();
  const eachAccess = expressionToScopeAccess(each, locals);
  const childLocals = new Set(locals);
  childLocals.add(itemName);
  if (indexName) childLocals.add(indexName);
  const statements = [
    `${indent}if (Array.isArray(${eachAccess})) {`,
    indexName
      ? `${indent}  for (const [${itemName}, ${indexName}] of ${eachAccess}.entries()) {`
      : `${indent}  for (const ${itemName} of ${eachAccess}) {`,
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

export type ServerStreamModuleOptions = {
  defaultScopeName?: string;
};

const unsupportedReorderError = (node: ElementNode): CompilerError => {
  const attribute = node.attrs.find((candidate) => candidate.name === "reorder");
  return {
    message: '<await reorder="resolve"> is not supported by the stream target; use reorder="preserve" or omit it.',
    offset: attribute?.start ?? node.start ?? 0,
    ...(attribute?.end === undefined ? {} : { endOffset: attribute.end }),
  };
};

const findUnsupportedReorder = (node: TemplateNode): CompilerError | undefined => {
  if (node.type === "text") return undefined;
  if (node.tagName === "await" && attrString(node, "reorder") === "resolve") {
    return unsupportedReorderError(node);
  }
  for (const child of node.children) {
    const error = findUnsupportedReorder(child);
    if (error) return error;
  }
  return undefined;
};

export const validateServerStreamTemplate = (template: CompiledTemplate): Result<void, CompilerError> => {
  const error = findUnsupportedReorder(template.root);
  return error ? err(error) : ok(undefined);
};

const streamModuleCache = new WeakMap<CompiledTemplate, Map<string, string>>();

export const generateServerStreamModule = (
  template: CompiledTemplate,
  options: ServerStreamModuleOptions = {},
): string => {
  if (options.defaultScopeName !== undefined) {
    assertSafeIdentifierName(options.defaultScopeName, "defaultScopeName");
  }
  const validation = validateServerStreamTemplate(template);
  if (!validation.ok) {
    const error = new Error(validation.error.message);
    Object.assign(error, validation.error);
    throw error;
  }
  const cacheKey = options.defaultScopeName ?? "";
  const cachedByOptions = streamModuleCache.get(template);
  const cached = cachedByOptions?.get(cacheKey);
  if (cached) {
    return cached;
  }
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
    ...generatedEscapeHtmlHelperLines,
    ...(hasDynamicUrlAttribute(template.root) ? generatedUrlAttributeHelperLines : []),
    `const escapeMarker = (value) => String(value ?? "").replaceAll("--", "- -").replaceAll(">", "&gt;");`,
    `export const stream = async function* (${options.defaultScopeName ? "inputScope = {}" : "scope"}) {`,
    ...(options.defaultScopeName
      ? [
          `  const localScope = typeof ${options.defaultScopeName} === "function" ? ${options.defaultScopeName}(inputScope) : ${options.defaultScopeName};`,
          `  const scope = localScope && typeof localScope === "object" ? { ...localScope, ...inputScope } : inputScope;`,
        ]
      : []),
    `  const __tachyonFlushBytes = 8192;`,
    `  const __tachyonTextEncoder = new TextEncoder();`,
    `  let __tachyonBuffer = "";`,
    `  let __tachyonBufferBytes = 0;`,
    `  const __tachyonPush = (chunk) => { const text = String(chunk ?? ""); __tachyonBuffer += text; __tachyonBufferBytes += __tachyonTextEncoder.encode(text).byteLength; };`,
    ...coalescedStatements,
    `  if (__tachyonBuffer) { yield __tachyonBuffer; }`,
    `};`,
  ];
  const code = `${lines.join("\n")}\n`;
  const nextCache = cachedByOptions ?? new Map<string, string>();
  nextCache.set(cacheKey, code);
  streamModuleCache.set(template, nextCache);
  return code;
};
