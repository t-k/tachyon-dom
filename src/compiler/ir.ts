import { err, ok, type Result } from "../result";
import type {
  CompilerError,
  ComponentProp,
  ElementNode,
  StoreDefinition,
  TemplateDirective,
  TemplateIr,
  TemplateNode,
} from "./types";
import {
  attrExpression,
  attrString,
  expressionPattern,
  identifierPattern,
  itemNameFromKey,
  readExpressionAttribute,
  renderableChildren,
} from "./utils";

const semanticError = (message: string): Result<never, CompilerError> => err({ message, offset: 0 });

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

const validateExpression = (expression: string, context: string): Result<void, CompilerError> => {
  if (!identifierPattern.test(expression)) {
    return semanticError(`Invalid ${context} expression: ${expression}.`);
  }
  return ok(undefined);
};

const validateTextExpressions = (node: TemplateNode): Result<void, CompilerError> => {
  if (node.type === "text") {
    for (const match of node.value.matchAll(expressionPattern)) {
      const expression = (match[1] as string).trim();
      const result = validateExpression(expression, "text");
      if (!result.ok) {
        return result;
      }
    }
    return ok(undefined);
  }
  for (const attr of node.attrs) {
    if (attr.name === "class" || attr.name === "name") {
      continue;
    }
    const expression = readExpressionAttribute(attr.value);
    if (expression) {
      const result = validateExpression(expression, `${attr.name} attribute`);
      if (!result.ok) {
        return result;
      }
    }
  }
  for (const child of node.children) {
    const result = validateTextExpressions(child);
    if (!result.ok) {
      return result;
    }
  }
  return ok(undefined);
};

const validateSpecialNode = (node: ElementNode): Result<void, CompilerError> => {
  if (node.tagName === "for") {
    const each = attrExpression(node, "each");
    const key = attrExpression(node, "key");
    if (!each) {
      return semanticError("<for> requires each={items}.");
    }
    if (!key) {
      return semanticError("<for> requires key={item.id}.");
    }
  }
  if (node.tagName === "if" && !attrExpression(node, "test")) {
    return semanticError("<if> requires test={condition}.");
  }
  if (node.tagName === "component") {
    if (!componentName(node)) {
      return semanticError("<component> requires a string name attribute.");
    }
    if (renderableChildren(node).length !== 1) {
      return semanticError("<component> requires exactly one renderable root child.");
    }
  }
  if (node.tagName === "await") {
    if (!attrExpression(node, "value")) {
      return semanticError("<await> requires value={promise}.");
    }
    const thenName = attrString(node, "then");
    if (!thenName) {
      return semanticError(`<await> requires then="name".`);
    }
    if (!identifierPattern.test(thenName)) {
      return semanticError(`Invalid await then binding: ${thenName}.`);
    }
  }
  return ok(undefined);
};

const validateTree = (node: TemplateNode, hydrateIds: Set<string>): Result<void, CompilerError> => {
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
  const hydrateId = attrExpression(node, "hydrate:id");
  if (hydrateId) {
    if (hydrateIds.has(hydrateId)) {
      return semanticError(`Duplicate hydrate boundary id expression: ${hydrateId}.`);
    }
    hydrateIds.add(hydrateId);
  }
  for (const child of node.children) {
    const result = validateTree(child, hydrateIds);
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
  const hydrateId = attrExpression(node, "hydrate:id");
  if (hydrateId) {
    directives.push({ kind: "hydrate", path: [...path], id: hydrateId });
  }
  if (node.tagName === "if") {
    directives.push({ kind: "if", path: [...path], test: attrExpression(node, "test") ?? "false" });
  }
  if (node.tagName === "for") {
    const key = attrExpression(node, "key") ?? "item";
    directives.push({
      kind: "for",
      path: [...path],
      each: attrExpression(node, "each") ?? "[]",
      key,
      itemName: itemNameFromKey(key),
    });
  }
  if (node.tagName === "await") {
    directives.push({
      kind: "await",
      path: [...path],
      value: attrExpression(node, "value") ?? "undefined",
      thenName: attrString(node, "then") ?? "value",
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
