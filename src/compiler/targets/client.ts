import type {
  ClientBinding,
  ComponentBoundary,
  ComponentProp,
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
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { storeDefinitionsFor } from "../ir.js";
import type { ExpressionSourceLocation } from "../utils.js";
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
  expressionLocationForAttribute,
  expressionLocationForText,
} from "../utils.js";
import { isAssignableExpression } from "../expression.js";

type LoweredNode = {
  html: string;
  nodeCount: number;
};

type LexicalScope = {
  parent?: LexicalScope;
  bindings: Map<string, string>;
};

type DeclarationState = {
  next: number;
  stores: WeakMap<ElementNode, StoreDefinition[]>;
  props: WeakMap<ElementNode, ComponentProp[]>;
};

type ClientLoweringContext = LoweringContext & {
  lexicalScope: LexicalScope;
  declarations: DeclarationState;
};

/** Template source spans of client bindings, kept beside the compiled objects. */
const bindingSpans = new WeakMap<ClientBinding, ExpressionSourceLocation>();
const bindingScopes = new WeakMap<ClientBinding, LexicalScope>();
const declarationScopes = new WeakMap<object, LexicalScope>();
const declarationKeys = new WeakMap<object, string>();
const componentScopes = new WeakMap<ComponentBoundary, { parent: LexicalScope; own: LexicalScope }>();

const createChildScope = (parent: LexicalScope): LexicalScope => ({ parent, bindings: new Map() });

const aliasesForScope = (scope: LexicalScope): ReadonlyMap<string, string> => {
  const aliases = new Map<string, string>();
  const chain: LexicalScope[] = [];
  for (let current: LexicalScope | undefined = scope; current; current = current.parent) {
    chain.push(current);
  }
  for (const current of chain.reverse()) {
    for (const [name, key] of current.bindings) {
      aliases.set(name, key);
    }
  }
  return aliases;
};

const nextDeclarationKey = (context: ClientLoweringContext, kind: string, path: readonly number[]): string => {
  const owner = path.length === 0 ? "root" : path.join("_");
  const key = `__tachyon_${kind}_${owner}_${context.declarations.next}`;
  context.declarations.next++;
  return key;
};

const storeDefinitionsForNode = (
  node: ElementNode,
  path: readonly number[],
  context: ClientLoweringContext,
  forceUnique = false,
): StoreDefinition[] => {
  const cached = context.declarations.stores.get(node);
  if (cached) return cached;
  const stores = storeDefinitionsFor(node);
  for (const store of stores) {
    declarationKeys.set(
      store,
      forceUnique || context.lexicalScope.parent ? nextDeclarationKey(context, "store", path) : store.name,
    );
  }
  context.declarations.stores.set(node, stores);
  return stores;
};

const componentPropsForNode = (
  node: ElementNode,
  path: readonly number[],
  context: ClientLoweringContext,
): ComponentProp[] => {
  const cached = context.declarations.props.get(node);
  if (cached) return cached;
  const props = node.attrs.flatMap((attr) => {
    if (attr.name === "name") return [];
    const expression = readExpressionAttribute(attr.value);
    return expression ? [{ name: attr.name, expression }] : [];
  });
  for (const prop of props) declarationKeys.set(prop, nextDeclarationKey(context, "prop", path));
  context.declarations.props.set(node, props);
  return props;
};

const recordSpan = <B extends ClientBinding>(binding: B, location: ExpressionSourceLocation | undefined): B => {
  if (location) bindingSpans.set(binding, location);
  return binding;
};

const recordBinding = <B extends ClientBinding>(
  binding: B,
  location: ExpressionSourceLocation | undefined,
  context: ClientLoweringContext,
): B => {
  bindingScopes.set(binding, context.lexicalScope);
  return recordSpan(binding, location);
};

/** Returns the template offsets of the expression a client binding was lowered from. */
export const bindingSourceSpan = (binding: ClientBinding): ExpressionSourceLocation | undefined =>
  bindingSpans.get(binding);

const lowerTextNode = (node: TextNode, path: number[], context: ClientLoweringContext): LoweredNode => {
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
    context.bindings.push(
      recordBinding(
        {
          kind: "text",
          path: [...path.slice(0, -1), (path.at(-1) ?? 0) + nodeOffset],
          expression: segment.value,
        },
        expressionLocationForText(node, segment),
        context,
      ),
    );
    output += " ";
    nodeOffset++;
    lastEmittedWasText = true;
  }
  return { html: output, nodeCount: nodeOffset };
};

const addStoreDefinitions = (node: ElementNode, path: readonly number[], context: ClientLoweringContext): void => {
  const stores = storeDefinitionsForNode(node, path, context);
  for (const store of stores) {
    if (!context.stores.includes(store)) context.stores.push(store);
    const key = declarationKeys.get(store);
    if (key) context.lexicalScope.bindings.set(store.name, key);
    declarationScopes.set(store, context.lexicalScope);
  }
};

const componentStores = (
  node: ElementNode,
  path: readonly number[],
  context: ClientLoweringContext,
): StoreDefinition[] => {
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
      stores.push(...storeDefinitionsForNode(child, path, context, true));
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

const lowerComponent = (node: ElementNode, path: number[], context: ClientLoweringContext): string => {
  const props = componentPropsForNode(node, path, context);
  const stores = componentStores(node, path, context);
  const ownScope = createChildScope(context.lexicalScope);
  for (const prop of props) {
    const key = declarationKeys.get(prop);
    if (key) ownScope.bindings.set(prop.name, key);
    declarationScopes.set(prop, context.lexicalScope);
  }
  for (const store of stores) {
    const key = declarationKeys.get(store);
    if (key) ownScope.bindings.set(store.name, key);
    declarationScopes.set(store, ownScope);
    if (!context.stores.includes(store)) context.stores.push(store);
  }
  const component: ComponentBoundary = {
    path: [...path],
    name: attrString(node, "name") ?? "Anonymous",
    props,
    stores,
  };
  componentScopes.set(component, { parent: context.lexicalScope, own: ownScope });
  context.components.push(component);
  const childContext: ClientLoweringContext = { ...context, lexicalScope: ownScope };
  const children = renderableChildren(node);
  if (children.length === 0) {
    return "";
  }
  if (children.length === 1) {
    return lowerNode(children[0] as TemplateNode, path, childContext).html;
  }
  let html = "";
  let domIndex = 0;
  for (const child of children) {
    const lowered = lowerNode(child, [...path, domIndex], childContext);
    html += lowered.html;
    domIndex += lowered.nodeCount;
  }
  return html;
};

const lowerIf = (node: ElementNode, path: number[], context: ClientLoweringContext): string => {
  const childContext: ClientLoweringContext = {
    bindings: [],
    stores: [],
    hydrationBoundaries: [],
    hydrationDynamicRegions: [],
    components: [],
    lexicalScope: createChildScope(context.lexicalScope),
    declarations: context.declarations,
  };
  const children = renderableChildren(node);
  const renderedChildren = children.filter(
    (child) => child.type !== "element" || (child.tagName !== "store" && child.tagName !== "for"),
  );
  let templateHtml = "";
  let domIndex = 0;
  for (const child of children) {
    const lowered = lowerNode(child, renderedChildren.length === 1 ? [] : [domIndex], childContext);
    templateHtml += lowered.html;
    domIndex += lowered.nodeCount;
  }
  context.bindings.push(
    recordBinding(
      {
        kind: "if",
        path: [...path],
        test: attrExpression(node, "test") ?? "false",
        templateHtml,
        bindings: childContext.bindings,
        ...(childContext.stores.length > 0 ? { stores: childContext.stores } : {}),
        ...(childContext.hydrationBoundaries.length > 0
          ? { hydrationBoundaries: childContext.hydrationBoundaries }
          : {}),
        ...(childContext.components.length > 0 ? { components: childContext.components } : {}),
      },
      expressionLocationForAttribute(node.attrs.find((attr) => attr.name === "test") ?? { value: true }),
      context,
    ),
  );
  return "<!---->";
};

const lowerList = (
  node: ElementNode,
  containerPath: number[],
  context: ClientLoweringContext,
  region?: ListBinding["region"],
): ListBinding => {
  const key = attrExpression(node, "key") ?? "item";
  const itemName = attrString(node, "as")?.trim() || itemNameFromKey(key);
  const indexName = attrString(node, "index")?.trim();
  const childScope = createChildScope(context.lexicalScope);
  childScope.bindings.set(itemName, itemName);
  if (indexName) childScope.bindings.set(indexName, indexName);
  const childContext: ClientLoweringContext = {
    bindings: [],
    stores: [],
    hydrationBoundaries: [],
    hydrationDynamicRegions: [],
    components: [],
    lexicalScope: childScope,
    declarations: context.declarations,
  };
  const children = renderableChildren(node);
  let templateHtml = "";
  let domIndex = 0;
  for (const child of children) {
    const lowered = lowerNode(child, children.length === 1 ? [] : [domIndex], childContext);
    templateHtml += lowered.html;
    domIndex += lowered.nodeCount;
  }
  return recordBinding(
    {
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
    },
    expressionLocationForAttribute(node.attrs.find((attr) => attr.name === "each") ?? { value: true }),
    context,
  );
};

const lowerElement = (node: ElementNode, path: number[], context: ClientLoweringContext): string => {
  if (node.tagName === "outlet") {
    return "<!--tachyon-outlet-->";
  }
  if (node.tagName === "slot") {
    return `<!--tachyon-slot:${attrString(node, "name") ?? "default"}-->`;
  }
  if (node.tagName === "for") {
    context.bindings.push(lowerList(node, path, context));
    return "";
  }
  if (node.tagName === "if") {
    return lowerIf(node, path, context);
  }
  if (node.tagName === "store") {
    addStoreDefinitions(node, path, context);
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
        context.bindings.push(
          recordBinding(
            { kind: "event", path: [...path], eventName: attr.name.slice(3), handler },
            expressionLocationForAttribute(attr),
            context,
          ),
        );
      }
      continue;
    }
    if (attr.name.startsWith("bind:")) {
      const expression = readExpressionAttribute(attr.value);
      if (expression && isAssignableExpression(expression)) {
        const property = attr.name.slice(5) === "checked" ? "checked" : "value";
        context.bindings.push(
          recordBinding(
            { kind: "model", path: [...path], property, expression },
            expressionLocationForAttribute(attr),
            context,
          ),
        );
      }
      continue;
    }
    if (attr.name === "ref") {
      const expression = readExpressionAttribute(attr.value);
      if (expression) {
        context.bindings.push(
          recordBinding({ kind: "ref", path: [...path], expression }, expressionLocationForAttribute(attr), context),
        );
      }
      continue;
    }
    if (attr.name.startsWith("style:")) {
      const expression = readExpressionAttribute(attr.value);
      if (expression) {
        context.bindings.push(
          recordBinding(
            { kind: "style", path: [...path], name: attr.name.slice(6), expression },
            expressionLocationForAttribute(attr),
            context,
          ),
        );
      }
      continue;
    }
    if (attr.name.startsWith("class:")) {
      const expression = readExpressionAttribute(attr.value);
      if (expression) {
        context.bindings.push(
          recordBinding(
            { kind: "class", path: [...path], className: attr.name.slice(6), expression },
            expressionLocationForAttribute(attr),
            context,
          ),
        );
      }
      continue;
    }
    const expression = readExpressionAttribute(attr.value);
    if (expression) {
      context.bindings.push(
        recordBinding(
          { kind: "attr", path: [...path], name: attr.name, expression },
          expressionLocationForAttribute(attr),
          context,
        ),
      );
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
      context.bindings.push(
        lowerList(child, path, context, listRegionFor(node.children, node.children.indexOf(child))),
      );
      continue;
    }
    if (child.type === "element" && child.tagName === "if") {
      context.hydrationDynamicRegions.push({ path: [...path], index: domIndex, kind: "conditional" });
    }
    if (isStoreNode(child)) {
      addStoreDefinitions(child, [...path, domIndex], context);
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

const lowerNode = (node: TemplateNode, path: number[], context: ClientLoweringContext): LoweredNode => {
  if (node.type === "text") {
    return lowerTextNode(node, path, context);
  }
  return {
    html: lowerElement(node, path, context),
    nodeCount: node.tagName === "store" || node.tagName === "for" ? 0 : 1,
  };
};

export const lowerClientTemplate = (root: ElementNode): CompiledTemplate["client"] => {
  const context: ClientLoweringContext = {
    bindings: [],
    stores: [],
    hydrationBoundaries: [],
    hydrationDynamicRegions: [],
    components: [],
    lexicalScope: { bindings: new Map() },
    declarations: { next: 0, stores: new WeakMap(), props: new WeakMap() },
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

const runtimeValueExpression = (
  expression: string,
  reactive: boolean,
  sourceName: string,
  aliases: ReadonlyMap<string, string> = new Map(),
): string => {
  const value = expressionToScopeAccess(expression, new Set(), sourceName, aliases);
  return reactive ? `${runtimeNames.read}(${value})` : value;
};

const aliasesForBinding = (binding: ClientBinding): ReadonlyMap<string, string> => {
  const scope = bindingScopes.get(binding);
  return scope ? aliasesForScope(scope) : new Map();
};

const aliasesForDeclaration = (declaration: object): ReadonlyMap<string, string> => {
  const scope = declarationScopes.get(declaration);
  return scope ? aliasesForScope(scope) : new Map();
};

const declarationKeyFor = (declaration: object, fallback: string): string =>
  declarationKeys.get(declaration) ?? fallback;

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

const hexDigest = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const sourceRevisionFor = (source: string): string => hexDigest(sha256(utf8ToBytes(source)));

const clientModuleCacheKey = (options: GenerateClientModuleOptions): string =>
  `${options.reactive === true ? "1" : "0"}\0${options.defaultScopeName ?? ""}\0${options.hydrationBoundaryId ?? ""}\0${options.hydrationChunk === true ? "chunk" : ""}\0${options.hydrateOnly === true ? "hydrate-only" : ""}\0${options.instrumentBindings === false ? "0" : "1"}\0${options.templateId ?? ""}\0${options.sourceRevision ?? ""}\0${JSON.stringify(options.hydrationChunkImports ?? {})}`;

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
  // The chunk registers its own template id so bindings created after the
  // asynchronous load are attributed explicitly instead of via a global.
  const sourceRevision = options.sourceRevision ?? sourceRevisionFor(template.source);
  const templateId =
    typeof options.templateId === "string" && options.templateId.length > 0
      ? options.templateId
      : `anonymous:${sourceRevision}:chunk:${hexDigest(sha256(utf8ToBytes(boundaryId)))}`;
  return generateClientModule(boundaryTemplate, {
    hydrationChunk: true,
    ...(options.reactive === undefined ? {} : { reactive: options.reactive }),
    templateId,
    sourceRevision,
    ...(options.mapSourceOffset ? { mapSourceOffset: options.mapSourceOffset } : {}),
    ...(options.instrumentBindings === undefined ? {} : { instrumentBindings: options.instrumentBindings }),
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
  const allBindings = template.client.bindings;
  const hydrateOnly = options.hydrateOnly === true;
  const withinHydrationBoundary = (binding: ClientBinding): boolean =>
    template.client.hydrationBoundaries.some((boundary) =>
      boundary.path.every((part, index) => binding.path[index] === part),
    );
  // A hydrate-only module removes boundary bindings at generation time, so the
  // runtime imports below are computed from the eager bindings alone.
  const bindings = hydrateOnly ? allBindings.filter((binding) => !withinHydrationBoundary(binding)) : allBindings;
  const hydrationDynamicAttributes = allBindings.flatMap((binding) => {
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
  const emitsHydrate = hasHydrationChunks || hydrateOnly;
  const bindName = hydrateOnly ? "__tachyonBindEager" : "bind";
  const instrumentBindings = options.instrumentBindings !== false;
  const sourceRevision = options.sourceRevision ?? sourceRevisionFor(template.source);
  const templateId =
    typeof options.templateId === "string" && options.templateId.length > 0
      ? options.templateId
      : `anonymous:${sourceRevision}`;
  const mapSourceOffset = options.mapSourceOffset ?? ((offset: number): number => offset);
  const bindingLocationId = (index: number): string => `${templateId}#${sourceRevision}#${index}`;
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
    if (instrumentBindings) {
      lines.push(
        `import { enterBindingLocation as __tachyonEnterBinding, exitBindingLocation as __tachyonExitBinding, registerTemplateBindings as __tachyonRegisterBindings } from "tachyon-dom/runtime/signal";`,
      );
    }
  }
  if (needsStore) {
    lines.push(`import { createStore as ${runtimeNames.createStore} } from "tachyon-dom/runtime/store";`);
  }
  if (hasHydrationChunks) {
    lines.push(
      `import { createLazyHydrationBoundary as __tachyonCreateLazyHydrationBoundary, diagnoseHydrationBoundaries as __tachyonDiagnoseHydrationBoundaries, scheduleHydration as __tachyonScheduleHydration } from "tachyon-dom/runtime/hydrate";`,
    );
  }
  if (hydrateOnly) {
    lines.push(`export const hydrateOnly = true;`);
  }
  if (instrumentBindings) {
    const spans = bindings.map((binding, index) => {
      const span = bindingSourceSpan(binding);
      return `[${index}, ${JSON.stringify(binding.kind)}, ${JSON.stringify(binding.path)}, ${
        span ? `${mapSourceOffset(span.start)}, ${mapSourceOffset(span.end)}` : "-1, -1"
      }]`;
    });
    lines.push(`const __tachyonRegisterTemplate = () => {`);
    lines.push(`  if (typeof __TACHYON_PRODUCTION__ !== "undefined" && __TACHYON_PRODUCTION__) return;`);
    lines.push(
      `  __tachyonRegisterBindings(${JSON.stringify(templateId)}, ${JSON.stringify(sourceRevision)}, [${spans.join(", ")}]);`,
    );
    lines.push(`};`);
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
  const acceptsContext = hasHydrationChunks || isHydrationChunk || hydrateOnly;
  const bindSignature = acceptsContext
    ? `(root, inputScope = {}, __tachyonSkipHydration = false, __tachyonContext = undefined)`
    : `(root, inputScope = {})`;
  lines.push(
    `${hydrateOnly ? "const" : "export const"} ${bindName} = ${bindSignature} => ${runtimeNames.createRoot}((__tachyonDisposeRoot) => {`,
  );
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
  const componentStoreKeys = new Set(
    template.client.components.flatMap((component) =>
      component.stores.map((store) => declarationKeyFor(store, store.name)),
    ),
  );
  const instanceStoreFields = (): string =>
    template.client.stores
      .filter((store) => !componentStoreKeys.has(declarationKeyFor(store, store.name)))
      .map((store) => {
        const key = declarationKeyFor(store, store.name);
        const property = key === store.name ? key : `[${JSON.stringify(key)}]`;
        return `${property}: ${expressionToScopeAccess(store.initial, new Set(), "scope", aliasesForDeclaration(store))}`;
      })
      .join(", ");
  const emitComponentScope = (indent: string, reactiveProps: boolean): string[] => {
    const emitted: string[] = [];
    for (const component of template.client.components) {
      const componentScope = componentScopes.get(component);
      const parentAliases = componentScope ? aliasesForScope(componentScope.parent) : new Map();
      const ownAliases = componentScope ? aliasesForScope(componentScope.own) : new Map();
      for (const prop of component.props) {
        const value = runtimeValueExpression(prop.expression, reactiveProps, sourceName, parentAliases);
        const key = declarationKeyFor(prop, prop.name);
        emitted.push(
          reactiveProps
            ? `${indent}cleanups.push(${runtimeNames.effect}(() => { ${sourceName}[${JSON.stringify(key)}] = ${value}; }));`
            : `${indent}${sourceName}[${JSON.stringify(key)}] = ${value};`,
        );
      }
      for (const store of component.stores) {
        emitted.push(
          `${indent}${sourceName}[${JSON.stringify(declarationKeyFor(store, store.name))}] = ${runtimeValueExpression(
            store.initial,
            false,
            sourceName,
            ownAliases,
          )};`,
        );
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
    lines.push(`  try {`);
  }
  if (template.client.components.length > 0 && needsStore) {
    const componentLines = emitComponentScope("    ", reactive && needsManualCleanup);
    if (componentLines.length > 0) {
      lines.push(acceptsContext ? `  if (!(__tachyonContext && __tachyonContext.state)) {` : `  {`);
      lines.push(...componentLines);
      lines.push(`  }`);
    }
  }
  if (instrumentBindings) lines.push(`  __tachyonRegisterTemplate();`);
  let listIndex = 0;
  let conditionalIndex = 0;
  let targetIndex = 0;
  for (const [bindingIndex, binding] of bindings.entries()) {
    const bindingAliases = aliasesForBinding(binding);
    const bindingInHydrationBoundary = hasHydrationChunks && !hydrateOnly && withinHydrationBoundary(binding);
    const bindingStart = lines.length;
    if (bindingInHydrationBoundary) lines.push(`  if (!__tachyonSkipHydration) {`);
    if (instrumentBindings) {
      lines.push(
        `  const __tachyonPreviousBinding${bindingIndex} = typeof __TACHYON_PRODUCTION__ === "undefined" || !__TACHYON_PRODUCTION__ ? __tachyonEnterBinding(${JSON.stringify(bindingLocationId(bindingIndex))}) : undefined;`,
      );
      lines.push(`  try {`);
    }
    if (binding.kind === "text") {
      const target = `${runtimeNames.textAt}(root, ${JSON.stringify(binding.path)})`;
      if (reactive) {
        const targetName = `__tachyonTarget${targetIndex++}`;
        lines.push(`  const ${targetName} = ${target};`);
        lines.push(
          `  cleanups.push(${runtimeNames.effect}(() => ${runtimeNames.setText}(${targetName}, ${runtimeValueExpression(binding.expression, reactive, sourceName, bindingAliases)})));`,
        );
      } else {
        lines.push(
          `  ${runtimeNames.setText}(${target}, ${runtimeValueExpression(binding.expression, reactive, sourceName, bindingAliases)});`,
        );
      }
    } else if (binding.kind === "class") {
      const target = elementExpression(binding.path);
      if (reactive) {
        const targetName = `__tachyonTarget${targetIndex++}`;
        lines.push(`  const ${targetName} = ${target};`);
        lines.push(
          `  cleanups.push(${runtimeNames.effect}(() => ${runtimeNames.setClassPresence}(${targetName}, ${JSON.stringify(binding.className)}, ${runtimeValueExpression(binding.expression, reactive, sourceName, bindingAliases)})));`,
        );
      } else {
        lines.push(
          `  ${runtimeNames.setClassPresence}(${target}, ${JSON.stringify(binding.className)}, ${runtimeValueExpression(binding.expression, reactive, sourceName, bindingAliases)});`,
        );
      }
    } else if (binding.kind === "event") {
      const statement = `${runtimeNames.delegate}(root, ${JSON.stringify(binding.eventName)}, ${JSON.stringify(binding.path)}, ${expressionToScopeAccess(binding.handler, new Set(), scopeName(needsStore), bindingAliases)})`;
      lines.push(`  cleanups.push(${statement});`);
    } else if (binding.kind === "attr") {
      const target = elementExpression(binding.path);
      if (reactive) {
        const targetName = `__tachyonTarget${targetIndex++}`;
        lines.push(`  const ${targetName} = ${target};`);
        lines.push(
          `  cleanups.push(${runtimeNames.effect}(() => ${runtimeNames.setAttributeValue}(${targetName}, ${JSON.stringify(binding.name)}, ${runtimeValueExpression(binding.expression, reactive, sourceName, bindingAliases)})));`,
        );
      } else {
        lines.push(
          `  ${runtimeNames.setAttributeValue}(${target}, ${JSON.stringify(binding.name)}, ${runtimeValueExpression(binding.expression, reactive, sourceName, bindingAliases)});`,
        );
      }
    } else if (binding.kind === "style") {
      const target = elementExpression(binding.path);
      if (reactive) {
        const targetName = `__tachyonTarget${targetIndex++}`;
        lines.push(`  const ${targetName} = ${target};`);
        lines.push(
          `  cleanups.push(${runtimeNames.effect}(() => ${runtimeNames.setStyleValue}(${targetName}, ${JSON.stringify(binding.name)}, ${runtimeValueExpression(binding.expression, reactive, sourceName, bindingAliases)})));`,
        );
      } else {
        lines.push(
          `  ${runtimeNames.setStyleValue}(${target}, ${JSON.stringify(binding.name)}, ${runtimeValueExpression(binding.expression, reactive, sourceName, bindingAliases)});`,
        );
      }
    } else if (binding.kind === "ref") {
      lines.push(
        `  cleanups.push(${runtimeNames.setRef}(${sourceName}, ${JSON.stringify(binding.expression)}, ${elementExpression(binding.path)}));`,
      );
    } else if (binding.kind === "model") {
      const target = elementExpression(binding.path);
      const value = runtimeValueExpression(binding.expression, false, sourceName, bindingAliases);
      if (reactive) {
        const targetName = `__tachyonTarget${targetIndex++}`;
        lines.push(`  const ${targetName} = ${target};`);
        lines.push(
          `  cleanups.push(${runtimeNames.bindControl}(${targetName}, ${JSON.stringify(binding.property)}, () => ${value}, (value) => ${runtimeNames.writeModelValue}(${expressionToScopeAccess(binding.expression, new Set(), sourceName, bindingAliases)}, value, () => { ${expressionToScopeAccess(binding.expression, new Set(), sourceName, bindingAliases)} = value; })));`,
        );
        lines.push(
          `  cleanups.push(${runtimeNames.effect}(() => ${runtimeNames.setControlValue}(${targetName}, ${JSON.stringify(binding.property)}, ${runtimeValueExpression(binding.expression, true, sourceName, bindingAliases)})));`,
        );
      } else {
        lines.push(
          `  cleanups.push(${runtimeNames.bindControl}(${target}, ${JSON.stringify(binding.property)}, () => ${value}, (value) => ${runtimeNames.writeModelValue}(${expressionToScopeAccess(binding.expression, new Set(), sourceName, bindingAliases)}, value, () => { ${expressionToScopeAccess(binding.expression, new Set(), sourceName, bindingAliases)} = value; })));`,
        );
      }
    } else if (binding.kind === "list") {
      const targetName = reactive || isTextOnlyList(binding) ? `__tachyonTarget${targetIndex++}` : undefined;
      lines.push(emitListBinding(binding, reactive, sourceName, listIndex++, targetName, bindingAliases));
    } else {
      const targetName = reactive ? `__tachyonTarget${targetIndex++}` : undefined;
      lines.push(emitConditionalBinding(binding, reactive, sourceName, conditionalIndex++, targetName, bindingAliases));
    }
    if (instrumentBindings) {
      lines.push(`  } finally {`);
      lines.push(
        `    if (typeof __TACHYON_PRODUCTION__ === "undefined" || !__TACHYON_PRODUCTION__) __tachyonExitBinding(__tachyonPreviousBinding${bindingIndex});`,
      );
      lines.push(`  }`);
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
  if (needsManualCleanup) {
    lines.push(`  } catch (error) {`);
    lines.push(`    for (const cleanup of cleanups.splice(0).reverse()) {`);
    lines.push(`      try { cleanup(); } catch {}`);
    lines.push(`    }`);
    lines.push(`    throw error;`);
    lines.push(`  }`);
  }
  lines.push(`});`);
  if (emitsHydrate && hasHydrationChunks) {
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
  }
  if (emitsHydrate) {
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
    if (hasHydrationChunks) {
      lines.push(
        `  const __tachyonBoundaryDiagnostics = __tachyonDiagnoseHydrationBoundaries(hydrationRoot, [${boundaryIdExpressions.join(", ")}]);`,
      );
      lines.push(
        `  if (__tachyonBoundaryDiagnostics.length > 0) throw new Error(__tachyonBoundaryDiagnostics.map((diagnostic) => diagnostic.message).join(" "));`,
      );
    }
    // Anything bound before a later failure is released again, so a failed
    // hydrate never leaves listeners behind for a retry to duplicate.
    lines.push(`  const __tachyonReleaseHydration = () => {`);
    lines.push(`    for (const cleanup of cleanups.splice(0).reverse()) {`);
    lines.push(`      try { cleanup?.(); } catch {}`);
    lines.push(`    }`);
    lines.push(`  };`);
    lines.push(`  try {`);
    lines.push(`    cleanups.push(${bindName}(bindRoot, scope, true, __tachyonContext));`);
    let hydrationIndex = 0;
    for (const [boundaryIndex, boundary] of hasHydrationChunks ? template.client.hydrationBoundaries.entries() : []) {
      const key = boundary.id;
      const idExpression = boundaryIdExpressions[boundaryIndex] as string;
      const resultName = `__tachyonBoundary${hydrationIndex++}`;
      lines.push(
        `    const ${resultName} = __tachyonCreateLazyHydrationBoundary(hydrationRoot, ${idExpression}, () => __tachyonLoadHydrationChunk(hydrationChunks[${JSON.stringify(key)}], __tachyonContext));`,
      );
      lines.push(`    if (!${resultName}.ok) throw new Error(${resultName}.error.message);`);
      lines.push(`    cleanups.push(() => ${resultName}.value.dispose());`);
      lines.push(
        `    cleanups.push(__tachyonScheduleHydration(${resultName}.value, { strategy: ${JSON.stringify(boundary.strategy ?? "load")},${boundary.media ? ` media: ${JSON.stringify(boundary.media)},` : ""}${boundary.interaction ? ` interaction: ${JSON.stringify(boundary.interaction)},` : ""}${boundary.rootMargin ? ` rootMargin: ${JSON.stringify(boundary.rootMargin)},` : ""} replayInteraction: true }));`,
      );
    }
    lines.push(`  } catch (error) {`);
    lines.push(`    __tachyonReleaseHydration();`);
    lines.push(`    throw error;`);
    lines.push(`  }`);
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

const bindingReadExpression = (expression: string, aliases: ReadonlyMap<string, string> = new Map()): string =>
  expressionToScopeAccess(expression, new Set(), "scope", aliases);

const serializeStoreDefinition = (store: StoreDefinition): string => {
  const key = declarationKeyFor(store, store.name);
  const keyField = key === store.name ? "" : `, key: ${JSON.stringify(key)}`;
  return `{ name: ${JSON.stringify(store.name)}${keyField}, initial: ${JSON.stringify(store.initial)}, read: (scope) => ${bindingReadExpression(store.initial, aliasesForDeclaration(store))} }`;
};

const serializeComponentBoundary = (component: NonNullable<ListBinding["components"]>[number]): string => {
  const props = component.props
    .map(
      (prop) =>
        `{ name: ${JSON.stringify(prop.name)}, ${declarationKeyFor(prop, prop.name) === prop.name ? "" : `key: ${JSON.stringify(declarationKeyFor(prop, prop.name))}, `}expression: ${JSON.stringify(prop.expression)}, read: (scope) => ${bindingReadExpression(prop.expression, aliasesForDeclaration(prop))} }`,
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
  const aliases = aliasesForBinding(binding);
  if (binding.kind === "text") {
    fields.push(`expression: ${JSON.stringify(binding.expression)}`);
    fields.push(`read: (scope) => ${bindingReadExpression(binding.expression, aliases)}`);
  } else if (binding.kind === "class") {
    fields.push(`className: ${JSON.stringify(binding.className)}`);
    fields.push(`expression: ${JSON.stringify(binding.expression)}`);
    fields.push(`read: (scope) => ${bindingReadExpression(binding.expression, aliases)}`);
  } else if (binding.kind === "event") {
    fields.push(`eventName: ${JSON.stringify(binding.eventName)}`);
    fields.push(`handler: ${JSON.stringify(binding.handler)}`);
    fields.push(`read: (scope) => ${bindingReadExpression(binding.handler, aliases)}`);
  } else if (binding.kind === "attr") {
    fields.push(`name: ${JSON.stringify(binding.name)}`);
    fields.push(`expression: ${JSON.stringify(binding.expression)}`);
    fields.push(`read: (scope) => ${bindingReadExpression(binding.expression, aliases)}`);
  } else if (binding.kind === "style") {
    fields.push(`name: ${JSON.stringify(binding.name)}`);
    fields.push(`expression: ${JSON.stringify(binding.expression)}`);
    fields.push(`read: (scope) => ${bindingReadExpression(binding.expression, aliases)}`);
  } else if (binding.kind === "ref") {
    fields.push(`expression: ${JSON.stringify(binding.expression)}`);
  } else if (binding.kind === "model") {
    fields.push(`property: ${JSON.stringify(binding.property)}`);
    fields.push(`expression: ${JSON.stringify(binding.expression)}`);
    fields.push(`read: (scope) => ${bindingReadExpression(binding.expression, aliases)}`);
    fields.push(
      `write: (scope, value) => ${runtimeNames.writeModelValue}(${bindingReadExpression(binding.expression, aliases)}, value, () => { ${bindingReadExpression(binding.expression, aliases)} = value; })`,
    );
  } else if (binding.kind === "list") {
    const itemKeyExpression = simpleItemKeyExpression(binding.key, binding.itemName);
    fields.push(`signature: ${JSON.stringify(listSignature(binding))}`);
    fields.push(`each: ${JSON.stringify(binding.each)}`);
    fields.push(`read: (scope) => ${bindingReadExpression(binding.each, aliases)}`);
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
        : `keyRead: (scope) => ${bindingReadExpression(binding.key, aliases)}`,
    );
    fields.push(`templateHtml: ${JSON.stringify(binding.templateHtml)}`);
    fields.push(`bindings: [${binding.bindings.map(serializeListRowBinding).join(", ")}]`);
  } else if (binding.kind === "if") {
    fields.push(`signature: ${JSON.stringify(conditionalSignature(binding))}`);
    fields.push(`test: ${JSON.stringify(binding.test)}`);
    fields.push(`read: (scope) => ${bindingReadExpression(binding.test, aliases)}`);
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
  aliases: ReadonlyMap<string, string> = new Map(),
): string => {
  const optionsName = `listOptions${index}`;
  const itemKeyExpression = simpleItemKeyExpression(binding.key, binding.itemName);
  const listOptions = [
    `  const ${optionsName} = {`,
    `    signature: ${JSON.stringify(listSignature(binding))},`,
    `    key: ${JSON.stringify(binding.key)},`,
    itemKeyExpression
      ? `    keyReadItem: (${binding.itemName}) => ${itemKeyExpression},`
      : `    keyRead: (scope) => ${bindingReadExpression(binding.key, aliases)},`,
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
  const statement = `${mount}(${target}, ${JSON.stringify(path)}, ${runtimeValueExpression(binding.each, reactive, sourceName, aliases)}, ${optionsName})`;
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
  aliases: ReadonlyMap<string, string> = new Map(),
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
  const statement = `${runtimeNames.mountConditional}(${target}, ${JSON.stringify(path)}, ${runtimeValueExpression(binding.test, reactive, sourceName, aliases)}, ${sourceName}, ${optionsName})`;
  return reactive
    ? `  const ${targetName} = ${nodeExpression(binding.path)};\n${conditionalOptions}\n  cleanups.push(${runtimeNames.effect}(() => ${statement}));`
    : `${conditionalOptions}\n  ${statement};`;
};
