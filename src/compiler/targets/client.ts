import type {
  ClientBinding,
  CompiledTemplate,
  ConditionalBinding,
  ElementNode,
  GenerateClientModuleOptions,
  HydrationBoundary,
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
  isVoidElement,
  isStoreNode,
  itemNameFromKey,
  attrString,
  assertSafeIdentifierName,
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

const emitsElementRoot = (node: TemplateNode): boolean => {
  if (node.type === "text") return false;
  if (node.tagName === "for" || node.tagName === "if" || node.tagName === "store") return false;
  if (node.tagName === "outlet" || node.tagName === "slot") return false;
  if (node.tagName === "component") {
    const children = renderableChildren(node);
    return children.length === 1 && emitsElementRoot(children[0] as TemplateNode);
  }
  return true;
};

const listRegionFor = (children: readonly TemplateNode[], index: number): ListBinding["region"] => {
  const dynamicChildren = children.filter(
    (child) => child.type === "element" && (child.tagName === "for" || child.tagName === "if"),
  );
  if (dynamicChildren.length !== 1 || dynamicChildren[0]?.type !== "element" || dynamicChildren[0].tagName !== "for") {
    return undefined;
  }
  const before = children.slice(0, index).filter(emitsElementRoot).length;
  const after = children.slice(index + 1).filter(emitsElementRoot).length;
  return before + after > 0 ? { before, after } : undefined;
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
    hydrationDynamicRegions: [],
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
    ...(childContext.stores.length > 0 ? { stores: childContext.stores } : {}),
    ...(childContext.hydrationBoundaries.length > 0 ? { hydrationBoundaries: childContext.hydrationBoundaries } : {}),
    ...(childContext.components.length > 0 ? { components: childContext.components } : {}),
  });
  return "<!---->";
};

const lowerList = (node: ElementNode, containerPath: number[], region?: ListBinding["region"]): ListBinding => {
  const key = attrExpression(node, "key") ?? "item";
  const itemName = attrString(node, "as")?.trim() || itemNameFromKey(key);
  const indexName = attrString(node, "index")?.trim();
  const childContext: LoweringContext = {
    bindings: [],
    stores: [],
    hydrationBoundaries: [],
    hydrationDynamicRegions: [],
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
    itemName,
    ...(indexName ? { indexName } : {}),
    key,
    ...(attrString(node, "update")?.trim() === "reference" ? { updatePolicy: "reference" as const } : {}),
    ...(region ? { region } : {}),
    templateHtml,
    bindings: childContext.bindings,
    ...(childContext.stores.length > 0 ? { stores: childContext.stores } : {}),
    ...(childContext.hydrationBoundaries.length > 0 ? { hydrationBoundaries: childContext.hydrationBoundaries } : {}),
    ...(childContext.components.length > 0 ? { components: childContext.components } : {}),
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
    hydrationBoundaryNodes.set(hydrateBoundary, node);
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
    if (child.type === "element" && child.tagName === "for") {
      context.hydrationDynamicRegions.push({ path: [...path], index: domIndex, kind: "list" });
      context.bindings.push(lowerList(child, path, listRegionFor(node.children, node.children.indexOf(child))));
      continue;
    }
    if (child.type === "element" && child.tagName === "if") {
      context.hydrationDynamicRegions.push({ path: [...path], index: domIndex, kind: "conditional" });
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
    hydrationDynamicRegions: [],
    components: [],
  };
  const templateHtml = lowerElement(root, [], context);
  return {
    templateHtml,
    bindings: context.bindings,
    stores: context.stores,
    hydrationBoundaries: context.hydrationBoundaries,
    hydrationDynamicRegions: context.hydrationDynamicRegions,
    components: context.components,
  };
};

const scopeName = (usesStore: boolean): string => (usesStore ? "state" : "scope");

const runtimeNames = {
  bindControl: "__tachyonBindControl",
  cleanupTextKeyedList: "__tachyonCleanupTextKeyedList",
  createStore: "__tachyonCreateStore",
  createRoot: "__tachyonCreateRoot",
  delegate: "__tachyonDelegate",
  effect: "__tachyonEffect",
  elementAt: "__tachyonElementAt",
  mountConditional: "__tachyonMountConditional",
  mountKeyedList: "__tachyonMountKeyedList",
  mountTextKeyedList: "__tachyonMountTextKeyedList",
  nodeAt: "__tachyonNodeAt",
  read: "__tachyonRead",
  setAttributeValue: "__tachyonSetAttributeValue",
  setClassPresence: "__tachyonSetClassPresence",
  setControlValue: "__tachyonSetControlValue",
  writeModelValue: "__tachyonWriteModelValue",
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

const isTextOnlyList = (binding: ListBinding): boolean =>
  binding.bindings.length > 0 &&
  binding.bindings.every((child) => child.kind === "text") &&
  (binding.stores?.length ?? 0) === 0 &&
  (binding.hydrationBoundaries?.length ?? 0) === 0 &&
  (binding.components?.length ?? 0) === 0;

const hasModelBinding = (binding: ClientBinding): boolean => {
  if (binding.kind === "model") {
    return true;
  }
  return (binding.kind === "list" || binding.kind === "if") && binding.bindings.some(hasModelBinding);
};

const clientModuleCache = new WeakMap<CompiledTemplate, Map<string, string>>();

const clientModuleCacheKey = (options: GenerateClientModuleOptions): string =>
  `${options.reactive === true ? "1" : "0"}\0${options.defaultScopeName ?? ""}\0${options.hydrationBoundaryId ?? ""}\0${options.hydrationChunk === true ? "chunk" : ""}\0${JSON.stringify(options.hydrationChunkImports ?? {})}`;

/** Maps each compiled boundary to the template node it was lowered from. */
const hydrationBoundaryNodes = new WeakMap<HydrationBoundary, ElementNode>();

/**
 * Children of a node in DOM order. `<store>` emits no node and `<component>`
 * is transparent, so boundary paths (which are DOM paths) must skip and
 * flatten them respectively.
 */
const domChildren = (node: ElementNode): TemplateNode[] =>
  renderableChildren(node).flatMap((child) => {
    if (child.type !== "element") return [child];
    if (child.tagName === "store") return [];
    if (child.tagName === "component") return domChildren(child);
    return [child];
  });

const nodeAtElementPath = (root: ElementNode, path: readonly number[]): ElementNode | undefined => {
  let current = root;
  for (const index of path) {
    const child = domChildren(current)[index];
    if (!child || child.type !== "element") return undefined;
    current = child;
  }
  return current;
};

const templateForHydrationBoundary = (template: CompiledTemplate, id: string): CompiledTemplate | undefined => {
  const boundary = template.client.hydrationBoundaries.find((candidate) => candidate.id === id);
  if (!boundary) return undefined;
  const root = hydrationBoundaryNodes.get(boundary) ?? nodeAtElementPath(template.root, boundary.path);
  if (!root) return undefined;
  return {
    ...template,
    root,
    ir: { ...template.ir, root },
    client: lowerClientTemplate(root),
  };
};

export const generateClientHydrationChunkModule = (
  template: CompiledTemplate,
  boundaryId: string,
  options: Omit<GenerateClientModuleOptions, "hydrationBoundaryId" | "hydrationChunkImports"> = {},
): string => {
  const boundaryTemplate = templateForHydrationBoundary(template, boundaryId);
  if (!boundaryTemplate) {
    throw new Error(`Cannot generate hydration chunk for boundary ${boundaryId}.`);
  }
  // A boundary chunk always receives the scope that the entry module already
  // resolved, so it must never run the SFC setup factory again.
  return generateClientModule(boundaryTemplate, {
    hydrationChunk: true,
    ...(options.reactive === undefined ? {} : { reactive: options.reactive }),
  });
};

export const generateClientModule = (template: CompiledTemplate, options: GenerateClientModuleOptions = {}): string => {
  if (options.hydrationBoundaryId !== undefined) {
    return generateClientHydrationChunkModule(template, options.hydrationBoundaryId, options);
  }
  if (options.defaultScopeName !== undefined) {
    assertSafeIdentifierName(options.defaultScopeName, "defaultScopeName");
  }
  const cacheKey = clientModuleCacheKey(options);
  const cachedByOptions = clientModuleCache.get(template);
  const cached = cachedByOptions?.get(cacheKey);
  if (cached) {
    return cached;
  }
  const bindings = template.client.bindings;
  const hydrationDynamicAttributes = bindings.flatMap((binding) => {
    if (binding.kind === "attr") {
      return [{ path: binding.path, name: binding.name }];
    }
    if (binding.kind === "class") {
      return [{ path: binding.path, name: "class", kind: "token" as const }];
    }
    if (binding.kind === "style") {
      return [{ path: binding.path, name: "style" }];
    }
    return [];
  });
  const reactive = options.reactive === true;
  const hydrationChunkImports = options.hydrationChunkImports ?? {};
  const hasHydrationChunks = Object.keys(hydrationChunkImports).length > 0;
  const isHydrationChunk = options.hydrationChunk === true;
  const needsStore = template.client.stores.length > 0;
  const hasDefaultScope = typeof options.defaultScopeName === "string" && options.defaultScopeName.length > 0;
  const sourceName = scopeName(needsStore);
  const needsText = bindings.some((binding) => binding.kind === "text");
  const needsClass = bindings.some((binding) => binding.kind === "class");
  const needsAttr = bindings.some(
    (binding) => binding.kind === "attr" || binding.kind === "style" || binding.kind === "ref",
  );
  const needsModel = bindings.some(hasModelBinding);
  const needsEvent = bindings.some((binding) => binding.kind === "event");
  const needsRef = bindings.some((binding) => binding.kind === "ref");
  const needsList = bindings.some((binding) => binding.kind === "list" && !isTextOnlyList(binding));
  const needsTextList = bindings.some((binding) => binding.kind === "list" && isTextOnlyList(binding));
  const needsConditional = bindings.some((binding) => binding.kind === "if");
  const needsSignal = reactive && bindings.some((binding) => binding.kind !== "event");
  const needsElementAt = needsClass || needsAttr || needsModel || needsTextList || (reactive && needsList);
  const needsNodeAt = reactive && needsConditional;
  const needsManualCleanup = reactive || needsEvent || needsModel || needsRef || needsTextList || hasDefaultScope;
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
      `import { bindControl as ${runtimeNames.bindControl}, setControlValue as ${runtimeNames.setControlValue}, writeModelValue as ${runtimeNames.writeModelValue} } from "tachyon-dom/runtime/form";`,
    );
  }
  if (needsEvent) {
    lines.push(`import { delegate as ${runtimeNames.delegate} } from "tachyon-dom/runtime/event";`);
  }
  if (needsList) {
    lines.push(`import { mountKeyedList as ${runtimeNames.mountKeyedList} } from "tachyon-dom/runtime/list";`);
  }
  if (needsTextList) {
    lines.push(
      `import { cleanupTextKeyedList as ${runtimeNames.cleanupTextKeyedList}, mountTextKeyedList as ${runtimeNames.mountTextKeyedList} } from "tachyon-dom/runtime/list-text";`,
    );
  }
  if (needsConditional) {
    lines.push(
      needsNodeAt
        ? `import { mountConditional as ${runtimeNames.mountConditional}, nodeAt as ${runtimeNames.nodeAt} } from "tachyon-dom/runtime/conditional";`
        : `import { mountConditional as ${runtimeNames.mountConditional} } from "tachyon-dom/runtime/conditional";`,
    );
  }
  {
    const signalImports = [
      `createRoot as ${runtimeNames.createRoot}`,
      ...(needsSignal ? [`effect as ${runtimeNames.effect}`, `read as ${runtimeNames.read}`] : []),
    ];
    lines.push(`import { ${signalImports.join(", ")} } from "tachyon-dom/runtime/signal";`);
  }
  if (needsStore) {
    lines.push(`import { createStore as ${runtimeNames.createStore} } from "tachyon-dom/runtime/store";`);
  }
  if (hasHydrationChunks) {
    lines.push(
      `import { createLazyHydrationBoundary as __tachyonCreateLazyHydrationBoundary, diagnoseHydrationBoundaries as __tachyonDiagnoseHydrationBoundaries, scheduleHydration as __tachyonScheduleHydration } from "tachyon-dom/runtime/hydrate";`,
    );
  }
  lines.push(`export const templateHtml = ${JSON.stringify(template.client.templateHtml)};`);
  lines.push(`export const hydrationBoundaries = ${JSON.stringify(template.client.hydrationBoundaries)};`);
  lines.push(`export const hydrationDynamicAttributes = ${JSON.stringify(hydrationDynamicAttributes)};`);
  lines.push(`export const hydrationDynamicRegions = ${JSON.stringify(template.client.hydrationDynamicRegions)};`);
  lines.push(`export const componentBoundaries = ${JSON.stringify(template.client.components)};`);
  if (hasHydrationChunks) {
    const loaders = Object.entries(hydrationChunkImports)
      .map(([key, moduleId]) => `${JSON.stringify(key)}: () => import(${JSON.stringify(moduleId)})`)
      .join(", ");
    lines.push(`export const hydrationChunks = { ${loaders} };`);
  }
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
  // A hydration context carries the scope and the instance-owned state that
  // the entry's hydrate() resolved once. Eager bindings and boundary chunks
  // bind with the same context instead of re-running setup or re-creating
  // stores.
  const acceptsContext = hasHydrationChunks || isHydrationChunk;
  const bindSignature = acceptsContext
    ? `(root, inputScope = {}, __tachyonSkipHydration = false, __tachyonContext = undefined)`
    : `(root, inputScope = {})`;
  lines.push(`export const bind = ${bindSignature} => ${runtimeNames.createRoot}((__tachyonDisposeRoot) => {`);
  const createScope = hasDefaultScope ? `__tachyonCreateScope(inputScope)` : `inputScope`;
  if (acceptsContext) {
    lines.push(
      `  const scope = __tachyonContext ? (__tachyonContext.state ?? __tachyonContext.scope) : ${createScope};`,
    );
  } else {
    lines.push(`  const scope = ${createScope};`);
  }
  // Stores declared inside a top-level <component> are owned by the template
  // instance too, but they are initialised after the component props so their
  // initial expressions can read those props.
  const componentStoreNames = new Set(template.client.components.flatMap((component) => component.stores.map((store) => store.name)));
  const instanceStoreFields = (): string =>
    template.client.stores
      .filter((store) => !componentStoreNames.has(store.name))
      .map((store) => `${store.name}: ${expressionToScopeAccess(store.initial)}`)
      .join(", ");
  const emitComponentScope = (indent: string, reactiveProps: boolean): string[] => {
    const emitted: string[] = [];
    for (const component of template.client.components) {
      for (const prop of component.props) {
        const value = runtimeValueExpression(prop.expression, reactiveProps, sourceName);
        emitted.push(
          reactiveProps
            ? `${indent}cleanups.push(${runtimeNames.effect}(() => { ${sourceName}.${prop.name} = ${value}; }));`
            : `${indent}${sourceName}.${prop.name} = ${value};`,
        );
      }
      for (const store of component.stores) {
        emitted.push(`${indent}${sourceName}.${store.name} = ${runtimeValueExpression(store.initial, false, sourceName)};`);
      }
    }
    return emitted;
  };
  if (needsStore) {
    const createState = `${runtimeNames.createStore}({ ...scope, ${instanceStoreFields()} })`;
    lines.push(
      acceptsContext
        ? `  const state = __tachyonContext && __tachyonContext.state ? __tachyonContext.state : ${createState};`
        : `  const state = ${createState};`,
    );
  }
  if (needsManualCleanup) {
    lines.push(`  const cleanups = [];`);
  }
  if (template.client.components.length > 0 && needsStore) {
    const componentLines = emitComponentScope("    ", reactive && needsManualCleanup);
    if (componentLines.length > 0) {
      lines.push(acceptsContext ? `  if (!(__tachyonContext && __tachyonContext.state)) {` : `  {`);
      lines.push(...componentLines);
      lines.push(`  }`);
    }
  }
  let listIndex = 0;
  let conditionalIndex = 0;
  let targetIndex = 0;
  for (const binding of bindings) {
    const bindingInHydrationBoundary =
      hasHydrationChunks &&
      template.client.hydrationBoundaries.some((boundary) =>
        boundary.path.every((part, index) => binding.path[index] === part),
      );
    const bindingStart = lines.length;
    if (bindingInHydrationBoundary) lines.push(`  if (!__tachyonSkipHydration) {`);
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
        `  cleanups.push(${runtimeNames.setRef}(${sourceName}, ${JSON.stringify(binding.expression)}, ${elementExpression(binding.path)}));`,
      );
    } else if (binding.kind === "model") {
      const target = elementExpression(binding.path);
      const value = runtimeValueExpression(binding.expression, false, sourceName);
      if (reactive) {
        const targetName = `__tachyonTarget${targetIndex++}`;
        lines.push(`  const ${targetName} = ${target};`);
        lines.push(
          `  cleanups.push(${runtimeNames.bindControl}(${targetName}, ${JSON.stringify(binding.property)}, () => ${value}, (value) => ${runtimeNames.writeModelValue}(${expressionToScopeAccess(binding.expression, new Set(), sourceName)}, value, () => { ${expressionToScopeAccess(binding.expression, new Set(), sourceName)} = value; })));`,
        );
        lines.push(
          `  cleanups.push(${runtimeNames.effect}(() => ${runtimeNames.setControlValue}(${targetName}, ${JSON.stringify(binding.property)}, ${runtimeValueExpression(binding.expression, true, sourceName)})));`,
        );
      } else {
        lines.push(
          `  cleanups.push(${runtimeNames.bindControl}(${target}, ${JSON.stringify(binding.property)}, () => ${value}, (value) => ${runtimeNames.writeModelValue}(${expressionToScopeAccess(binding.expression, new Set(), sourceName)}, value, () => { ${expressionToScopeAccess(binding.expression, new Set(), sourceName)} = value; })));`,
        );
      }
    } else if (binding.kind === "list") {
      const targetName = reactive || isTextOnlyList(binding) ? `__tachyonTarget${targetIndex++}` : undefined;
      lines.push(emitListBinding(binding, reactive, sourceName, listIndex++, targetName));
    } else {
      const targetName = reactive ? `__tachyonTarget${targetIndex++}` : undefined;
      lines.push(emitConditionalBinding(binding, reactive, sourceName, conditionalIndex++, targetName));
    }
    if (bindingInHydrationBoundary) {
      const emitted = lines.splice(bindingStart + 1);
      lines.push(...emitted.map((line) => `  ${line}`));
      lines.push(`  }`);
    }
  }
  lines.push(`  return () => {`);
  if (needsManualCleanup) {
    lines.push(`    let __tachyonCleanupError;`);
    lines.push(`    let __tachyonCleanupFailed = false;`);
    lines.push(`    for (const cleanup of cleanups) {`);
    lines.push(`      try { cleanup(); } catch (error) {`);
    lines.push(`        if (!__tachyonCleanupFailed) __tachyonCleanupError = error;`);
    lines.push(`        __tachyonCleanupFailed = true;`);
    lines.push(`      }`);
    lines.push(`    }`);
  }
  lines.push(`    try { __tachyonDisposeRoot(); } catch (error) {`);
  if (needsManualCleanup) {
    lines.push(`      if (!__tachyonCleanupFailed) __tachyonCleanupError = error;`);
    lines.push(`      __tachyonCleanupFailed = true;`);
    lines.push(`    }`);
    lines.push(`    if (__tachyonCleanupFailed) throw __tachyonCleanupError;`);
  } else {
    lines.push(`      throw error;`);
    lines.push(`    }`);
  }
  lines.push(`  };`);
  lines.push(`});`);
  if (hasHydrationChunks) {
    lines.push(
      `const __tachyonLoadHydrationChunk = (loader, context) => Promise.resolve(loader()).then((module) => ({`,
    );
    lines.push(`  bind: (element) => {`);
    lines.push(
      `    const binder = typeof module === "function" ? module : typeof module.bind === "function" ? module.bind : module.default;`,
    );
    lines.push(`    return typeof binder === "function" ? binder(element, context.scope, false, context) : undefined;`);
    lines.push(`  },`);
    lines.push(`}));`);
    lines.push(
      `export const hydrate = (bindRoot, hydrationRoot, inputScope = {}) => ${runtimeNames.createRoot}((__tachyonDisposeRoot) => {`,
    );
    if (hasDefaultScope) {
      lines.push(`  const scope = __tachyonCreateScope(inputScope);`);
    } else {
      lines.push(`  const scope = inputScope;`);
    }
    if (needsStore) {
      lines.push(`  const state = ${runtimeNames.createStore}({ ...scope, ${instanceStoreFields()} });`);
    }
    lines.push(`  const cleanups = [];`);
    if (needsStore) lines.push(...emitComponentScope("  ", reactive));
    lines.push(`  const __tachyonContext = { scope, state: ${needsStore ? "state" : "undefined"} };`);
    const boundaryIdExpressions = template.client.hydrationBoundaries.map((boundary) =>
      boundary.idKind === "expression"
        ? `String(${expressionToScopeAccess(boundary.id, new Set(), sourceName)})`
        : JSON.stringify(boundary.id),
    );
    // Preflight: every boundary in the hydration root must be adoptable
    // before any listener, loader, or effect starts.
    lines.push(
      `  const __tachyonBoundaryDiagnostics = __tachyonDiagnoseHydrationBoundaries(hydrationRoot, [${boundaryIdExpressions.join(", ")}]);`,
    );
    lines.push(
      `  if (__tachyonBoundaryDiagnostics.length > 0) throw new Error(__tachyonBoundaryDiagnostics.map((diagnostic) => diagnostic.message).join(" "));`,
    );
    lines.push(`  const eagerCleanup = bind(bindRoot, scope, true, __tachyonContext);`);
    lines.push(`  cleanups.push(eagerCleanup);`);
    let hydrationIndex = 0;
    for (const [boundaryIndex, boundary] of template.client.hydrationBoundaries.entries()) {
      const key = boundary.id;
      const idExpression = boundaryIdExpressions[boundaryIndex] as string;
      const resultName = `__tachyonBoundary${hydrationIndex++}`;
      lines.push(
        `  const ${resultName} = __tachyonCreateLazyHydrationBoundary(hydrationRoot, ${idExpression}, () => __tachyonLoadHydrationChunk(hydrationChunks[${JSON.stringify(key)}], __tachyonContext));`,
      );
      lines.push(`  if (!${resultName}.ok) throw new Error(${resultName}.error.message);`);
      lines.push(
        `  cleanups.push(__tachyonScheduleHydration(${resultName}.value, { strategy: ${JSON.stringify(boundary.strategy ?? "load")},${boundary.media ? ` media: ${JSON.stringify(boundary.media)},` : ""}${boundary.interaction ? ` interaction: ${JSON.stringify(boundary.interaction)},` : ""}${boundary.rootMargin ? ` rootMargin: ${JSON.stringify(boundary.rootMargin)},` : ""} replayInteraction: true }));`,
      );
      lines.push(`  cleanups.push(() => ${resultName}.value.dispose());`);
    }
    lines.push(`  return () => {`);
    lines.push(`    let __tachyonCleanupError;`);
    lines.push(`    let __tachyonCleanupFailed = false;`);
    lines.push(`    for (const cleanup of cleanups) {`);
    lines.push(`      try { cleanup?.(); } catch (error) {`);
    lines.push(`        if (!__tachyonCleanupFailed) __tachyonCleanupError = error;`);
    lines.push(`        __tachyonCleanupFailed = true;`);
    lines.push(`      }`);
    lines.push(`    }`);
    lines.push(`    try { __tachyonDisposeRoot(); } catch (error) {`);
    lines.push(`      if (!__tachyonCleanupFailed) __tachyonCleanupError = error;`);
    lines.push(`      __tachyonCleanupFailed = true;`);
    lines.push(`    }`);
    lines.push(`    if (__tachyonCleanupFailed) throw __tachyonCleanupError;`);
    lines.push(`  };`);
    lines.push(`});`);
  }
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
    indexName: binding.indexName,
    updatePolicy: binding.updatePolicy,
    region: binding.region,
    templateHtml: binding.templateHtml,
    bindings: binding.bindings.map((child) => {
      if (child.kind === "list" || child.kind === "if") {
        return { kind: child.kind };
      }
      return child;
    }),
    stores: binding.stores ?? [],
    hydrationBoundaries: binding.hydrationBoundaries ?? [],
    components: binding.components ?? [],
  })}`;

const conditionalSignature = (binding: ConditionalBinding): string =>
  `if:${JSON.stringify({
    path: binding.path,
    test: binding.test,
    templateHtml: binding.templateHtml,
    bindings: binding.bindings,
    stores: binding.stores ?? [],
    hydrationBoundaries: binding.hydrationBoundaries ?? [],
    components: binding.components ?? [],
  })}`;

const bindingReadExpression = (expression: string): string => expressionToScopeAccess(expression, new Set(), "scope");

const serializeStoreDefinition = (store: StoreDefinition): string =>
  `{ name: ${JSON.stringify(store.name)}, initial: ${JSON.stringify(store.initial)}, read: (scope) => ${bindingReadExpression(store.initial)} }`;

const serializeComponentBoundary = (component: NonNullable<ListBinding["components"]>[number]): string => {
  const props = component.props
    .map(
      (prop) =>
        `{ name: ${JSON.stringify(prop.name)}, expression: ${JSON.stringify(prop.expression)}, read: (scope) => ${bindingReadExpression(prop.expression)} }`,
    )
    .join(", ");
  const stores = component.stores.map(serializeStoreDefinition).join(", ");
  return `{ path: ${JSON.stringify(component.path)}, name: ${JSON.stringify(component.name)}, props: [${props}], stores: [${stores}] }`;
};

const serializeStoreDefinitions = (stores: readonly StoreDefinition[]): string =>
  `[${stores.map(serializeStoreDefinition).join(", ")}]`;

const serializeComponentBoundaries = (components: readonly NonNullable<ListBinding["components"]>[number][]): string =>
  `[${components.map(serializeComponentBoundary).join(", ")}]`;

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
    fields.push(
      `write: (scope, value) => ${runtimeNames.writeModelValue}(${bindingReadExpression(binding.expression)}, value, () => { ${bindingReadExpression(binding.expression)} = value; })`,
    );
  } else if (binding.kind === "list") {
    const itemKeyExpression = simpleItemKeyExpression(binding.key, binding.itemName);
    fields.push(`signature: ${JSON.stringify(listSignature(binding))}`);
    fields.push(`each: ${JSON.stringify(binding.each)}`);
    fields.push(`read: (scope) => ${bindingReadExpression(binding.each)}`);
    fields.push(`itemName: ${JSON.stringify(binding.itemName)}`);
    if (binding.indexName) fields.push(`indexName: ${JSON.stringify(binding.indexName)}`);
    fields.push(`key: ${JSON.stringify(binding.key)}`);
    if (binding.updatePolicy) fields.push(`updatePolicy: ${JSON.stringify(binding.updatePolicy)}`);
    if (binding.region) fields.push(`region: ${JSON.stringify(binding.region)}`);
    fields.push(`stores: ${serializeStoreDefinitions(binding.stores ?? [])}`);
    fields.push(`hydrationBoundaries: ${JSON.stringify(binding.hydrationBoundaries ?? [])}`);
    fields.push(`components: ${serializeComponentBoundaries(binding.components ?? [])}`);
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
    fields.push(`stores: ${serializeStoreDefinitions(binding.stores ?? [])}`);
    fields.push(`hydrationBoundaries: ${JSON.stringify(binding.hydrationBoundaries ?? [])}`);
    fields.push(`components: ${serializeComponentBoundaries(binding.components ?? [])}`);
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
    ...(binding.indexName ? [`    indexName: ${JSON.stringify(binding.indexName)},`] : []),
    ...(binding.updatePolicy ? [`    updatePolicy: ${JSON.stringify(binding.updatePolicy)},`] : []),
    ...(binding.region ? [`    region: ${JSON.stringify(binding.region)},`] : []),
    `    stores: ${serializeStoreDefinitions(binding.stores ?? [])},`,
    `    hydrationBoundaries: ${JSON.stringify(binding.hydrationBoundaries ?? [])},`,
    `    components: ${serializeComponentBoundaries(binding.components ?? [])},`,
    `    scope: ${sourceName},`,
    `    templateHtml: ${JSON.stringify(binding.templateHtml)},`,
    `    bindings: [${binding.bindings.map(serializeListRowBinding).join(", ")}],`,
    `  };`,
  ].join("\n");
  const target = targetName ?? "root";
  const path = targetName ? [] : binding.path;
  const mount = isTextOnlyList(binding) ? runtimeNames.mountTextKeyedList : runtimeNames.mountKeyedList;
  const statement = `${mount}(${target}, ${JSON.stringify(path)}, ${runtimeValueExpression(binding.each, reactive, sourceName)}, ${optionsName})`;
  const targetDeclaration = targetName ? `  const ${targetName} = ${elementExpression(binding.path)};\n` : "";
  const invocation = reactive ? `  cleanups.push(${runtimeNames.effect}(() => ${statement}));` : `  ${statement};`;
  const output = `${targetDeclaration}${listOptions}\n${invocation}`;
  return isTextOnlyList(binding)
    ? `${output}\n  cleanups.push(() => ${runtimeNames.cleanupTextKeyedList}(${target}, ${JSON.stringify(path)}));`
    : output;
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
    `    stores: ${serializeStoreDefinitions(binding.stores ?? [])},`,
    `    hydrationBoundaries: ${JSON.stringify(binding.hydrationBoundaries ?? [])},`,
    `    components: ${serializeComponentBoundaries(binding.components ?? [])},`,
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
