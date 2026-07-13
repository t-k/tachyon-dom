import type {
  CompiledTemplate,
  ConditionalBinding,
  ElementNode,
  GenerateClientModuleOptions,
  ListBinding,
  LoweringContext,
  StoreDefinition,
  TemplateNode,
  TextNode,
} from "../types.js";
import { storeDefinitionsFor } from "../ir.js";
import {
  attrExpression,
  expressionToScopeAccess,
  hydrationBoundaryFor,
  isHydrationAttribute,
  isForNode,
  isVoidElement,
  isStoreNode,
  itemNameFromKey,
  attrString,
  readExpressionAttribute,
  renderableChildren,
  serializeStaticAttr,
  textExpressionSegments,
} from "../utils.js";
import { isAssignableExpression } from "../expression.js";

type LoweredNode = {
  html: string;
  nodeCount: number;
};

const lowerTextNode = (node: TextNode, path: number[], context: LoweringContext): LoweredNode => {
  let output = "";
  let nodeOffset = 0;
  let lastEmittedWasText = false;
  const separateTextNode = (): void => {
    if (lastEmittedWasText) {
      output += "<!---->";
      nodeOffset++;
    }
  };
  for (const segment of textExpressionSegments(node.value)) {
    if (segment.kind === "text") {
      if (!segment.value) {
        continue;
      }
      separateTextNode();
      output += segment.value;
      nodeOffset++;
      lastEmittedWasText = true;
      continue;
    }
    separateTextNode();
    context.bindings.push({
      kind: "text",
      path: [...path.slice(0, -1), (path.at(-1) ?? 0) + nodeOffset],
      expression: segment.value,
    });
    output += " ";
    nodeOffset++;
    lastEmittedWasText = true;
  }
  return { html: output, nodeCount: nodeOffset };
};

const addStoreDefinitions = (node: ElementNode, context: LoweringContext): void => {
  context.stores.push(...storeDefinitionsFor(node));
};

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

const lowerComponent = (node: ElementNode, path: number[], context: LoweringContext): string => {
  context.components.push({
    path: [...path],
    name: attrString(node, "name") ?? "Anonymous",
    props: node.attrs.flatMap((attr) => {
      if (attr.name === "name") {
        return [];
      }
      const expression = readExpressionAttribute(attr.value);
      return expression ? [{ name: attr.name, expression }] : [];
    }),
    stores: componentStores(node),
  });
  const children = renderableChildren(node);
  if (children.length === 0) {
    return "";
  }
  if (children.length === 1) {
    return lowerNode(children[0] as TemplateNode, path, context).html;
  }
  let html = "";
  let domIndex = 0;
  for (const child of children) {
    const lowered = lowerNode(child, [...path, domIndex], context);
    html += lowered.html;
    domIndex += lowered.nodeCount;
  }
  return html;
};

const lowerIf = (node: ElementNode, path: number[], context: LoweringContext): string => {
  const childContext: LoweringContext = {
    bindings: [],
    stores: [],
    hydrationBoundaries: [],
    components: [],
  };
  const children = renderableChildren(node);
  let templateHtml = "";
  let domIndex = 0;
  for (const child of children) {
    const lowered = lowerNode(child, children.length === 1 ? [] : [domIndex], childContext);
    templateHtml += lowered.html;
    domIndex += lowered.nodeCount;
  }
  context.bindings.push({
    kind: "if",
    path: [...path],
    test: attrExpression(node, "test") ?? "false",
    templateHtml,
    bindings: childContext.bindings,
  });
  return "<!---->";
};

const lowerList = (node: ElementNode, containerPath: number[]): ListBinding => {
  const key = attrExpression(node, "key") ?? "item";
  const childContext: LoweringContext = {
    bindings: [],
    stores: [],
    hydrationBoundaries: [],
    components: [],
  };
  const children = renderableChildren(node);
  let templateHtml = "";
  let domIndex = 0;
  for (const child of children) {
    const lowered = lowerNode(child, children.length === 1 ? [] : [domIndex], childContext);
    templateHtml += lowered.html;
    domIndex += lowered.nodeCount;
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
  if (node.tagName === "outlet") {
    return "<!--tachyon-outlet-->";
  }
  if (node.tagName === "slot") {
    return `<!--tachyon-slot:${attrString(node, "name") ?? "default"}-->`;
  }
  if (node.tagName === "for") {
    context.bindings.push(lowerList(node, path));
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
  const hydrateBoundary = hydrationBoundaryFor(node, path);
  if (hydrateBoundary) {
    context.hydrationBoundaries.push(hydrateBoundary);
  }

  for (const attr of node.attrs) {
    if (isHydrationAttribute(attr.name)) {
      continue;
    }
    if (attr.name.startsWith("on:")) {
      const handler = readExpressionAttribute(attr.value);
      if (handler) {
        context.bindings.push({ kind: "event", path: [...path], eventName: attr.name.slice(3), handler });
      }
      continue;
    }
    if (attr.name.startsWith("bind:")) {
      const expression = readExpressionAttribute(attr.value);
      if (expression && isAssignableExpression(expression)) {
        const property = attr.name.slice(5) === "checked" ? "checked" : "value";
        context.bindings.push({ kind: "model", path: [...path], property, expression });
      }
      continue;
    }
    if (attr.name === "ref") {
      const expression = readExpressionAttribute(attr.value);
      if (expression) {
        context.bindings.push({ kind: "ref", path: [...path], expression });
      }
      continue;
    }
    if (attr.name.startsWith("style:")) {
      const expression = readExpressionAttribute(attr.value);
      if (expression) {
        context.bindings.push({ kind: "style", path: [...path], name: attr.name.slice(6), expression });
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
    const expression = readExpressionAttribute(attr.value);
    if (expression) {
      context.bindings.push({ kind: "attr", path: [...path], name: attr.name, expression });
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
    const lowered = lowerNode(child, [...path, domIndex], context);
    children += lowered.html;
    domIndex += lowered.nodeCount;
  }
  return isVoidElement(node)
    ? `<${node.tagName}${attrs.join("")}>`
    : `<${node.tagName}${attrs.join("")}>${children}</${node.tagName}>`;
};

const lowerNode = (node: TemplateNode, path: number[], context: LoweringContext): LoweredNode => {
  if (node.type === "text") {
    return lowerTextNode(node, path, context);
  }
  return { html: lowerElement(node, path, context), nodeCount: 1 };
};

export const lowerClientTemplate = (root: ElementNode): CompiledTemplate["client"] => {
  const context: LoweringContext = {
    bindings: [],
    stores: [],
    hydrationBoundaries: [],
    components: [],
  };
  const templateHtml = lowerElement(root, [], context);
  return {
    templateHtml,
    bindings: context.bindings,
    stores: context.stores,
    hydrationBoundaries: context.hydrationBoundaries,
    components: context.components,
  };
};

const scopeName = (usesStore: boolean): string => (usesStore ? "state" : "scope");

const runtimeNames = {
  bindControl: "__tachyonBindControl",
  createStore: "__tachyonCreateStore",
  createRoot: "__tachyonCreateRoot",
  delegate: "__tachyonDelegate",
  effect: "__tachyonEffect",
  elementAt: "__tachyonElementAt",
  mountConditional: "__tachyonMountConditional",
  mountKeyedList: "__tachyonMountKeyedList",
  nodeAt: "__tachyonNodeAt",
  read: "__tachyonRead",
  setAttributeValue: "__tachyonSetAttributeValue",
  setClassPresence: "__tachyonSetClassPresence",
  setControlValue: "__tachyonSetControlValue",
  setRef: "__tachyonSetRef",
  setStyleValue: "__tachyonSetStyleValue",
  setText: "__tachyonSetText",
  textAt: "__tachyonTextAt",
} as const;

const elementExpression = (path: readonly number[]): string =>
  path.length === 0 ? "root" : `${runtimeNames.elementAt}(root, ${JSON.stringify(path)})`;

const nodeExpression = (path: readonly number[]): string =>
  path.length === 0 ? "root" : `${runtimeNames.nodeAt}(root, ${JSON.stringify(path)})`;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const simpleItemKeyExpression = (expression: string, itemName: string): string | undefined => {
  const itemPattern = new RegExp(`^${escapeRegExp(itemName)}(?:\\.[A-Za-z_$][\\w$]*)*$`);
  return itemPattern.test(expression) ? expressionToScopeAccess(expression, new Set([itemName])) : undefined;
};

const runtimeValueExpression = (expression: string, reactive: boolean, sourceName: string): string => {
  const value = expressionToScopeAccess(expression, new Set(), sourceName);
  return reactive ? `${runtimeNames.read}(${value})` : value;
};

const clientModuleCache = new WeakMap<CompiledTemplate, Map<string, string>>();

const clientModuleCacheKey = (options: GenerateClientModuleOptions): string =>
  `${options.reactive === true ? "1" : "0"}\0${options.defaultScopeName ?? ""}`;

export const generateClientModule = (template: CompiledTemplate, options: GenerateClientModuleOptions = {}): string => {
  const cacheKey = clientModuleCacheKey(options);
  const cachedByOptions = clientModuleCache.get(template);
  const cached = cachedByOptions?.get(cacheKey);
  if (cached) {
    return cached;
  }
  const bindings = template.client.bindings;
  const reactive = options.reactive === true;
  const needsStore = template.client.stores.length > 0;
  const hasDefaultScope = typeof options.defaultScopeName === "string" && options.defaultScopeName.length > 0;
  const sourceName = scopeName(needsStore);
  const needsText = bindings.some((binding) => binding.kind === "text");
  const needsClass = bindings.some((binding) => binding.kind === "class");
  const needsAttr = bindings.some(
    (binding) => binding.kind === "attr" || binding.kind === "style" || binding.kind === "ref",
  );
  const needsModel = bindings.some((binding) => binding.kind === "model");
  const needsEvent = bindings.some((binding) => binding.kind === "event");
  const needsList = bindings.some((binding) => binding.kind === "list");
  const needsConditional = bindings.some((binding) => binding.kind === "if");
  const needsSignal = reactive && bindings.some((binding) => binding.kind !== "event");
  const needsElementAt = needsClass || needsAttr || needsModel || (reactive && needsList);
  const needsNodeAt = reactive && needsConditional;
  const lines: string[] = [];
  if (needsText) {
    lines.push(
      `import { setText as ${runtimeNames.setText}, textAt as ${runtimeNames.textAt} } from "tachyon-dom/runtime/text";`,
    );
  }
  if (needsElementAt) {
    lines.push(
      needsClass
        ? `import { elementAt as ${runtimeNames.elementAt}, setClassPresence as ${runtimeNames.setClassPresence} } from "tachyon-dom/runtime/class";`
        : `import { elementAt as ${runtimeNames.elementAt} } from "tachyon-dom/runtime/class";`,
    );
  }
  if (needsAttr) {
    lines.push(
      `import { setAttributeValue as ${runtimeNames.setAttributeValue}, setRef as ${runtimeNames.setRef}, setStyleValue as ${runtimeNames.setStyleValue} } from "tachyon-dom/runtime/attr";`,
    );
  }
  if (needsModel) {
    lines.push(
      `import { bindControl as ${runtimeNames.bindControl}, setControlValue as ${runtimeNames.setControlValue} } from "tachyon-dom/runtime/form";`,
    );
  }
  if (needsEvent) {
    lines.push(`import { delegate as ${runtimeNames.delegate} } from "tachyon-dom/runtime/event";`);
  }
  if (needsList) {
    lines.push(`import { mountKeyedList as ${runtimeNames.mountKeyedList} } from "tachyon-dom/runtime/list";`);
  }
  if (needsConditional) {
    lines.push(
      needsNodeAt
        ? `import { mountConditional as ${runtimeNames.mountConditional}, nodeAt as ${runtimeNames.nodeAt} } from "tachyon-dom/runtime/conditional";`
        : `import { mountConditional as ${runtimeNames.mountConditional} } from "tachyon-dom/runtime/conditional";`,
    );
  }
  if (needsSignal || hasDefaultScope) {
    lines.push(
      `import { ${hasDefaultScope ? `createRoot as ${runtimeNames.createRoot}, ` : ""}${needsSignal ? `effect as ${runtimeNames.effect}, read as ${runtimeNames.read}` : ""} } from "tachyon-dom/runtime/signal";`,
    );
  }
  if (needsStore) {
    lines.push(`import { createStore as ${runtimeNames.createStore} } from "tachyon-dom/runtime/store";`);
  }
  lines.push(`export const templateHtml = ${JSON.stringify(template.client.templateHtml)};`);
  lines.push(`export const hydrationBoundaries = ${JSON.stringify(template.client.hydrationBoundaries)};`);
  lines.push(`export const componentBoundaries = ${JSON.stringify(template.client.components)};`);
  if (hasDefaultScope) {
    lines.push(`const __tachyonCreateScope = (inputScope = {}) => {`);
    lines.push(
      `  const localScope = typeof ${options.defaultScopeName} === "function" ? ${options.defaultScopeName}(inputScope) : ${options.defaultScopeName};`,
    );
    lines.push(
      `  return localScope && typeof localScope === "object" ? { ...localScope, ...inputScope } : inputScope;`,
    );
    lines.push(`};`);
  }
  lines.push(
    hasDefaultScope
      ? `export const bind = (root, inputScope = {}) => ${runtimeNames.createRoot}((__tachyonDisposeRoot) => {`
      : `export const bind = (root, scope) => {`,
  );
  if (hasDefaultScope) {
    lines.push(`  const scope = __tachyonCreateScope(inputScope);`);
  }
  if (needsStore) {
    const fields = template.client.stores
      .map((store) => `${store.name}: ${expressionToScopeAccess(store.initial)}`)
      .join(", ");
    lines.push(`  const state = ${runtimeNames.createStore}({ ...scope, ${fields} });`);
  }
  if (reactive || needsEvent || needsModel || hasDefaultScope) {
    lines.push(`  const cleanups = [];`);
  }
  let listIndex = 0;
  let conditionalIndex = 0;
  let targetIndex = 0;
  for (const binding of bindings) {
    if (binding.kind === "text") {
      const target = `${runtimeNames.textAt}(root, ${JSON.stringify(binding.path)})`;
      if (reactive) {
        const targetName = `__tachyonTarget${targetIndex++}`;
        lines.push(`  const ${targetName} = ${target};`);
        lines.push(
          `  cleanups.push(${runtimeNames.effect}(() => ${runtimeNames.setText}(${targetName}, ${runtimeValueExpression(binding.expression, reactive, sourceName)})));`,
        );
      } else {
        lines.push(
          `  ${runtimeNames.setText}(${target}, ${runtimeValueExpression(binding.expression, reactive, sourceName)});`,
        );
      }
    } else if (binding.kind === "class") {
      const target = elementExpression(binding.path);
      if (reactive) {
        const targetName = `__tachyonTarget${targetIndex++}`;
        lines.push(`  const ${targetName} = ${target};`);
        lines.push(
          `  cleanups.push(${runtimeNames.effect}(() => ${runtimeNames.setClassPresence}(${targetName}, ${JSON.stringify(binding.className)}, ${runtimeValueExpression(binding.expression, reactive, sourceName)})));`,
        );
      } else {
        lines.push(
          `  ${runtimeNames.setClassPresence}(${target}, ${JSON.stringify(binding.className)}, ${runtimeValueExpression(binding.expression, reactive, sourceName)});`,
        );
      }
    } else if (binding.kind === "event") {
      const statement = `${runtimeNames.delegate}(root, ${JSON.stringify(binding.eventName)}, ${JSON.stringify(binding.path)}, ${expressionToScopeAccess(binding.handler, new Set(), scopeName(needsStore))})`;
      lines.push(`  cleanups.push(${statement});`);
    } else if (binding.kind === "attr") {
      const target = elementExpression(binding.path);
      if (reactive) {
        const targetName = `__tachyonTarget${targetIndex++}`;
        lines.push(`  const ${targetName} = ${target};`);
        lines.push(
          `  cleanups.push(${runtimeNames.effect}(() => ${runtimeNames.setAttributeValue}(${targetName}, ${JSON.stringify(binding.name)}, ${runtimeValueExpression(binding.expression, reactive, sourceName)})));`,
        );
      } else {
        lines.push(
          `  ${runtimeNames.setAttributeValue}(${target}, ${JSON.stringify(binding.name)}, ${runtimeValueExpression(binding.expression, reactive, sourceName)});`,
        );
      }
    } else if (binding.kind === "style") {
      const target = elementExpression(binding.path);
      if (reactive) {
        const targetName = `__tachyonTarget${targetIndex++}`;
        lines.push(`  const ${targetName} = ${target};`);
        lines.push(
          `  cleanups.push(${runtimeNames.effect}(() => ${runtimeNames.setStyleValue}(${targetName}, ${JSON.stringify(binding.name)}, ${runtimeValueExpression(binding.expression, reactive, sourceName)})));`,
        );
      } else {
        lines.push(
          `  ${runtimeNames.setStyleValue}(${target}, ${JSON.stringify(binding.name)}, ${runtimeValueExpression(binding.expression, reactive, sourceName)});`,
        );
      }
    } else if (binding.kind === "ref") {
      lines.push(
        `  ${runtimeNames.setRef}(${sourceName}, ${JSON.stringify(binding.expression)}, ${elementExpression(binding.path)});`,
      );
    } else if (binding.kind === "model") {
      const target = elementExpression(binding.path);
      const value = runtimeValueExpression(binding.expression, false, sourceName);
      if (reactive) {
        const targetName = `__tachyonTarget${targetIndex++}`;
        lines.push(`  const ${targetName} = ${target};`);
        lines.push(
          `  cleanups.push(${runtimeNames.bindControl}(${targetName}, ${JSON.stringify(binding.property)}, () => ${value}, (value) => { ${expressionToScopeAccess(binding.expression, new Set(), sourceName)} = value; }));`,
        );
        lines.push(
          `  cleanups.push(${runtimeNames.effect}(() => ${runtimeNames.setControlValue}(${targetName}, ${JSON.stringify(binding.property)}, ${runtimeValueExpression(binding.expression, true, sourceName)})));`,
        );
      } else {
        lines.push(
          `  cleanups.push(${runtimeNames.bindControl}(${target}, ${JSON.stringify(binding.property)}, () => ${value}, (value) => { ${expressionToScopeAccess(binding.expression, new Set(), sourceName)} = value; }));`,
        );
      }
    } else if (binding.kind === "list") {
      const targetName = reactive ? `__tachyonTarget${targetIndex++}` : undefined;
      lines.push(emitListBinding(binding, reactive, sourceName, listIndex++, targetName));
    } else {
      const targetName = reactive ? `__tachyonTarget${targetIndex++}` : undefined;
      lines.push(emitConditionalBinding(binding, reactive, sourceName, conditionalIndex++, targetName));
    }
  }
  if (reactive || needsEvent || needsModel || hasDefaultScope) {
    lines.push(`  return () => {`);
    lines.push(`    for (const cleanup of cleanups) cleanup();`);
    if (hasDefaultScope) lines.push(`    __tachyonDisposeRoot();`);
    lines.push(`  };`);
  }
  lines.push(hasDefaultScope ? `});` : `};`);
  const code = `${lines.join("\n")}\n`;
  const nextCache = cachedByOptions ?? new Map<string, string>();
  nextCache.set(cacheKey, code);
  clientModuleCache.set(template, nextCache);
  return code;
};

const listSignature = (binding: ListBinding): string =>
  `list:${JSON.stringify({
    path: binding.path,
    each: binding.each,
    key: binding.key,
    itemName: binding.itemName,
    templateHtml: binding.templateHtml,
    bindings: binding.bindings.map((child) => {
      if (child.kind === "list" || child.kind === "if") {
        return { kind: child.kind };
      }
      return child;
    }),
  })}`;

const conditionalSignature = (binding: ConditionalBinding): string =>
  `if:${JSON.stringify({
    path: binding.path,
    test: binding.test,
    templateHtml: binding.templateHtml,
    bindings: binding.bindings,
  })}`;

const bindingReadExpression = (expression: string): string => expressionToScopeAccess(expression, new Set(), "scope");

const serializeListRowBinding = (binding: ListBinding["bindings"][number]): string => {
  const fields: string[] = [`kind: ${JSON.stringify(binding.kind)}`, `path: ${JSON.stringify(binding.path)}`];
  if (binding.kind === "text") {
    fields.push(`expression: ${JSON.stringify(binding.expression)}`);
    fields.push(`read: (scope) => ${bindingReadExpression(binding.expression)}`);
  } else if (binding.kind === "class") {
    fields.push(`className: ${JSON.stringify(binding.className)}`);
    fields.push(`expression: ${JSON.stringify(binding.expression)}`);
    fields.push(`read: (scope) => ${bindingReadExpression(binding.expression)}`);
  } else if (binding.kind === "event") {
    fields.push(`eventName: ${JSON.stringify(binding.eventName)}`);
    fields.push(`handler: ${JSON.stringify(binding.handler)}`);
    fields.push(`read: (scope) => ${bindingReadExpression(binding.handler)}`);
  } else if (binding.kind === "attr") {
    fields.push(`name: ${JSON.stringify(binding.name)}`);
    fields.push(`expression: ${JSON.stringify(binding.expression)}`);
    fields.push(`read: (scope) => ${bindingReadExpression(binding.expression)}`);
  } else if (binding.kind === "style") {
    fields.push(`name: ${JSON.stringify(binding.name)}`);
    fields.push(`expression: ${JSON.stringify(binding.expression)}`);
    fields.push(`read: (scope) => ${bindingReadExpression(binding.expression)}`);
  } else if (binding.kind === "ref") {
    fields.push(`expression: ${JSON.stringify(binding.expression)}`);
  } else if (binding.kind === "model") {
    fields.push(`property: ${JSON.stringify(binding.property)}`);
    fields.push(`expression: ${JSON.stringify(binding.expression)}`);
    fields.push(`read: (scope) => ${bindingReadExpression(binding.expression)}`);
    fields.push(`write: (scope, value) => { ${bindingReadExpression(binding.expression)} = value; }`);
  } else if (binding.kind === "list") {
    const itemKeyExpression = simpleItemKeyExpression(binding.key, binding.itemName);
    fields.push(`signature: ${JSON.stringify(listSignature(binding))}`);
    fields.push(`each: ${JSON.stringify(binding.each)}`);
    fields.push(`read: (scope) => ${bindingReadExpression(binding.each)}`);
    fields.push(`itemName: ${JSON.stringify(binding.itemName)}`);
    fields.push(`key: ${JSON.stringify(binding.key)}`);
    fields.push(
      itemKeyExpression
        ? `keyReadItem: (${binding.itemName}) => ${itemKeyExpression}`
        : `keyRead: (scope) => ${bindingReadExpression(binding.key)}`,
    );
    fields.push(`templateHtml: ${JSON.stringify(binding.templateHtml)}`);
    fields.push(`bindings: [${binding.bindings.map(serializeListRowBinding).join(", ")}]`);
  } else if (binding.kind === "if") {
    fields.push(`signature: ${JSON.stringify(conditionalSignature(binding))}`);
    fields.push(`test: ${JSON.stringify(binding.test)}`);
    fields.push(`read: (scope) => ${bindingReadExpression(binding.test)}`);
    fields.push(`templateHtml: ${JSON.stringify(binding.templateHtml)}`);
    fields.push(`bindings: [${binding.bindings.map(serializeListRowBinding).join(", ")}]`);
  }
  return `{ ${fields.join(", ")} }`;
};

const emitListBinding = (
  binding: ListBinding,
  reactive: boolean,
  sourceName: string,
  index: number,
  targetName?: string,
): string => {
  const optionsName = `listOptions${index}`;
  const itemKeyExpression = simpleItemKeyExpression(binding.key, binding.itemName);
  const listOptions = [
    `  const ${optionsName} = {`,
    `    signature: ${JSON.stringify(listSignature(binding))},`,
    `    key: ${JSON.stringify(binding.key)},`,
    itemKeyExpression
      ? `    keyReadItem: (${binding.itemName}) => ${itemKeyExpression},`
      : `    keyRead: (scope) => ${bindingReadExpression(binding.key)},`,
    `    itemName: ${JSON.stringify(binding.itemName)},`,
    `    scope: ${sourceName},`,
    `    templateHtml: ${JSON.stringify(binding.templateHtml)},`,
    `    bindings: [${binding.bindings.map(serializeListRowBinding).join(", ")}],`,
    `  };`,
  ].join("\n");
  const target = targetName ?? "root";
  const path = targetName ? [] : binding.path;
  const statement = `${runtimeNames.mountKeyedList}(${target}, ${JSON.stringify(path)}, ${runtimeValueExpression(binding.each, reactive, sourceName)}, ${optionsName})`;
  return reactive
    ? `  const ${targetName} = ${elementExpression(binding.path)};\n${listOptions}\n  cleanups.push(${runtimeNames.effect}(() => ${statement}));`
    : `${listOptions}\n  ${statement};`;
};

const emitConditionalBinding = (
  binding: ConditionalBinding,
  reactive: boolean,
  sourceName: string,
  index: number,
  targetName?: string,
): string => {
  const optionsName = `conditionalOptions${index}`;
  const conditionalOptions = [
    `  const ${optionsName} = {`,
    `    signature: ${JSON.stringify(conditionalSignature(binding))},`,
    `    templateHtml: ${JSON.stringify(binding.templateHtml)},`,
    `    bindings: [${binding.bindings.map(serializeListRowBinding).join(", ")}],`,
    `  };`,
  ].join("\n");
  const target = targetName ?? "root";
  const path = targetName ? [] : binding.path;
  const statement = `${runtimeNames.mountConditional}(${target}, ${JSON.stringify(path)}, ${runtimeValueExpression(binding.test, reactive, sourceName)}, ${sourceName}, ${optionsName})`;
  return reactive
    ? `  const ${targetName} = ${nodeExpression(binding.path)};\n${conditionalOptions}\n  cleanups.push(${runtimeNames.effect}(() => ${statement}));`
    : `${conditionalOptions}\n  ${statement};`;
};
