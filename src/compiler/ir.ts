import { err, ok, type Result } from "../result.js";
import { isDangerousAttributeName } from "../attribute-policy.js";
import { sanitizeElementUrlAttributes, sanitizeUrlAttributeValue, urlPurposeForAttribute } from "../url-policy.js";
import { isAssignableExpression, parseExpression } from "./expression.js";
import type {
  CompilerError,
  Attribute,
  ComponentProp,
  ElementNode,
  StoreDefinition,
  TemplateDirective,
  TemplateIr,
  TemplateNode,
} from "./types.js";
import {
  attrExpression,
  attrString,
  isSafeIdentifierName,
  hydrationBoundaryFor,
  identifierPattern,
  isKnownHydrationAttribute,
  itemNameFromKey,
  readExpressionAttribute,
  renderableChildren,
  textExpressionSegments,
} from "./utils.js";

type SourceSpan = { start: number | undefined; end: number | undefined };

const semanticError = (message: string, span?: SourceSpan): Result<never, CompilerError> =>
  err({
    message,
    offset: span?.start ?? 0,
    ...(span?.end === undefined ? {} : { endOffset: span.end }),
  });

const openingTagSpan = (node: ElementNode): SourceSpan => ({ start: node.start, end: node.openEnd });

const attributeSpan = (attribute: Attribute): SourceSpan => ({ start: attribute.start, end: attribute.end });

export const storeDefinitionsFor = (node: ElementNode): StoreDefinition[] => {
  const stores: StoreDefinition[] = [];
  for (const attr of node.attrs) {
    if (!identifierPattern.test(attr.name)) {
      continue;
    }
    const initial = readExpressionAttribute(attr.value);
    if (initial) {
      stores.push({ name: attr.name, initial });
    }
  }
  return stores;
};

const componentName = (node: ElementNode): string | undefined => attrString(node, "name");

const componentProps = (node: ElementNode): ComponentProp[] =>
  node.attrs
    .filter((attr) => attr.name !== "name")
    .flatMap((attr) => {
      const expression = readExpressionAttribute(attr.value);
      return expression ? [{ name: attr.name, expression }] : [];
    });

const componentStores = (node: ElementNode): StoreDefinition[] => {
  const stores: StoreDefinition[] = [];
  const visit = (child: TemplateNode): void => {
    if (child.type !== "element" || child.tagName === "component") {
      return;
    }
    if (child.tagName === "store") {
      stores.push(...storeDefinitionsFor(child));
      return;
    }
    child.children.forEach(visit);
  };
  node.children.forEach(visit);
  return stores;
};

const validateExpression = (expression: string, context: string, span: SourceSpan): Result<void, CompilerError> => {
  const parsed = parseExpression(expression);
  if (!parsed.ok) {
    if (parsed.error.message.includes("optional peer dependency")) {
      return semanticError(parsed.error.message, span);
    }
    return semanticError(`Invalid ${context} expression: ${expression}.`, span);
  }
  return ok(undefined);
};

const rawTextExpressionForbiddenTags = new Set(["script", "style"]);

const validateTextExpressions = (node: TemplateNode, insideRawTextTag?: string): Result<void, CompilerError> => {
  if (node.type === "text") {
    for (const segment of textExpressionSegments(node.value)) {
      if (segment.kind === "expression") {
        if (insideRawTextTag) {
          return semanticError(
            `Expressions inside <${insideRawTextTag}> are not supported; serialize data outside raw text.`,
            {
              start: (node.start ?? 0) + segment.start,
              end: (node.start ?? 0) + segment.end,
            },
          );
        }
        const result = validateExpression(segment.value, "text", {
          start: (node.start ?? 0) + segment.start,
          end: (node.start ?? 0) + segment.end,
        });
        if (!result.ok) {
          return result;
        }
      }
    }
    return ok(undefined);
  }
  const rawTextTag =
    insideRawTextTag ?? (rawTextExpressionForbiddenTags.has(node.tagName.toLowerCase()) ? node.tagName : undefined);
  for (const attr of node.attrs) {
    if (attr.name === "name") {
      continue;
    }
    const expression = readExpressionAttribute(attr.value);
    if (expression) {
      const result = validateExpression(expression, `${attr.name} attribute`, attributeSpan(attr));
      if (!result.ok) {
        return result;
      }
    }
  }
  for (const child of node.children) {
    const result = validateTextExpressions(child, rawTextTag);
    if (!result.ok) {
      return result;
    }
  }
  return ok(undefined);
};

const validateSpecialNode = (node: ElementNode): Result<void, CompilerError> => {
  if (node.tagName.toLowerCase() === "meta") {
    const httpEquiv = node.attrs.find((attr) => attr.name.toLowerCase() === "http-equiv");
    const content = node.attrs.find((attr) => attr.name.toLowerCase() === "content");
    const dynamicHttpEquiv = httpEquiv && readExpressionAttribute(httpEquiv.value);
    if (dynamicHttpEquiv && content) {
      return semanticError(
        "Dynamic meta refresh mode cannot be combined with content; use a static http-equiv value.",
        attributeSpan(httpEquiv),
      );
    }
    const staticAttributes = Object.fromEntries(
      node.attrs.flatMap((attr) =>
        attr.value === true || readExpressionAttribute(attr.value) ? [] : [[attr.name, attr.value]],
      ),
    );
    const sanitized = sanitizeElementUrlAttributes(node.tagName, staticAttributes);
    if (!sanitized.ok) {
      return semanticError(sanitized.error.message, content ? attributeSpan(content) : openingTagSpan(node));
    }
  }
  for (const attr of node.attrs) {
    if (!attr.name.startsWith("on:") && isDangerousAttributeName(attr.name)) {
      return semanticError(`Dangerous attribute is not supported: ${attr.name}.`, {
        start: attr.nameStart,
        end: attr.nameEnd,
      });
    }
    if (
      attr.value !== true &&
      !readExpressionAttribute(attr.value) &&
      urlPurposeForAttribute(node.tagName, attr.name)
    ) {
      try {
        sanitizeUrlAttributeValue(node.tagName, attr.name, attr.value);
      } catch (error) {
        return semanticError(error instanceof Error ? error.message : `Unsafe URL for ${attr.name}.`, {
          start: attr.valueStart,
          end: attr.valueEnd,
        });
      }
    }
  }
  if (node.tagName === "for") {
    const each = attrExpression(node, "each");
    const key = attrExpression(node, "key");
    if (!each) {
      return semanticError("<for> requires each={items}.", openingTagSpan(node));
    }
    if (!key) {
      return semanticError("<for> requires key={item.id}.", openingTagSpan(node));
    }
    for (const name of ["as", "index"] as const) {
      const attribute = node.attrs.find((candidate) => candidate.name === name);
      if (attribute && (typeof attribute.value !== "string" || !isSafeIdentifierName(attribute.value.trim()))) {
        return semanticError(`<for> ${name} must be a valid identifier string.`, attributeSpan(attribute));
      }
    }
    const itemName = attrString(node, "as")?.trim();
    const indexName = attrString(node, "index")?.trim();
    if (itemName && indexName && itemName === indexName) {
      return semanticError(
        "<for> as and index must be different identifiers.",
        attributeSpan(node.attrs.find((attr) => attr.name === "index") as Attribute),
      );
    }
  }
  if (node.tagName === "if" && !attrExpression(node, "test")) {
    return semanticError("<if> requires test={condition}.", openingTagSpan(node));
  }
  if (node.tagName === "component") {
    if (!componentName(node)) {
      return semanticError("<component> requires a string name attribute.", openingTagSpan(node));
    }
    for (const attr of node.attrs) {
      if (attr.name !== "name" && readExpressionAttribute(attr.value) && !isSafeIdentifierName(attr.name)) {
        return semanticError(`Invalid component prop binding name: ${attr.name}.`, attributeSpan(attr));
      }
    }
    if (renderableChildren(node).length !== 1) {
      return semanticError("<component> requires exactly one renderable root child.", openingTagSpan(node));
    }
  }
  if (node.tagName === "store") {
    for (const attr of node.attrs) {
      if (readExpressionAttribute(attr.value) && !isSafeIdentifierName(attr.name)) {
        return semanticError(`Invalid store binding name: ${attr.name}.`, attributeSpan(attr));
      }
    }
  }
  if (node.tagName === "await") {
    if (!attrExpression(node, "value")) {
      return semanticError("<await> requires value={promise}.", openingTagSpan(node));
    }
    const thenName = attrString(node, "then");
    if (!thenName) {
      return semanticError(`<await> requires then="name".`, openingTagSpan(node));
    }
    if (!isSafeIdentifierName(thenName)) {
      return semanticError(
        `Invalid await then binding: ${thenName}.`,
        attributeSpan(node.attrs.find((attr) => attr.name === "then") as Attribute),
      );
    }
    const reorder = attrString(node, "reorder");
    if (reorder && reorder !== "preserve" && reorder !== "resolve") {
      return semanticError(
        `<await> reorder must be "preserve" or "resolve".`,
        attributeSpan(node.attrs.find((attr) => attr.name === "reorder") as Attribute),
      );
    }
  }
  for (const attr of node.attrs) {
    if (attr.name.startsWith("hydrate:") && !isKnownHydrationAttribute(attr.name)) {
      return semanticError(`Unknown hydration attribute: ${attr.name}.`, attributeSpan(attr));
    }
    if (attr.name.startsWith("bind:")) {
      const expression = readExpressionAttribute(attr.value);
      if (!expression || !isAssignableExpression(expression)) {
        return semanticError(`${attr.name} requires an assignable expression.`, attributeSpan(attr));
      }
    }
  }
  return ok(undefined);
};

const validateTree = (node: TemplateNode, hydrateIds: Set<string>, insideFor = false): Result<void, CompilerError> => {
  const expressionResult = validateTextExpressions(node);
  if (!expressionResult.ok) {
    return expressionResult;
  }
  if (node.type === "text") {
    return ok(undefined);
  }
  const specialResult = validateSpecialNode(node);
  if (!specialResult.ok) {
    return specialResult;
  }
  const hydrateBoundary = hydrationBoundaryFor(node, []);
  if (insideFor && hydrateBoundary) {
    return semanticError("Row-local hydration metadata inside <for> is not supported.", openingTagSpan(node));
  }
  if (insideFor && (node.tagName === "component" || node.tagName === "store")) {
    return semanticError(`Row-local <${node.tagName}> metadata inside <for> is not supported.`, openingTagSpan(node));
  }
  if (hydrateBoundary && hydrateBoundary.idKind !== "static") {
    if (hydrateIds.has(hydrateBoundary.id)) {
      return semanticError(`Duplicate hydrate boundary id expression: ${hydrateBoundary.id}.`, openingTagSpan(node));
    }
    hydrateIds.add(hydrateBoundary.id);
  }
  const childInsideFor = insideFor || node.tagName === "for";
  for (const child of node.children) {
    const result = validateTree(child, hydrateIds, childInsideFor);
    if (!result.ok) {
      return result;
    }
  }
  return ok(undefined);
};

const collectDirectives = (node: TemplateNode, path: number[], directives: TemplateDirective[]): void => {
  if (node.type === "text") {
    return;
  }
  if (node.tagName === "store") {
    directives.push({ kind: "store", path: [...path], stores: storeDefinitionsFor(node) });
    return;
  }
  const isComponent = node.tagName === "component";
  if (isComponent) {
    directives.push({
      kind: "component",
      path: [...path],
      name: componentName(node) ?? "Anonymous",
      props: componentProps(node),
      stores: componentStores(node),
    });
  }
  const hydrateBoundary = hydrationBoundaryFor(node, path);
  if (hydrateBoundary) {
    directives.push({ kind: "hydrate", ...hydrateBoundary });
  }
  if (node.tagName === "if") {
    directives.push({ kind: "if", path: [...path], test: attrExpression(node, "test") ?? "false" });
  }
  if (node.tagName === "for") {
    const key = attrExpression(node, "key") ?? "item";
    const itemName = attrString(node, "as")?.trim() || itemNameFromKey(key);
    const indexName = attrString(node, "index")?.trim();
    directives.push({
      kind: "for",
      path: [...path],
      each: attrExpression(node, "each") ?? "[]",
      key,
      itemName,
      ...(indexName ? { indexName } : {}),
    });
  }
  if (node.tagName === "await") {
    const fallback = attrString(node, "fallback");
    const errorText = attrString(node, "error");
    const reorder = attrString(node, "reorder");
    directives.push({
      kind: "await",
      path: [...path],
      value: attrExpression(node, "value") ?? "undefined",
      thenName: attrString(node, "then") ?? "value",
      ...(fallback ? { fallback } : {}),
      ...(errorText ? { error: errorText } : {}),
      ...(reorder === "preserve" || reorder === "resolve" ? { reorder } : {}),
    });
  }
  for (const attr of node.attrs) {
    if (!attr.name.startsWith("on:")) {
      continue;
    }
    const handler = readExpressionAttribute(attr.value);
    if (handler) {
      directives.push({ kind: "event", path: [...path], eventName: attr.name.slice(3), handler });
    }
  }
  const children = isComponent ? renderableChildren(node) : node.children;
  children.forEach((child, index) => {
    const childPath = isComponent && children.length === 1 ? path : [...path, index];
    collectDirectives(child, childPath, directives);
  });
};

export const createTemplateIr = (root: ElementNode): Result<TemplateIr, CompilerError> => {
  const validationResult = validateTree(root, new Set());
  if (!validationResult.ok) {
    return err(validationResult.error);
  }
  const directives: TemplateDirective[] = [];
  if (root.tagName === "component" || root.tagName === "for" || root.tagName === "if" || root.tagName === "await") {
    collectDirectives(root, [], directives);
  } else {
    root.children.forEach((child, index) => collectDirectives(child, [index], directives));
  }
  return ok({ kind: "template", root, directives });
};
