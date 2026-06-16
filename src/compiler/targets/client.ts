import type {
  ClassBinding,
  CompiledTemplate,
  ConditionalBinding,
  ElementNode,
  EventBinding,
  GenerateClientModuleOptions,
  ListBinding,
  LoweringContext,
  TemplateNode,
  TextBinding,
  TextNode,
} from "../types";
import { storeDefinitionsFor } from "../ir";
import {
  attrExpression,
  expressionPattern,
  expressionToScopeAccess,
  isForNode,
  isStoreNode,
  itemNameFromKey,
  readExpressionAttribute,
  renderableChildren,
  serializeStaticAttr,
} from "../utils";

const lowerTextNode = (node: TextNode, path: number[], context: LoweringContext): string => {
  let output = "";
  let cursor = 0;
  for (const match of node.value.matchAll(expressionPattern)) {
    const start = match.index ?? 0;
    output += node.value.slice(cursor, start);
    context.bindings.push({ kind: "text", path: [...path], expression: (match[1] as string).trim() });
    output += " ";
    cursor = start + match[0].length;
  }
  output += node.value.slice(cursor);
  return output;
};

const addStoreDefinitions = (node: ElementNode, context: LoweringContext): void => {
  context.stores.push(...storeDefinitionsFor(node));
};

const lowerComponent = (node: ElementNode, path: number[], context: LoweringContext): string => {
  const children = renderableChildren(node);
  if (children.length === 0) {
    return "";
  }
  if (children.length === 1) {
    return lowerNode(children[0] as TemplateNode, path, context);
  }
  return children.map((child, index) => lowerNode(child, [...path, index], context)).join("");
};

const lowerIf = (node: ElementNode, path: number[], context: LoweringContext): string => {
  const childContext: LoweringContext = {
    bindings: [],
    stores: [],
    hydrationBoundaries: [],
  };
  const children = renderableChildren(node);
  const templateHtml = children
    .map((child, index) => lowerNode(child, children.length === 1 ? [] : [index], childContext))
    .join("");
  context.bindings.push({
    kind: "if",
    path: [...path],
    test: attrExpression(node, "test") ?? "false",
    templateHtml,
    bindings: childContext.bindings.filter(
      (binding): binding is TextBinding | ClassBinding | EventBinding =>
        binding.kind === "text" || binding.kind === "class" || binding.kind === "event",
    ),
  });
  return "<!---->";
};

const lowerList = (node: ElementNode, containerPath: number[]): ListBinding => {
  const key = attrExpression(node, "key") ?? "item";
  const childContext: LoweringContext = {
    bindings: [],
    stores: [],
    hydrationBoundaries: [],
  };
  const children = renderableChildren(node);
  const templateHtml = children
    .map((child, index) => lowerNode(child, children.length === 1 ? [] : [index], childContext))
    .join("");
  for (const child of node.children) {
    if (isForNode(child)) {
      childContext.bindings.push(lowerList(child, []));
    }
  }
  return {
    kind: "list",
    path: [...containerPath],
    each: attrExpression(node, "each") ?? "[]",
    itemName: itemNameFromKey(key),
    key,
    templateHtml,
    bindings: childContext.bindings,
  };
};

const lowerElement = (node: ElementNode, path: number[], context: LoweringContext): string => {
  if (node.tagName === "for") {
    return "";
  }
  if (node.tagName === "if") {
    return lowerIf(node, path, context);
  }
  if (node.tagName === "store") {
    addStoreDefinitions(node, context);
    return "";
  }
  if (node.tagName === "component") {
    return lowerComponent(node, path, context);
  }

  const attrs: string[] = [];
  const staticClassNames: string[] = [];
  const hydrateId = attrExpression(node, "hydrate:id");
  if (hydrateId) {
    context.hydrationBoundaries.push({ path: [...path], id: hydrateId });
  }

  for (const attr of node.attrs) {
    if (attr.name.startsWith("on:")) {
      const handler = readExpressionAttribute(attr.value);
      if (handler) {
        context.bindings.push({ kind: "event", path: [...path], eventName: attr.name.slice(3), handler });
      }
      continue;
    }
    if (attr.name.startsWith("class:")) {
      const expression = readExpressionAttribute(attr.value);
      if (expression) {
        context.bindings.push({ kind: "class", path: [...path], className: attr.name.slice(6), expression });
      }
      continue;
    }
    if (attr.name === "hydrate:id") {
      continue;
    }
    const expression = readExpressionAttribute(attr.value);
    if (expression) {
      continue;
    }
    if (attr.name === "class" && attr.value !== true) {
      staticClassNames.push(attr.value);
      continue;
    }
    attrs.push(serializeStaticAttr(attr));
  }

  if (staticClassNames.length > 0) {
    attrs.unshift(` class="${staticClassNames.join(" ")}"`);
  }

  let children = "";
  let domIndex = 0;
  for (const child of node.children) {
    if (isForNode(child)) {
      context.bindings.push(lowerList(child, path));
      continue;
    }
    if (isStoreNode(child)) {
      addStoreDefinitions(child, context);
      continue;
    }
    children += lowerNode(child, [...path, domIndex], context);
    domIndex++;
  }
  return `<${node.tagName}${attrs.join("")}>${children}</${node.tagName}>`;
};

const lowerNode = (node: TemplateNode, path: number[], context: LoweringContext): string => {
  if (node.type === "text") {
    return lowerTextNode(node, path, context);
  }
  return lowerElement(node, path, context);
};

export const lowerClientTemplate = (root: ElementNode): CompiledTemplate["client"] => {
  const context: LoweringContext = {
    bindings: [],
    stores: [],
    hydrationBoundaries: [],
  };
  const templateHtml = lowerElement(root, [], context);
  return {
    templateHtml,
    bindings: context.bindings,
    stores: context.stores,
    hydrationBoundaries: context.hydrationBoundaries,
  };
};

const scopeName = (usesStore: boolean): string => (usesStore ? "state" : "scope");

const elementExpression = (path: readonly number[]): string =>
  path.length === 0 ? "root" : `elementAt(root, ${JSON.stringify(path)})`;

const runtimeValueExpression = (expression: string, reactive: boolean, sourceName: string): string => {
  const value = expressionToScopeAccess(expression).replace(/^scope\./, `${sourceName}.`);
  return reactive ? `read(${value})` : value;
};

export const generateClientModule = (template: CompiledTemplate, options: GenerateClientModuleOptions = {}): string => {
  const bindings = template.client.bindings;
  const reactive = options.reactive === true;
  const needsStore = template.client.stores.length > 0;
  const sourceName = scopeName(needsStore);
  const needsText = bindings.some((binding) => binding.kind === "text");
  const needsClass = bindings.some((binding) => binding.kind === "class");
  const needsEvent = bindings.some((binding) => binding.kind === "event");
  const needsList = bindings.some((binding) => binding.kind === "list");
  const needsConditional = bindings.some((binding) => binding.kind === "if");
  const needsSignal = reactive && bindings.some((binding) => binding.kind !== "event");
  const lines: string[] = [];
  if (needsText) {
    lines.push(`import { setText, textAt } from "tachyon-dom/runtime/text";`);
  }
  if (needsClass) {
    lines.push(`import { elementAt, setClassPresence } from "tachyon-dom/runtime/class";`);
  }
  if (needsEvent) {
    lines.push(`import { delegate } from "tachyon-dom/runtime/event";`);
  }
  if (needsList) {
    lines.push(`import { mountKeyedList } from "tachyon-dom/runtime/list";`);
  }
  if (needsConditional) {
    lines.push(`import { mountConditional } from "tachyon-dom/runtime/conditional";`);
  }
  if (needsSignal) {
    lines.push(`import { effect, read } from "tachyon-dom/runtime/signal";`);
  }
  if (needsStore) {
    lines.push(`import { createStore } from "tachyon-dom/runtime/store";`);
  }
  lines.push(`export const templateHtml = ${JSON.stringify(template.client.templateHtml)};`);
  lines.push(`export const hydrationBoundaries = ${JSON.stringify(template.client.hydrationBoundaries)};`);
  lines.push(`export const bind = (root, scope) => {`);
  if (needsStore) {
    const fields = template.client.stores
      .map((store) => `${store.name}: ${expressionToScopeAccess(store.initial)}`)
      .join(", ");
    lines.push(`  const state = createStore({ ...scope, ${fields} });`);
  }
  if (reactive || needsEvent) {
    lines.push(`  const cleanups = [];`);
  }
  for (const binding of bindings) {
    if (binding.kind === "text") {
      const statement = `setText(textAt(root, ${JSON.stringify(binding.path)}), ${runtimeValueExpression(binding.expression, reactive, sourceName)})`;
      lines.push(reactive ? `  cleanups.push(effect(() => ${statement}));` : `  ${statement};`);
    } else if (binding.kind === "class") {
      const statement = `setClassPresence(${elementExpression(binding.path)}, ${JSON.stringify(binding.className)}, ${runtimeValueExpression(binding.expression, reactive, sourceName)})`;
      lines.push(reactive ? `  cleanups.push(effect(() => ${statement}));` : `  ${statement};`);
    } else if (binding.kind === "event") {
      const statement = `delegate(root, ${JSON.stringify(binding.eventName)}, ${JSON.stringify(binding.path)}, ${expressionToScopeAccess(binding.handler).replace(/^scope\./, `${scopeName(needsStore)}.`)})`;
      lines.push(`  cleanups.push(${statement});`);
    } else if (binding.kind === "list") {
      lines.push(emitListBinding(binding, reactive, sourceName));
    } else {
      lines.push(emitConditionalBinding(binding, reactive, sourceName));
    }
  }
  if (reactive || needsEvent) {
    lines.push(`  return () => {`);
    lines.push(`    for (const cleanup of cleanups) cleanup();`);
    lines.push(`  };`);
  }
  lines.push(`};`);
  return `${lines.join("\n")}\n`;
};

const emitListBinding = (binding: ListBinding, reactive: boolean, sourceName: string): string => {
  const listOptions = [
    `{`,
    `    key: ${JSON.stringify(binding.key)},`,
    `    itemName: ${JSON.stringify(binding.itemName)},`,
    `    templateHtml: ${JSON.stringify(binding.templateHtml)},`,
    `    bindings: ${JSON.stringify(binding.bindings)},`,
    `  }`,
  ].join("\n");
  const statement = `mountKeyedList(root, ${JSON.stringify(binding.path)}, ${runtimeValueExpression(binding.each, reactive, sourceName)}, ${listOptions})`;
  return reactive ? `  cleanups.push(effect(() => ${statement}));` : `  ${statement};`;
};

const emitConditionalBinding = (binding: ConditionalBinding, reactive: boolean, sourceName: string): string => {
  const conditionalOptions = [
    `{`,
    `    templateHtml: ${JSON.stringify(binding.templateHtml)},`,
    `    bindings: ${JSON.stringify(binding.bindings)},`,
    `  }`,
  ].join("\n");
  const statement = `mountConditional(root, ${JSON.stringify(binding.path)}, ${runtimeValueExpression(binding.test, reactive, sourceName)}, ${sourceName}, ${conditionalOptions})`;
  return reactive ? `  cleanups.push(effect(() => ${statement}));` : `  ${statement};`;
};
