import type { CompiledTemplate, ElementNode, TemplateNode, TextNode } from "../types.js";
import {
  attrExpression,
  attrString,
  escapeHtml,
  escapeMarker,
  expressionToScopeAccess,
  hydrationBoundaryFor,
  isHydrationAttribute,
  jsOptionalPropertyAccess,
  jsString,
  itemNameFromKey,
  readExpressionAttribute,
  readPath,
  renderableChildren,
  serializeStaticAttr,
  textExpressionSegments,
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

const renderText = (node: TextNode, scope: Record<string, unknown>): string => {
  let output = "";
  for (const segment of textExpressionSegments(node.value)) {
    if (segment.kind === "text") {
      output += segment.value;
      continue;
    }
    output += escapeHtml(readPath(scope, segment.value));
  }
  return output;
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

const renderFor = (node: ElementNode, scope: Record<string, unknown>, path: number[]): string => {
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
      return childPathEntries(node.children, path)
        .map((entry) => renderNode(entry.child, childScope, entry.path))
        .join("");
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
    return readPath(scope, attrExpression(node, "test") ?? "false")
      ? node.children.map((child) => renderNode(child, scope)).join("")
      : "";
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
    return children.map((child, index) => renderNode(child, next, [...path, index])).join("");
  }
  if (node.tagName === "await") {
    const thenName = attrString(node, "then") ?? "value";
    const value = readPath(scope, attrExpression(node, "value") ?? "undefined");
    return node.children.map((child) => renderNode(child, { ...scope, [thenName]: value })).join("");
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
  if (styles.length > 0) {
    attrs.push(` style="${escapeHtml(styles.join(";"))}"`);
  }
  const children = childPathEntries(node.children, path)
    .map((entry) => renderNode(entry.child, scope, entry.path))
    .join("");
  const html = `<${node.tagName}${attrs.join("")}>${children}</${node.tagName}>`;
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

export const renderServerTemplate = (template: CompiledTemplate, scope: Record<string, unknown>): string =>
  renderElement(template.root, scope);

const renderTextExpression = (node: TextNode, locals: ReadonlySet<string> = new Set()): string => {
  const parts: string[] = [];
  for (const segment of textExpressionSegments(node.value)) {
    if (segment.kind === "text") {
      if (segment.value) {
        parts.push(jsString(segment.value));
      }
      continue;
    }
    parts.push(`escapeHtml(${expressionToScopeAccess(segment.value, locals)})`);
  }
  return parts.length > 0 ? parts.join(" + ") : `""`;
};

export const renderOpenTagExpression = (node: ElementNode, locals: ReadonlySet<string>): string => {
  const parts: string[] = [jsString(`<${node.tagName}`)];
  const staticClasses: string[] = [];
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
  if (dynamicStyles.length > 0) {
    const styleExpression = dynamicStyles.join(" + ");
    parts.push(
      `(${styleExpression} ? ${jsString(` style="`)} + (${styleExpression}).replace(/;$/, "") + ${jsString(`"`)} : "")`,
    );
  }

  parts.push(jsString(">"));
  return parts.join(" + ");
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
  const itemName = itemNameFromKey(key);
  const eachAccess = expressionToScopeAccess(each, locals);
  const childLocals = new Set(locals);
  childLocals.add(itemName);
  const childExpression = childPathEntries(node.children, path)
    .map((entry) => renderNodeExpression(entry.child, childLocals, entry.path))
    .join(" + ");
  return `(Array.isArray(${eachAccess}) ? ${eachAccess}.map((${itemName}) => ${childExpression || `""`}).join("") : "")`;
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
    const childExpression = childPathEntries(node.children, path)
      .map((entry) => renderNodeExpression(entry.child, locals, entry.path))
      .join(" + ");
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
    const childExpression = childPathEntries(node.children, path)
      .map((entry) => renderNodeExpression(entry.child, childLocals, entry.path))
      .join(" + ");
    return `(((${thenName}) => ${childExpression || `""`})(${value}))`;
  }

  const parts: string[] = [renderOpenTagExpression(node, locals)];
  parts.push(
    ...childPathEntries(node.children, path).map((entry) => renderNodeExpression(entry.child, locals, entry.path)),
  );
  parts.push(jsString(`</${node.tagName}>`));
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

export const generateServerModule = (template: CompiledTemplate): string => {
  const lines = [
    `const escapeHtml = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");`,
    `const escapeMarker = (value) => String(value ?? "").replaceAll("--", "- -").replaceAll(">", "&gt;");`,
    `const escapeScriptJson = (value) => value.replaceAll("<", "\\\\u003c").replaceAll("-->", "--\\\\>");`,
    `const escapeAttribute = (value) => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");`,
    `export const hydrationBoundaries = ${JSON.stringify(template.client.hydrationBoundaries)};`,
    `export const renderHydrationState = (id, state) => '<script type="application/json" data-tachyon-state="' + escapeAttribute(id) + '">' + escapeScriptJson(JSON.stringify(state)) + '</script>';`,
    `export const render = (scope) => ${renderElementExpression(template.root)};`,
  ];
  return `${lines.join("\n")}\n`;
};
