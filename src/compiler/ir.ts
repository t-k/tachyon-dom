import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { err, ok, type Result } from "../result.js";
import { isDangerousAttributeName } from "../attribute-policy.js";
import {
  isSvgAnimationElement,
  sanitizeElementUrlAttributes,
  sanitizeUrlAttributeValue,
  urlPurposeForAttribute,
} from "../url-policy.js";
import { isAssignableExpression, parseExpression } from "./expression.js";
import type {
  CompilerError,
  Attribute,
  ComponentCallProp,
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
  isComponentCallTagName,
  isHydrationAttribute,
  isSafeIdentifierName,
  hydrationBoundaryFor,
  identifierPattern,
  isKnownHydrationAttribute,
  itemNameFromKey,
  readExpressionAttribute,
  renderableChildren,
  textExpressionSegments,
  voidElementNames,
} from "./utils.js";

type SourceSpan = { start: number | undefined; end: number | undefined };

const semanticError = (message: string, span?: SourceSpan): Result<never, CompilerError> =>
  err({
    message,
    offset: span?.start ?? 0,
    ...(span?.end === undefined ? {} : { endOffset: span.end }),
  });

const openingTagSpan = (node: ElementNode): SourceSpan => ({ start: node.start, end: node.openEnd });

/**
 * A `<for>` that would sit directly among `node`'s own nodes: a direct child, or a child of a transparent
 * `<component>` chain, which emits no element of its own.
 */
const listAmongTransparentChildren = (node: ElementNode, throughComponent = false): ElementNode | undefined => {
  for (const child of node.children) {
    if (child.type !== "element") continue;
    if (child.tagName === "for" && throughComponent) return child;
    if (child.tagName === "for") return child;
    if (child.tagName === "component") {
      const nested = listAmongTransparentChildren(child, true);
      if (nested) return nested;
    }
  }
  return undefined;
};

/** Like `listAmongTransparentChildren`, but only a `<for>` reached through a `<component>` counts. */
const listThroughComponentChildren = (node: ElementNode): ElementNode | undefined => {
  for (const child of node.children) {
    if (child.type !== "element" || child.tagName !== "component") continue;
    const nested = listAmongTransparentChildren(child, true);
    if (nested) return nested;
  }
  return undefined;
};

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
    if (
      child.type !== "element" ||
      child.tagName === "component" ||
      child.tagName === "if" ||
      child.tagName === "for"
    ) {
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

const forbiddenComponentPropNames = new Set(["constructor", "__proto__", "prototype"]);

export const componentCallPropsFor = (node: ElementNode): ComponentCallProp[] =>
  node.attrs.map((attr) => {
    if (attr.value === true) return { name: attr.name, value: true, kind: "boolean" };
    const expression = readExpressionAttribute(attr.value);
    if (expression !== undefined) return { name: attr.name, value: expression, kind: "expression" };
    return { name: attr.name, value: attr.value, kind: "static" };
  });

const unsafeAwaitRawPattern = /<\/?(?:script|template)\b|<!--\s*\/?(?:tachyon-|td:await:)/i;
const forbiddenAwaitStaticTags = new Set([
  "script",
  "template",
  "style",
  "iframe",
  "object",
  "embed",
  "base",
  "meta",
  "link",
  "foreignobject",
]);

const forbiddenAwaitParseErrors = new Set([
  "eof-in-tag",
  "eof-in-comment",
  "eof-before-tag-name",
  "end-tag-without-matching-open-element",
  "unexpected-character-in-attribute-name",
  "unexpected-null-character",
]);

const validateAwaitStaticHtml = (
  raw: string,
  attrName: string,
  span: SourceSpan,
): Result<void, CompilerError> => {
  if (unsafeAwaitRawPattern.test(raw)) {
    return semanticError(
      `<await> ${attrName} must not contain <script>, <template>, or internal Tachyon comment markers.`,
      span,
    );
  }
  let parseFailure: string | undefined;
  const fragment = parseFragment(raw, {
    sourceCodeLocationInfo: true,
    onParseError: (error) => {
      if (!parseFailure && forbiddenAwaitParseErrors.has(error.code)) {
        parseFailure = error.code;
      }
    },
  });
  if (parseFailure) {
    return semanticError(`<await> ${attrName} contains malformed or unbalanced HTML (${parseFailure}).`, span);
  }
  const covered: Array<[number, number]> = [];
  const checkNode = (child: DefaultTreeAdapterMap["childNode"]): Result<void, CompilerError> => {
    if (child.nodeName === "#comment" && "data" in child) {
      if (child.sourceCodeLocation) {
        covered.push([child.sourceCodeLocation.startOffset, child.sourceCodeLocation.endOffset]);
      }
      if (/^\s*\/?(?:tachyon-|td:await:)/i.test(child.data)) {
        return semanticError(`<await> ${attrName} must not contain internal Tachyon comment markers.`, span);
      }
      return ok(undefined);
    }
    if (child.nodeName === "#text" || child.nodeName === "#documentType") {
      return ok(undefined);
    }
    if ("tagName" in child) {
      const tag = child.tagName.toLowerCase();
      if (forbiddenAwaitStaticTags.has(tag) || isSvgAnimationElement(tag)) {
        return semanticError(`<await> ${attrName} must not contain <${tag}>.`, span);
      }
      if (child.sourceCodeLocation?.startTag) {
        covered.push([child.sourceCodeLocation.startTag.startOffset, child.sourceCodeLocation.startTag.endOffset]);
      }
      if (child.sourceCodeLocation?.endTag) {
        covered.push([child.sourceCodeLocation.endTag.startOffset, child.sourceCodeLocation.endTag.endOffset]);
      }
      if (!voidElementNames.has(tag) && !child.sourceCodeLocation?.endTag) {
        const startLoc = child.sourceCodeLocation?.startTag;
        const isSelfClosingSvg =
          child.namespaceURI !== "http://www.w3.org/1999/xhtml" &&
          startLoc !== undefined &&
          raw.slice(startLoc.startOffset, startLoc.endOffset).trimEnd().endsWith("/>");
        if (!isSelfClosingSvg) {
          return semanticError(`<await> ${attrName} contains an unclosed <${tag}> element.`, span);
        }
      }
      const attrMap: Record<string, string> = {};
      for (const attr of child.attrs) {
        const fullName = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
        if (isDangerousAttributeName(fullName)) {
          return semanticError(`<await> ${attrName}: Dangerous attribute is not supported: ${fullName}.`, span);
        }
        attrMap[fullName] = attr.value;
        if (urlPurposeForAttribute(tag, fullName)) {
          try {
            sanitizeUrlAttributeValue(tag, fullName, attr.value);
          } catch (error) {
            return semanticError(
              `<await> ${attrName}: ${error instanceof Error ? error.message : String(error)}`,
              span,
            );
          }
        }
      }
      try {
        sanitizeElementUrlAttributes(tag, attrMap);
      } catch (error) {
        return semanticError(`<await> ${attrName}: ${error instanceof Error ? error.message : String(error)}`, span);
      }
      for (const grandChild of child.childNodes) {
        const next = checkNode(grandChild);
        if (!next.ok) return next;
      }
    }
    return ok(undefined);
  };
  for (const child of fragment.childNodes) {
    const res = checkNode(child);
    if (!res.ok) return res;
  }
  covered.sort((a, b) => a[0] - b[0]);
  let cursor = 0;
  let uncovered = "";
  for (const [start, end] of covered) {
    if (start > cursor) uncovered += raw.slice(cursor, start);
    if (end > cursor) cursor = end;
  }
  if (cursor < raw.length) uncovered += raw.slice(cursor);
  if (/<\s*\//.test(uncovered)) {
    return semanticError(`<await> ${attrName} contains an unmatched closing HTML tag.`, span);
  }
  return ok(undefined);
};

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
    if (attr.name === "name" && !isComponentCallTagName(node.tagName)) {
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
  if (isComponentCallTagName(node.tagName)) {
    for (const attr of node.attrs) {
      if (forbiddenComponentPropNames.has(attr.name)) {
        return semanticError(`Forbidden component prop name: ${attr.name}.`, attributeSpan(attr));
      }
      if (
        attr.name.startsWith("on:") ||
        attr.name.startsWith("bind:") ||
        attr.name.startsWith("class:") ||
        attr.name.startsWith("style:") ||
        attr.name === "ref" ||
        isHydrationAttribute(attr.name)
      ) {
        return semanticError(
          `Template directive ${attr.name} is not supported directly on component call <${node.tagName}>; pass a prop instead.`,
          attributeSpan(attr),
        );
      }
    }
    const nonWhitespaceChildren = node.children.filter(
      (child) => child.type !== "text" || child.value.trim().length > 0,
    );
    if (nonWhitespaceChildren.length > 0) {
      return semanticError(
        `Component call <${node.tagName}> does not support child content yet; pass props or use self-closing <${node.tagName} ... />.`,
        openingTagSpan(node),
      );
    }
    return ok(undefined);
  }
  if (isSvgAnimationElement(node.tagName)) {
    for (const attr of node.attrs) {
      if (attr.name.toLowerCase() !== "attributename") continue;
      if (attr.value === true || readExpressionAttribute(attr.value)) {
        return semanticError("SVG animation attributeName must be a static safe attribute name.", attributeSpan(attr));
      }
      const sanitized = sanitizeElementUrlAttributes(node.tagName, { [attr.name]: attr.value });
      if (!sanitized.ok) return semanticError(sanitized.error.message, attributeSpan(attr));
    }
  }
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
    const directList = listAmongTransparentChildren(node);
    if (directList) {
      // A row's nodes are bound before they are inserted and moved as a fixed set, so a list whose rows would
      // sit among them has no owner yet. The compiler reports it instead of nesting the rows in a sibling.
      return semanticError(
        "A <for> placed directly inside a <for> row is not supported yet; wrap it in an element such as <ul>.",
        openingTagSpan(directList),
      );
    }
    const directComponentCall = node.children.find(
      (child): child is ElementNode => child.type === "element" && isComponentCallTagName(child.tagName),
    );
    if (directComponentCall) {
      return semanticError(
        `A component call <${directComponentCall.tagName}> placed directly inside <for> is not supported yet; wrap it in an element such as <li>.`,
        openingTagSpan(directComponentCall),
      );
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
    const updatePolicy = attrString(node, "update");
    if (updatePolicy && updatePolicy !== "always" && updatePolicy !== "reference") {
      const attribute = node.attrs.find((attr) => attr.name === "update");
      return semanticError(`<for> update must be "always" or "reference".`, attribute && attributeSpan(attribute));
    }
  }
  if (node.tagName === "if" && !attrExpression(node, "test")) {
    return semanticError("<if> requires test={condition}.", openingTagSpan(node));
  }
  if (node.tagName === "if") {
    const componentList = listThroughComponentChildren(node);
    if (componentList) {
      // A transparent <component> emits no element, so this <for> would sit among the branch nodes without the
      // branch knowing it; the compiler reports it instead of leaving the rows unmanaged.
      return semanticError(
        "A <for> inside a <component> that is a direct child of <if> is not supported yet; place the <for> directly in the <if> or wrap it in an element.",
        openingTagSpan(componentList),
      );
    }
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
    if (attrString(node, "pending") !== undefined && attrString(node, "fallback") !== undefined) {
      return semanticError(
        `<await> accepts either pending="..." or its alias fallback="...", not both.`,
        attributeSpan(node.attrs.find((attr) => attr.name === "fallback") as Attribute),
      );
    }
    for (const attrName of ["pending", "fallback", "error"] as const) {
      const attr = node.attrs.find((candidate) => candidate.name === attrName);
      if (!attr) continue;
      if (attr.value === true || readExpressionAttribute(attr.value) !== undefined) {
        return semanticError(`<await> ${attrName} must be a static HTML string.`, attributeSpan(attr));
      }
      const checked = validateAwaitStaticHtml(attr.value, attrName, attributeSpan(attr));
      if (!checked.ok) return checked;
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
  if (node.type === "text") {
    return ok(undefined);
  }
  const specialResult = validateSpecialNode(node);
  if (!specialResult.ok) {
    return specialResult;
  }
  const hydrateBoundary = hydrationBoundaryFor(node, []);
  if (insideFor && hydrateBoundary?.idKind === "static") {
    return semanticError(
      "Automatic row-local hydration ids are not unique; use hydrate:id={row.id} or another row-scoped expression.",
      openingTagSpan(node),
    );
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
  if (isComponentCallTagName(node.tagName)) {
    directives.push({
      kind: "componentCall",
      path: [...path],
      tagName: node.tagName,
      props: componentCallPropsFor(node),
    });
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
    // `pending` is the documented name; `fallback` remains an alias. Both fields are recorded so existing
    // consumers of the IR keep reading `fallback`.
    const pending = attrString(node, "pending") ?? attrString(node, "fallback");
    const errorText = attrString(node, "error");
    const reorder = attrString(node, "reorder");
    directives.push({
      kind: "await",
      path: [...path],
      value: attrExpression(node, "value") ?? "undefined",
      thenName: attrString(node, "then") ?? "value",
      ...(pending ? { pending, fallback: pending } : {}),
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
  let effectiveRoot: ElementNode = root;
  while (effectiveRoot.tagName === "component") {
    const children = renderableChildren(effectiveRoot);
    if (children.length !== 1 || children[0]?.type !== "element") break;
    effectiveRoot = children[0];
  }
  if (isComponentCallTagName(effectiveRoot.tagName)) {
    return semanticError(
      `Component call <${effectiveRoot.tagName}> cannot be the template root; wrap it in an element.`,
      openingTagSpan(effectiveRoot),
    );
  }
  if (effectiveRoot.tagName === "await") {
    return semanticError(`<await> cannot be the template root; wrap it in an element.`, openingTagSpan(effectiveRoot));
  }
  // Preserve diagnostic order by validating the full expression tree before structural checks.
  const expressionResult = validateTextExpressions(root);
  if (!expressionResult.ok) {
    return expressionResult;
  }
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
