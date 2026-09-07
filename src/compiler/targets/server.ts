import type { CompiledTemplate, ElementNode, TemplateNode, TextNode } from "../types.js";
import { generatedEscapeHtmlHelperLines } from "../../html-escape.js";
import { emptyTextMarker } from "../../text-marker.js";
import { sanitizeMetaRefreshContent, sanitizeUrlAttributeValue, urlPurposeForAttribute } from "../../url-policy.js";
import { generatedUrlAttributeHelperLines } from "../url-policy-codegen.js";
import {
  attrExpression,
  attrString,
  assertSafeIdentifierName,
  childPathEntries,
  listBoundaryMarker,
  listNeedsBoundaryMarker,
  escapeHtml,
  escapeMarker,
  expressionToScopeAccess,
  hydrationBoundaryFor,
  isHydrationAttribute,
  isVoidElement,
  jsOptionalPropertyAccess,
  jsString,
  itemNameFromKey,
  readExpressionAttribute,
  readPath,
  renderableChildren,
  serializeStaticAttr,
  textExpressionSegments,
  transparentListRootFor,
} from "../utils.js";

const componentScope = (node: ElementNode, scope: Record<string, unknown>): Record<string, unknown> => {
  const next = { ...scope };
  for (const attr of node.attrs) {
    if (attr.name === "name") {
      continue;
    }
    const expression = readExpressionAttribute(attr.value);
    if (expression) {
      next[attr.name] = readPath(next, expression);
    }
  }
  const applyStores = (child: TemplateNode): void => {
    if (child.type !== "element" || child.tagName !== "store") {
      if (child.type === "element" && child.tagName !== "component") {
        child.children.forEach(applyStores);
      }
      return;
    }
    for (const attr of child.attrs) {
      const initial = readExpressionAttribute(attr.value);
      if (initial) {
        next[attr.name] = readPath(next, initial);
      }
    }
  };
  node.children.forEach(applyStores);
  return next;
};

const renderChildren = (
  children: readonly TemplateNode[],
  scope: Record<string, unknown>,
  path: readonly number[],
): string =>
  childPathEntries(children, path)
    .map(
      (entry, index) =>
        `${renderNode(entry.child, scope, entry.path)}${
          transparentListRootFor(entry.child) && listNeedsBoundaryMarker(children, index) ? listBoundaryMarker : ""
        }`,
    )
    .join("");

const renderChildExpressions = (
  children: readonly TemplateNode[],
  locals: ReadonlySet<string>,
  path: readonly number[],
): string =>
  childPathEntries(children, path)
    .map((entry, index) => {
      const marker =
        transparentListRootFor(entry.child) && listNeedsBoundaryMarker(children, index)
          ? ` + ${jsString(listBoundaryMarker)}`
          : "";
      return `${renderNodeExpression(entry.child, locals, entry.path)}${marker}`;
    })
    .join(" + ");

const hasStaticMetaRefreshMode = (node: ElementNode): boolean =>
  node.tagName.toLowerCase() === "meta" &&
  node.attrs.some(
    (attribute) =>
      attribute.name.toLowerCase() === "http-equiv" &&
      attribute.value !== true &&
      !readExpressionAttribute(attribute.value) &&
      attribute.value.trim().toLowerCase() === "refresh",
  );

const sanitizeDynamicAttributeValue = (node: ElementNode, name: string, value: unknown): unknown => {
  if (hasStaticMetaRefreshMode(node) && name.toLowerCase() === "content") {
    const result = sanitizeMetaRefreshContent(String(value));
    if (!result.ok) throw result.error;
    return result.value;
  }
  return urlPurposeForAttribute(node.tagName, name)
    ? sanitizeUrlAttributeValue(node.tagName, name, String(value))
    : value;
};

const renderText = (node: TextNode, scope: Record<string, unknown>): string => {
  let output = "";
  let lastEmittedWasText = false;
  const separateTextNode = (): void => {
    if (lastEmittedWasText) {
      output += "<!---->";
    }
  };
  for (const segment of textExpressionSegments(node.value)) {
    if (segment.kind === "text") {
      if (!segment.value) {
        continue;
      }
      separateTextNode();
      output += segment.value;
      lastEmittedWasText = true;
      continue;
    }
    separateTextNode();
    output += escapeHtml(readPath(scope, segment.value)) || emptyTextMarker;
    lastEmittedWasText = true;
  }
  return output;
};

const renderFor = (node: ElementNode, scope: Record<string, unknown>, path: number[]): string => {
  const each = attrExpression(node, "each");
  const key = attrExpression(node, "key") ?? "item";
  const itemName = attrString(node, "as")?.trim() || itemNameFromKey(key);
  const indexName = attrString(node, "index")?.trim();
  const items = each ? readPath(scope, each) : undefined;
  if (!Array.isArray(items)) {
    return "";
  }
  return items
    .map((item, index) => {
      const childScope = { ...scope, [itemName]: item, ...(indexName ? { [indexName]: index } : {}) };
      return renderChildren(node.children, childScope, path);
    })
    .join("");
};

const renderElement = (node: ElementNode, scope: Record<string, unknown>, path: number[] = []): string => {
  if (node.tagName === "outlet") {
    return String(scope.outlet ?? "");
  }
  if (node.tagName === "slot") {
    const slots = scope.slots;
    const name = attrString(node, "name") ?? "default";
    return slots && typeof slots === "object" ? String((slots as Record<string, unknown>)[name] ?? "") : "";
  }
  if (node.tagName === "for") {
    return renderFor(node, scope, path);
  }
  if (node.tagName === "if") {
    return readPath(scope, attrExpression(node, "test") ?? "false") ? renderChildren(node.children, scope, path) : "";
  }
  if (node.tagName === "store") {
    return "";
  }
  if (node.tagName === "component") {
    const next = componentScope(node, scope);
    const children = renderableChildren(node);
    if (children.length === 1) {
      return renderNode(children[0] as TemplateNode, next, path);
    }
    return renderChildren(children, next, path);
  }
  if (node.tagName === "await") {
    const thenName = attrString(node, "then") ?? "value";
    const value = readPath(scope, attrExpression(node, "value") ?? "undefined");
    return renderChildren(node.children, { ...scope, [thenName]: value }, path);
  }

  const attrs: string[] = [];
  const classes: string[] = [];
  const styles: string[] = [];
  const hydrateBoundary = hydrationBoundaryFor(node, path);
  for (const attr of node.attrs) {
    if (
      attr.name.startsWith("on:") ||
      attr.name.startsWith("bind:") ||
      attr.name === "ref" ||
      isHydrationAttribute(attr.name)
    ) {
      continue;
    }
    if (attr.name.startsWith("style:")) {
      const expression = readExpressionAttribute(attr.value);
      const value = expression ? readPath(scope, expression) : undefined;
      if (value != null && value !== false) {
        styles.push(`${attr.name.slice(6)}:${String(value)}`);
      }
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
      const expression = readExpressionAttribute(attr.value);
      const value = expression ? readPath(scope, expression) : attr.value;
      if (value != null && value !== false) {
        classes.push(String(value));
      }
      continue;
    }
    const expression = readExpressionAttribute(attr.value);
    if (expression) {
      const value = readPath(scope, expression);
      if (value != null && value !== false) {
        const safeValue = sanitizeDynamicAttributeValue(node, attr.name, value);
        attrs.push(` ${attr.name}="${escapeHtml(safeValue)}"`);
      }
      continue;
    }
    attrs.push(serializeStaticAttr(attr));
  }
  if (classes.length > 0) {
    attrs.unshift(` class="${escapeHtml(classes.join(" "))}"`);
  }
  if (styles.length > 0) {
    attrs.push(` style="${escapeHtml(styles.join(";"))}"`);
  }
  const html = isVoidElement(node)
    ? `<${node.tagName}${attrs.join("")}>`
    : `<${node.tagName}${attrs.join("")}>${renderChildren(node.children, scope, path)}</${node.tagName}>`;
  if (!hydrateBoundary) {
    return html;
  }
  const marker = escapeMarker(
    hydrateBoundary.idKind === "static" ? hydrateBoundary.id : readPath(scope, hydrateBoundary.id),
  );
  return `<!--tachyon-hydrate:${marker}:start-->${html}<!--tachyon-hydrate:${marker}:end-->`;
};

const renderNode = (node: TemplateNode, scope: Record<string, unknown>, path: number[] = []): string => {
  if (node.type === "text") {
    return renderText(node, scope);
  }
  return renderElement(node, scope, path);
};

const renderTextExpression = (node: TextNode, locals: ReadonlySet<string> = new Set()): string => {
  const parts: string[] = [];
  let lastEmittedWasText = false;
  const separateTextNode = (): void => {
    if (lastEmittedWasText) {
      parts.push(jsString("<!---->"));
    }
  };
  for (const segment of textExpressionSegments(node.value)) {
    if (segment.kind === "text") {
      if (segment.value) {
        separateTextNode();
        parts.push(jsString(segment.value));
        lastEmittedWasText = true;
      }
      continue;
    }
    separateTextNode();
    parts.push(`(escapeHtml(${expressionToScopeAccess(segment.value, locals)}) || ${jsString(emptyTextMarker)})`);
    lastEmittedWasText = true;
  }
  return parts.length > 0 ? parts.join(" + ") : `""`;
};

const foldStaticExpressionParts = (parts: string[]): string[] => {
  const folded: string[] = [];
  let pending = "";
  const flush = (): void => {
    if (pending) {
      folded.push(jsString(pending));
      pending = "";
    }
  };
  for (const part of parts) {
    if (part.startsWith(`"`) && part.endsWith(`"`)) {
      pending += JSON.parse(part) as string;
      continue;
    }
    flush();
    folded.push(part);
  }
  flush();
  return folded;
};

export const renderOpenTagExpression = (node: ElementNode, locals: ReadonlySet<string>): string => {
  const parts: string[] = [jsString(`<${node.tagName}`)];
  const staticClasses: string[] = [];
  const dynamicBaseClasses: string[] = [];
  const dynamicClasses: string[] = [];
  const dynamicStyles: string[] = [];

  for (const attr of node.attrs) {
    if (
      attr.name.startsWith("on:") ||
      attr.name.startsWith("bind:") ||
      attr.name === "ref" ||
      isHydrationAttribute(attr.name)
    ) {
      continue;
    }
    if (attr.name.startsWith("style:")) {
      const expression = readExpressionAttribute(attr.value);
      if (expression) {
        const value = expressionToScopeAccess(expression, locals);
        dynamicStyles.push(
          `(${value} == null || ${value} === false ? "" : ${jsString(`${attr.name.slice(6)}:`)} + escapeHtml(${value}) + ${jsString(";")})`,
        );
      }
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
      const expression = readExpressionAttribute(attr.value);
      if (expression) {
        const value = expressionToScopeAccess(expression, locals);
        dynamicBaseClasses.push(`(${value} == null || ${value} === false ? "" : " " + String(${value}))`);
      } else {
        staticClasses.push(attr.value);
      }
      continue;
    }
    const expression = readExpressionAttribute(attr.value);
    if (expression) {
      const value = expressionToScopeAccess(expression, locals);
      const safeValue =
        hasStaticMetaRefreshMode(node) && attr.name.toLowerCase() === "content"
          ? `__tachyonSafeMetaRefreshContent(${value})`
          : urlPurposeForAttribute(node.tagName, attr.name)
            ? `__tachyonSafeUrlAttribute(${jsString(node.tagName)}, ${jsString(attr.name)}, ${value})`
            : value;
      parts.push(
        `(${value} == null || ${value} === false ? "" : ${jsString(` ${attr.name}="`)} + escapeHtml(${safeValue}) + ${jsString(`"`)} )`,
      );
      continue;
    }
    parts.push(jsString(serializeStaticAttr(attr)));
  }

  if (staticClasses.length > 0 || dynamicBaseClasses.length > 0 || dynamicClasses.length > 0) {
    const classExpression = `${jsString(staticClasses.join(" "))}${
      dynamicBaseClasses.length > 0 ? ` + ${dynamicBaseClasses.join(" + ")}` : ""
    }${dynamicClasses.length > 0 ? ` + ${dynamicClasses.join(" + ")}` : ""}`;
    parts.splice(
      1,
      0,
      dynamicBaseClasses.length === 0 && dynamicClasses.length === 0
        ? jsString(` class="${staticClasses.join(" ")}"`)
        : `((value) => value ? ${jsString(` class="`)} + escapeHtml(value.trim()) + ${jsString(`"`)} : "")(${classExpression})`,
    );
  }
  if (dynamicStyles.length > 0) {
    const styleExpression = dynamicStyles.join(" + ");
    parts.push(
      `(${styleExpression} ? ${jsString(` style="`)} + (${styleExpression}).replace(/;$/, "") + ${jsString(`"`)} : "")`,
    );
  }

  parts.push(jsString(">"));
  return foldStaticExpressionParts(parts).join(" + ");
};

export const renderNodeExpression = (
  node: TemplateNode,
  locals: ReadonlySet<string> = new Set(),
  path: number[] = [],
): string => {
  if (node.type === "text") {
    return renderTextExpression(node, locals);
  }
  return renderElementExpression(node, locals, path);
};

const renderForExpression = (node: ElementNode, locals: ReadonlySet<string>, path: number[]): string => {
  const each = attrExpression(node, "each") ?? "[]";
  const key = attrExpression(node, "key") ?? "item";
  const itemName = attrString(node, "as")?.trim() || itemNameFromKey(key);
  const indexName = attrString(node, "index")?.trim();
  const eachAccess = expressionToScopeAccess(each, locals);
  const childLocals = new Set(locals);
  childLocals.add(itemName);
  if (indexName) childLocals.add(indexName);
  const childExpression = renderChildExpressions(node.children, childLocals, path);
  const callbackParameters = indexName ? `(${itemName}, ${indexName})` : `(${itemName})`;
  return `(Array.isArray(${eachAccess}) ? ${eachAccess}.map(${callbackParameters} => ${childExpression || `""`}).join("") : "")`;
};

const renderElementExpression = (
  node: ElementNode,
  locals: ReadonlySet<string> = new Set(),
  path: number[] = [],
): string => {
  if (node.tagName === "outlet") {
    return `String(scope.outlet ?? "")`;
  }
  if (node.tagName === "slot") {
    const name = attrString(node, "name") ?? "default";
    return `String(${jsOptionalPropertyAccess("scope.slots", name)} ?? "")`;
  }
  if (node.tagName === "for") {
    return renderForExpression(node, locals, path);
  }
  if (node.tagName === "if") {
    const test = expressionToScopeAccess(attrExpression(node, "test") ?? "false", locals);
    const childExpression = renderChildExpressions(node.children, locals, path);
    return `(${test} ? ${childExpression || `""`} : "")`;
  }
  if (node.tagName === "store") {
    return `""`;
  }
  if (node.tagName === "component") {
    return renderComponentExpression(node, locals, path);
  }
  if (node.tagName === "await") {
    const value = expressionToScopeAccess(attrExpression(node, "value") ?? "undefined", locals);
    const thenName = attrString(node, "then") ?? "value";
    const childLocals = new Set(locals);
    childLocals.add(thenName);
    const childExpression = renderChildExpressions(node.children, childLocals, path);
    return `(((${thenName}) => ${childExpression || `""`})(${value}))`;
  }

  const parts: string[] = [renderOpenTagExpression(node, locals)];
  const childExpression = renderChildExpressions(node.children, locals, path);
  if (childExpression) parts.push(childExpression);
  if (!isVoidElement(node)) {
    parts.push(jsString(`</${node.tagName}>`));
  }
  const expression = parts.join(" + ");
  const hydrateBoundary = hydrationBoundaryFor(node, path);
  if (!hydrateBoundary) {
    return expression;
  }
  const marker =
    hydrateBoundary.idKind === "static"
      ? jsString(hydrateBoundary.id)
      : expressionToScopeAccess(hydrateBoundary.id, locals);
  return `${jsString("<!--tachyon-hydrate:")} + escapeMarker(${marker}) + ${jsString(":start-->")} + ${expression} + ${jsString("<!--tachyon-hydrate:")} + escapeMarker(${marker}) + ${jsString(":end-->")}`;
};

const renderComponentExpression = (node: ElementNode, locals: ReadonlySet<string>, path: number[]): string => {
  const localNames = new Set(locals);
  const declarations: string[] = [];
  for (const attr of node.attrs) {
    if (attr.name === "name") {
      continue;
    }
    const expression = readExpressionAttribute(attr.value);
    if (expression) {
      declarations.push(`const ${attr.name} = ${expressionToScopeAccess(expression, localNames)};`);
      localNames.add(attr.name);
    }
  }
  const applyStoreDeclarations = (child: TemplateNode): void => {
    if (child.type !== "element" || child.tagName !== "store") {
      if (child.type === "element" && child.tagName !== "component") {
        child.children.forEach(applyStoreDeclarations);
      }
      return;
    }
    for (const attr of child.attrs) {
      const initial = readExpressionAttribute(attr.value);
      if (initial) {
        declarations.push(`const ${attr.name} = ${expressionToScopeAccess(initial, localNames)};`);
        localNames.add(attr.name);
      }
    }
  };
  node.children.forEach(applyStoreDeclarations);
  const children = renderableChildren(node);
  const expression =
    children.length === 1
      ? renderNodeExpression(children[0] as TemplateNode, localNames, path)
      : children.map((child, index) => renderNodeExpression(child, localNames, [...path, index])).join(" + ") || `""`;
  return `(() => { ${declarations.join(" ")} return ${expression}; })()`;
};

export type ServerModuleOptions = {
  defaultScopeName?: string;
};

const serverModuleCache = new WeakMap<CompiledTemplate, Map<string, string>>();

export const hasDynamicUrlAttribute = (node: TemplateNode): boolean =>
  node.type === "element" &&
  (node.attrs.some(
    (attribute) =>
      Boolean(readExpressionAttribute(attribute.value)) &&
      (urlPurposeForAttribute(node.tagName, attribute.name) !== undefined ||
        (hasStaticMetaRefreshMode(node) && attribute.name.toLowerCase() === "content")),
  ) ||
    node.children.some(hasDynamicUrlAttribute));

export const generateServerModule = (template: CompiledTemplate, options: ServerModuleOptions = {}): string => {
  if (options.defaultScopeName !== undefined) {
    assertSafeIdentifierName(options.defaultScopeName, "defaultScopeName");
  }
  const cacheKey = options.defaultScopeName ?? "";
  const cachedByOptions = serverModuleCache.get(template);
  const cached = cachedByOptions?.get(cacheKey);
  if (cached) {
    return cached;
  }
  const renderExpression = renderElementExpression(template.root);
  const render = options.defaultScopeName
    ? [
        `export const render = (inputScope = {}) => {`,
        `  const localScope = typeof ${options.defaultScopeName} === "function" ? ${options.defaultScopeName}(inputScope) : ${options.defaultScopeName};`,
        `  const scope = localScope && typeof localScope === "object" ? { ...localScope, ...inputScope } : inputScope;`,
        `  return ${renderExpression};`,
        `};`,
      ]
    : [`export const render = (scope) => ${renderExpression};`];
  const lines = [
    ...generatedEscapeHtmlHelperLines,
    ...(hasDynamicUrlAttribute(template.root) ? generatedUrlAttributeHelperLines : []),
    `const escapeMarker = (value) => String(value ?? "").replaceAll("--", "- -").replaceAll(">", "&gt;");`,
    `const escapeScriptJson = (value) => value.replaceAll("<", "\\\\u003c").replaceAll(">", "\\\\u003e");`,
    `const ATTRIBUTE_ESCAPE = { "&": "&amp;", '"': "&quot;", "<": "&lt;" };`,
    `const escapeAttribute = (value) => String(value).replace(/[&"<]/g, (char) => ATTRIBUTE_ESCAPE[char]);`,
    `export const hydrationBoundaries = ${JSON.stringify(template.client.hydrationBoundaries)};`,
    `export const renderHydrationState = (id, state) => '<script type="application/json" data-tachyon-state="' + escapeAttribute(id) + '">' + escapeScriptJson(JSON.stringify(state) ?? "null") + '</script>';`,
    ...render,
  ];
  const code = `${lines.join("\n")}\n`;
  const nextCache = cachedByOptions ?? new Map<string, string>();
  nextCache.set(cacheKey, code);
  serverModuleCache.set(template, nextCache);
  return code;
};

export type ServerRenderer = (scope: Record<string, unknown>) => string;

const serverRendererCache = new WeakMap<CompiledTemplate, ServerRenderer>();

export const compileServerTemplate = (template: CompiledTemplate): ServerRenderer => {
  const cached = serverRendererCache.get(template);
  if (cached) {
    return cached;
  }
  const root = structuredClone(template.root);
  const renderer: ServerRenderer = (scope) => renderNode(root, scope);
  serverRendererCache.set(template, renderer);
  return renderer;
};

export const renderServerTemplate = (template: CompiledTemplate, scope: Record<string, unknown>): string =>
  compileServerTemplate(template)(scope);
