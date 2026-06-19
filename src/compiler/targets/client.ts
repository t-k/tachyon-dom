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
} from "../types";
import { storeDefinitionsFor } from "../ir";
import {
  attrExpression,
  expressionToScopeAccess,
  isForNode,
  isStoreNode,
  itemNameFromKey,
  attrString,
  readExpressionAttribute,
  renderableChildren,
  serializeStaticAttr,
  textExpressionSegments,
} from "../utils";
import { isAssignableExpression } from "../expression";

const lowerTextNode = (node: TextNode, path: number[], context: LoweringContext): string => {
  let output = "";
  for (const segment of textExpressionSegments(node.value)) {
    if (segment.kind === "text") {
      output += segment.value;
      continue;
    }
    context.bindings.push({ kind: "text", path: [...path], expression: segment.value });
    output += " ";
  }
  return output;
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
    return lowerNode(children[0] as TemplateNode, path, context);
  }
  return children.map((child, index) => lowerNode(child, [...path, index], context)).join("");
};

const lowerIf = (node: ElementNode, path: number[], context: LoweringContext): string => {
  const childContext: LoweringContext = {
    bindings: [],
    stores: [],
    hydrationBoundaries: [],
    components: [],
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
      (binding): binding is ConditionalBinding["bindings"][number] =>
        binding.kind === "text" ||
        binding.kind === "class" ||
        binding.kind === "event" ||
        binding.kind === "attr" ||
        binding.kind === "style" ||
        binding.kind === "ref" ||
        binding.kind === "model",
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
    components: [],
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
  if (node.tagName === "outlet") {
    return "<!--tachyon-outlet-->";
  }
  if (node.tagName === "slot") {
    return `<!--tachyon-slot:${attrString(node, "name") ?? "default"}-->`;
  }
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
    if (attr.name === "hydrate:id") {
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

const elementExpression = (path: readonly number[]): string =>
  path.length === 0 ? "root" : `elementAt(root, ${JSON.stringify(path)})`;

const runtimeValueExpression = (expression: string, reactive: boolean, sourceName: string): string => {
  const value = expressionToScopeAccess(expression, new Set(), sourceName);
  return reactive ? `read(${value})` : value;
};

export const generateClientModule = (template: CompiledTemplate, options: GenerateClientModuleOptions = {}): string => {
  const bindings = template.client.bindings;
  const reactive = options.reactive === true;
  const needsStore = template.client.stores.length > 0;
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
  const lines: string[] = [];
  if (needsText) {
    lines.push(`import { setText, textAt } from "tachyon-dom/runtime/text";`);
  }
  if (needsClass || needsAttr || needsModel) {
    lines.push(
      needsClass
        ? `import { elementAt, setClassPresence } from "tachyon-dom/runtime/class";`
        : `import { elementAt } from "tachyon-dom/runtime/class";`,
    );
  }
  if (needsAttr) {
    lines.push(`import { setAttributeValue, setRef, setStyleValue } from "tachyon-dom/runtime/attr";`);
  }
  if (needsModel) {
    lines.push(`import { bindControl, setControlValue } from "tachyon-dom/runtime/form";`);
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
  lines.push(`export const componentBoundaries = ${JSON.stringify(template.client.components)};`);
  lines.push(`export const bind = (root, scope) => {`);
  if (needsStore) {
    const fields = template.client.stores
      .map((store) => `${store.name}: ${expressionToScopeAccess(store.initial)}`)
      .join(", ");
    lines.push(`  const state = createStore({ ...scope, ${fields} });`);
  }
  if (reactive || needsEvent || needsModel) {
    lines.push(`  const cleanups = [];`);
  }
  let listIndex = 0;
  for (const binding of bindings) {
    if (binding.kind === "text") {
      const statement = `setText(textAt(root, ${JSON.stringify(binding.path)}), ${runtimeValueExpression(binding.expression, reactive, sourceName)})`;
      lines.push(reactive ? `  cleanups.push(effect(() => ${statement}));` : `  ${statement};`);
    } else if (binding.kind === "class") {
      const statement = `setClassPresence(${elementExpression(binding.path)}, ${JSON.stringify(binding.className)}, ${runtimeValueExpression(binding.expression, reactive, sourceName)})`;
      lines.push(reactive ? `  cleanups.push(effect(() => ${statement}));` : `  ${statement};`);
    } else if (binding.kind === "event") {
      const statement = `delegate(root, ${JSON.stringify(binding.eventName)}, ${JSON.stringify(binding.path)}, ${expressionToScopeAccess(binding.handler, new Set(), scopeName(needsStore))})`;
      lines.push(`  cleanups.push(${statement});`);
    } else if (binding.kind === "attr") {
      const statement = `setAttributeValue(${elementExpression(binding.path)}, ${JSON.stringify(binding.name)}, ${runtimeValueExpression(binding.expression, reactive, sourceName)})`;
      lines.push(reactive ? `  cleanups.push(effect(() => ${statement}));` : `  ${statement};`);
    } else if (binding.kind === "style") {
      const statement = `setStyleValue(${elementExpression(binding.path)}, ${JSON.stringify(binding.name)}, ${runtimeValueExpression(binding.expression, reactive, sourceName)})`;
      lines.push(reactive ? `  cleanups.push(effect(() => ${statement}));` : `  ${statement};`);
    } else if (binding.kind === "ref") {
      lines.push(`  setRef(${sourceName}, ${JSON.stringify(binding.expression)}, ${elementExpression(binding.path)});`);
    } else if (binding.kind === "model") {
      const target = elementExpression(binding.path);
      const value = runtimeValueExpression(binding.expression, false, sourceName);
      lines.push(
        `  cleanups.push(bindControl(${target}, ${JSON.stringify(binding.property)}, () => ${value}, (value) => { ${expressionToScopeAccess(binding.expression, new Set(), sourceName)} = value; }));`,
      );
      if (reactive) {
        lines.push(
          `  cleanups.push(effect(() => setControlValue(${target}, ${JSON.stringify(binding.property)}, ${runtimeValueExpression(binding.expression, true, sourceName)})));`,
        );
      }
    } else if (binding.kind === "list") {
      lines.push(emitListBinding(binding, reactive, sourceName, listIndex++));
    } else {
      lines.push(emitConditionalBinding(binding, reactive, sourceName));
    }
  }
  if (reactive || needsEvent || needsModel) {
    lines.push(`  return () => {`);
    lines.push(`    for (const cleanup of cleanups) cleanup();`);
    lines.push(`  };`);
  }
  lines.push(`};`);
  return `${lines.join("\n")}\n`;
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
  }
  return `{ ${fields.join(", ")} }`;
};

const emitListBinding = (binding: ListBinding, reactive: boolean, sourceName: string, index: number): string => {
  const optionsName = `listOptions${index}`;
  const listOptions = [
    `  const ${optionsName} = {`,
    `    signature: ${JSON.stringify(listSignature(binding))},`,
    `    key: ${JSON.stringify(binding.key)},`,
    `    keyRead: (scope) => ${bindingReadExpression(binding.key)},`,
    `    itemName: ${JSON.stringify(binding.itemName)},`,
    `    templateHtml: ${JSON.stringify(binding.templateHtml)},`,
    `    bindings: [${binding.bindings.map(serializeListRowBinding).join(", ")}],`,
    `  };`,
  ].join("\n");
  const statement = `mountKeyedList(root, ${JSON.stringify(binding.path)}, ${runtimeValueExpression(binding.each, reactive, sourceName)}, ${optionsName})`;
  return reactive ? `${listOptions}\n  cleanups.push(effect(() => ${statement}));` : `${listOptions}\n  ${statement};`;
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
