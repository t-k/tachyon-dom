import type {
  AttributeBinding,
  ClassBinding,
  ClientBinding,
  ComponentBoundary,
  ComponentProp,
  CompiledTemplate,
  ConditionalBinding,
  ElementNode,
  EventBinding,
  GenerateClientModuleOptions,
  HydrationBoundary,
  ListBinding,
  LoweringContext,
  StoreDefinition,
  StyleBinding,
  TemplateNode,
  TextBinding,
  TextNode,
} from "../types.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { storeDefinitionsFor } from "../ir.js";
import type { ExpressionSourceLocation } from "../utils.js";
import {
  attrExpression,
  automaticHydrationId,
  childPathEntries,
  expressionToScopeAccess,
  jsOptionalPropertyAccess,
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
  transparentListRootFor,
  expressionLocationForAttribute,
  expressionLocationForText,
} from "../utils.js";
import { isAssignableExpression } from "../expression.js";
import {
  conditionalEndMarker,
  conditionalStartMarker,
  listEndMarker,
  listStartMarker,
} from "../../conditional-marker.js";
import { expressionAlwaysPlainValue, expressionCallsSomething, expressionScopeNames } from "../optimize.js";

type LoweredNode = {
  html: string;
  nodeCount: number;
};

const hydrationShapesForChildren = (children: readonly TemplateNode[]): string[] =>
  children
    .filter((child) => {
      if (child.type === "text") return child.value.length > 0;
      return child.tagName !== "store" && child.tagName !== "for";
    })
    .map(hydrationShapeForNode)
    .filter((shape) => shape.length > 0);

const hydrationShapeForChildren = (children: readonly TemplateNode[]): string =>
  JSON.stringify(hydrationShapesForChildren(children));

const matcherAttributeIsIgnored = (attribute: { name: string; value: string | true }): boolean => {
  const name = attribute.name.toLowerCase();
  return (
    isHydrationAttribute(name) ||
    name.startsWith("on:") ||
    name.startsWith("bind:") ||
    name.startsWith("style:") ||
    name.startsWith("class:") ||
    name === "ref" ||
    readExpressionAttribute(attribute.value) !== undefined
  );
};

const hydrationShapeForRegion = (children: readonly TemplateNode[]): string => {
  const shapes = hydrationShapesForChildren(children);
  return shapes.length === 1 ? (shapes[0] as string) : JSON.stringify(shapes);
};

const hydrationShapeForStaticAttributes = (node: ElementNode): string[] =>
  node.attrs
    .flatMap((attr) => {
      if (matcherAttributeIsIgnored(attr)) return [];
      return [[attr.name.toLowerCase(), attr.value === true ? "" : attr.value] as const];
    })
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`);

const hydrationShapeForNode = (node: TemplateNode): string => {
  if (node.type === "text") return node.value.length > 0 ? "text" : "";
  if (node.tagName === "store" || node.tagName === "for") return "";
  if (node.tagName === "if" || node.tagName === "outlet" || node.tagName === "slot") return "comment";
  if (node.tagName === "component") return hydrationShapeForChildren(node.children);
  return `element:${node.tagName.toLowerCase()}:${JSON.stringify(hydrationShapeForStaticAttributes(node))}:${hydrationShapeForChildren(node.children)}`;
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
  hydrationIds: WeakMap<ElementNode, string>;
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

/** Counts the client child nodes used by generated binding paths, including text separators. */
const loweredNodeCount = (node: TemplateNode): number => {
  if (node.type === "text") {
    const segmentCount = textExpressionSegments(node.value).filter((segment) => segment.value.length > 0).length;
    return segmentCount === 0 ? 0 : segmentCount * 2 - 1;
  }
  if (node.tagName === "store" || node.tagName === "for") return 0;
  if (node.tagName === "component") return loweredNodeCountFor(renderableChildren(node));
  return 1;
};

const loweredNodeCountFor = (children: readonly TemplateNode[]): number =>
  children.reduce((count, child) => count + loweredNodeCount(child), 0);

/** Where a list sits in its parent: the ordinal of its marker pair and the logical slot its rows start at. */
const listRegionOf = (ordinal: number, at: number): ListBinding["region"] =>
  ordinal === 0 && at === 0 ? undefined : { ...(ordinal ? { index: ordinal } : {}), ...(at ? { at } : {}) };

const lowerComponent = (
  node: ElementNode,
  path: number[],
  context: ClientLoweringContext,
  listRegion?: ListBinding["region"],
): string => {
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
    const child = children[0] as TemplateNode;
    const childPath = child.type === "element" && child.tagName === "for" ? path.slice(0, -1) : path;
    return lowerNode(child, childPath, childContext, listRegion).html;
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
    hydrationDynamicRegionErrors: context.hydrationDynamicRegionErrors,
    components: [],
    lexicalScope: createChildScope(context.lexicalScope),
    declarations: context.declarations,
    hydrationIds: context.hydrationIds,
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
  // The slot and its end marker. A mounted branch lives between them, exactly like a server-rendered one; the
  // end marker is invisible to logical paths, so the region still occupies one slot.
  return `${conditionalStartMarker}${conditionalEndMarker}`;
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
    hydrationDynamicRegionErrors: context.hydrationDynamicRegionErrors,
    components: [],
    lexicalScope: childScope,
    declarations: context.declarations,
    hydrationIds: context.hydrationIds,
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

const lowerElement = (
  node: ElementNode,
  path: number[],
  context: ClientLoweringContext,
  listRegion?: ListBinding["region"],
): string => {
  if (node.tagName === "outlet") {
    return "<!--tachyon-outlet-->";
  }
  if (node.tagName === "slot") {
    return `<!--tachyon-slot:${attrString(node, "name") ?? "default"}-->`;
  }
  if (node.tagName === "for") {
    context.bindings.push(lowerList(node, path, context, listRegion));
    // The region's markers. Rows live between them, exactly like server-rendered ones; both markers are
    // invisible to logical paths, so the list still occupies no slot in its parent.
    return `${listStartMarker}${listEndMarker}`;
  }
  if (node.tagName === "if") {
    return lowerIf(node, path, context);
  }
  if (node.tagName === "store") {
    addStoreDefinitions(node, path, context);
    return "";
  }
  if (node.tagName === "component") {
    return lowerComponent(node, path, context, listRegion);
  }


  const attrs: string[] = [];
  const staticClassNames: string[] = [];
  const hydrateBoundary = hydrationBoundaryFor(node, path);
  if (hydrateBoundary) {
    // IDs follow source paths like SSR, while binding paths remain local to the branch or row.
    if (hydrateBoundary.idKind === "static") hydrateBoundary.id = context.hydrationIds.get(node)!;
    context.hydrationBoundaries.push(hydrateBoundary);
    hydrationBoundaryNodes.set(hydrateBoundary, node);
    // The id reader is evaluated against the same scope as the bindings beside it.
    declarationScopes.set(hydrateBoundary, context.lexicalScope);
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
  let listOrdinal = 0;
  for (const child of node.children) {
    const transparentListRoot = transparentListRootFor(child);
    const childListRegion = transparentListRoot ? listRegionOf(listOrdinal++, domIndex) : undefined;
    // A direct `<for>` is bound against this element, so its path is the container's own.
    const childPath = transparentListRoot === child ? path : [...path, domIndex];
    if (transparentListRoot) {
      context.hydrationDynamicRegions.push({ path: [...path], index: domIndex, kind: "list" });
    }
    if (child.type === "element" && child.tagName === "if") {
      context.hydrationDynamicRegions.push({ path: [...path], index: domIndex, kind: "conditional" });
    }
    if (isStoreNode(child)) {
      addStoreDefinitions(child, [...path, domIndex], context);
      continue;
    }
    const lowered = lowerNode(child, childPath, context, childListRegion);
    children += lowered.html;
    domIndex += lowered.nodeCount;
  }
  return isVoidElement(node)
    ? `<${node.tagName}${attrs.join("")}>`
    : `<${node.tagName}${attrs.join("")}>${children}</${node.tagName}>`;
};

const lowerNode = (
  node: TemplateNode,
  path: number[],
  context: ClientLoweringContext,
  listRegion?: ListBinding["region"],
): LoweredNode => {
  if (node.type === "text") {
    return lowerTextNode(node, path, context);
  }
  return {
    html: lowerElement(node, path, context, listRegion),
    nodeCount: loweredNodeCount(node),
  };
};

export const lowerClientTemplate = (root: ElementNode): CompiledTemplate["client"] => {
  const hydrationIds = new WeakMap<ElementNode, string>();
  const recordHydrationIds = (node: ElementNode, path: readonly number[]): void => {
    hydrationIds.set(node, automaticHydrationId(path));
    const children = node.tagName === "component" ? renderableChildren(node) : node.children;
    if (node.tagName === "component" && children.length === 1) {
      const child = children[0]!;
      if (child.type === "element") recordHydrationIds(child, path);
      return;
    }
    for (const entry of childPathEntries(children, path)) {
      if (entry.child.type === "element") recordHydrationIds(entry.child, entry.path);
    }
  };
  recordHydrationIds(root, []);
  const context: ClientLoweringContext = {
    bindings: [],
    stores: [],
    hydrationBoundaries: [],
    hydrationDynamicRegions: [],
    hydrationDynamicRegionErrors: [],
    components: [],
    lexicalScope: { bindings: new Map() },
    declarations: { next: 0, stores: new WeakMap(), props: new WeakMap() },
    hydrationIds,
  };
  const templateHtml = lowerElement(root, [], context);
  return {
    templateHtml,
    bindings: context.bindings,
    stores: context.stores,
    hydrationBoundaries: context.hydrationBoundaries,
    hydrationDynamicRegions: context.hydrationDynamicRegions,
    hydrationDynamicRegionErrors: context.hydrationDynamicRegionErrors,
    components: context.components,
  };
};

const scopeName = (usesStore: boolean): string => (usesStore ? "state" : "scope");

const runtimeNames = {
  bindControl: "__tachyonBindControl",
  cleanupTextKeyedList: "__tachyonCleanupTextKeyedList",
  createStore: "__tachyonCreateStore",
  createMemo: "__tachyonCreateMemo",
  createRoot: "__tachyonCreateRoot",
  delegate: "__tachyonDelegate",
  effect: "__tachyonEffect",
  elementAt: "__tachyonElementAt",
  mountGeneratedConditional: "__tachyonMountGeneratedConditional",
  mountGeneratedConditionalCore: "__tachyonMountGeneratedConditionalCore",
  prepareConditionalCore: "__tachyonPrepareConditionalCore",
  prepareConditionalCoreForMount: "__tachyonPrepareConditionalCoreForMount",
  prepareConditionalCoreWithAdoptionGuard: "__tachyonPrepareConditionalCoreWithAdoptionGuard",
  prepareConditionalCoreWithStaticAttributes: "__tachyonPrepareConditionalCoreWithStaticAttributes",
  prepareConditionalCoreWithAdoptionGuardAndStaticAttributes:
    "__tachyonPrepareConditionalCoreWithAdoptionGuardAndStaticAttributes",
  preparedNodeAt: "__tachyonPreparedNodeAt",
  mountGeneratedKeyedList: "__tachyonMountGeneratedKeyedList",
  mountTextKeyedList: "__tachyonMountTextKeyedList",
  nodeAt: "__tachyonNodeAt",
  read: "__tachyonRead",
  setAttributeValue: "__tachyonSetAttributeValue",
  setClassPresence: "__tachyonSetClassPresence",
  setClassValue: "__tachyonSetClassValue",
  setControlValue: "__tachyonSetControlValue",
  writeModelValue: "__tachyonWriteModelValue",
  bindRef: "__tachyonBindRef",
  createHydrationBoundary: "__tachyonCreateHydrationBoundary",
  scheduleHydration: "__tachyonScheduleHydration",
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
  // Only a binding whose whole value could be an accessor needs unwrapping; a computed result never is.
  return reactive && !expressionAlwaysPlainValue(expression) ? `${runtimeNames.read}(${value})` : value;
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

// Rows the generated adapter can drive on its own: their setters are injected by the generated module, so the
// adapter never reaches for the generic binding runtime. Refs, models, styles, nested regions, stores,
// component boundaries, and hydration boundaries all fall back to the general keyed list.
const generatedRowBindingKinds = new Set(["text", "class", "attr", "event"]);

const isTextOnlyList = (binding: ListBinding): boolean =>
  binding.bindings.length > 0 &&
  binding.bindings.every((child) => generatedRowBindingKinds.has(child.kind)) &&
  binding.bindings.some((child) => child.kind !== "event") &&
  (binding.stores?.length ?? 0) === 0 &&
  (binding.hydrationBoundaries?.length ?? 0) === 0 &&
  (binding.components?.length ?? 0) === 0;

/**
 * The bindings inside every nested region a module mounts, at any depth.
 *
 * Rows and branches are both driven by setters the generated module injects, so the kinds inside them decide
 * its imports exactly like a top-level binding does.
 */
const generatedNestedBindings = (children: readonly ClientBinding[]): ClientBinding[] =>
  children.flatMap((binding) =>
    binding.kind === "list" || binding.kind === "if"
      ? [...binding.bindings, ...generatedNestedBindings(binding.bindings)]
      : [],
  );

const isConditionalCoreBinding = (binding: ClientBinding): boolean =>
  binding.kind === "text" ||
  binding.kind === "class" ||
  binding.kind === "event" ||
  binding.kind === "attr" ||
  binding.kind === "style";

const usesConditionalCore = (binding: ConditionalBinding): boolean =>
  (binding.stores?.length ?? 0) === 0 &&
  (binding.hydrationBoundaries?.length ?? 0) === 0 &&
  (binding.components?.length ?? 0) === 0 &&
  binding.bindings.every(isConditionalCoreBinding);

const hasStaticConditionalRootAttribute = (templateHtml: string): boolean =>
  /<[A-Za-z][^\s/>]*(?:\s+[A-Za-z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)/.test(templateHtml);

const hydrationRootTagName = (shape: string): string | undefined => {
  if (shape.startsWith("element:")) return shape.slice("element:".length).split(":", 1)[0];
  try {
    const parsed: unknown = JSON.parse(shape);
    if (Array.isArray(parsed) && typeof parsed[0] === "string" && parsed[0].startsWith("element:")) {
      return parsed[0].slice("element:".length).split(":", 1)[0];
    }
  } catch {
    return undefined;
  }
  return undefined;
};

const conditionalRootTagName = (templateHtml: string): string | undefined =>
  templateHtml.match(/^\s*<([A-Za-z][\w:.-]*)/)?.[1]?.toLowerCase();

const hasConditionalSiblingRootShape = (root: ElementNode, binding: ConditionalBinding): boolean => {
  const parent = nodeAtElementPath(root, binding.path.slice(0, -1));
  const index = binding.path.at(-1);
  const expectedTag = conditionalRootTagName(binding.templateHtml);
  if (!parent || index === undefined || !expectedTag) return false;
  return domChildren(parent).some((child, childIndex) => {
    if (childIndex === index || child.type !== "element") return false;
    const siblingTag =
      child.tagName === "if" || child.tagName === "for"
        ? hydrationRootTagName(hydrationShapeForRegion(child.children))
        : child.tagName.toLowerCase();
    return siblingTag === expectedTag;
  });
};

const conditionalDynamicAttributes = (
  binding: ConditionalBinding,
): Array<{
  path: number[];
  name: string;
  kind?: "value" | "token";
}> =>
  binding.bindings.flatMap((child) => {
    if (child.kind === "attr") return [{ path: child.path, name: child.name }];
    if (child.kind === "class") return [{ path: child.path, name: "class", kind: "token" as const }];
    if (child.kind === "style") return [{ path: child.path, name: "style" }];
    return [];
  });

const hasStaticConditionalSiblingAttribute = (root: ElementNode, binding: ConditionalBinding): boolean => {
  const parent = nodeAtElementPath(root, binding.path.slice(0, -1));
  const index = binding.path.at(-1);
  return (
    parent !== undefined &&
    index !== undefined &&
    domChildren(parent).some(
      (child, childIndex) =>
        childIndex !== index &&
        child.type === "element" &&
        child.tagName !== "if" &&
        child.tagName !== "for" &&
        hydrationShapeForStaticAttributes(child).length > 0,
    )
  );
};

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
  `${options.reactive === true ? "1" : "0"}\0${options.defaultScopeName ?? ""}\0${options.hydrationBoundaryId ?? ""}\0${options.hydrationChunk === true ? "chunk" : ""}\0${options.hydrateOnly === true ? "hydrate-only" : ""}\0${options.mountOnly === true ? "mount-only" : ""}\0${options.instrumentBindings === false ? "0" : "1"}\0${options.templateId ?? ""}\0${options.sourceRevision ?? ""}\0${JSON.stringify(options.hydrationChunkImports ?? {})}`;

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
  if (
    options.mountOnly === true &&
    (options.hydrateOnly === true || options.hydrationChunk === true || options.hydrationBoundaryId !== undefined)
  ) {
    throw new TypeError("A mount-only client module cannot also be hydrate-only or a hydration chunk.");
  }
  // Hydration boundaries only mean anything against server output, so a template that declares one cannot be
  // compiled as mount-only. Accepting it would emit the hydrate entry the mode exists to leave out.
  if (options.mountOnly === true && template.client.hydrationBoundaries.length > 0) {
    throw new TypeError(
      "A mount-only client module cannot contain hydration boundaries; remove hydrate: directives or generate it without mount-only.",
    );
  }
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
  const mountOnly = options.mountOnly === true;
  const withinHydrationBoundary = (binding: ClientBinding): boolean =>
    template.client.hydrationBoundaries.some((boundary) =>
      boundary.path.every((part, index) => binding.path[index] === part),
    );
  // A boundary nested inside this chunk's root loads through its own chunk, so the innermost boundary owns the
  // bindings inside it and this chunk never registers them a second time.
  const withinNestedHydrationBoundary = (binding: ClientBinding): boolean =>
    template.client.hydrationBoundaries.some(
      (boundary) => boundary.path.length > 0 && boundary.path.every((part, index) => binding.path[index] === part),
    );
  // A hydrate-only module removes boundary bindings at generation time, so the
  // runtime imports below are computed from the eager bindings alone.
  const bindings = hydrateOnly
    ? allBindings.filter((binding) => !withinHydrationBoundary(binding))
    : options.hydrationChunk === true
      ? allBindings.filter((binding) => !withinNestedHydrationBoundary(binding))
      : allBindings;
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
  // A statically named class attribute is exactly what setClassValue does, so it skips the generic attribute
  // setter and its name validation and URL sanitization, which never applied to class in the first place.
  const isKnownClassAttribute = (binding: ClientBinding): boolean =>
    binding.kind === "attr" && binding.name.toLowerCase() === "class";
  // Generated rows and generated branches are driven by setters this module injects, so their kinds decide its
  // imports too.
  const generatedRowBindings = generatedNestedBindings(bindings);
  const needsElementClass = bindings.some((binding) => binding.kind === "class" || isKnownClassAttribute(binding));
  const needsElementAttr = bindings.some(
    (binding) =>
      (binding.kind === "attr" && !isKnownClassAttribute(binding)) ||
      binding.kind === "style" ||
      binding.kind === "ref",
  );
  const bindingsNeedingRuntime = [...bindings, ...generatedRowBindings];
  const needsClassPresence = bindingsNeedingRuntime.some((binding) => binding.kind === "class");
  const needsClassValue = bindingsNeedingRuntime.some(isKnownClassAttribute);
  const needsInjectedDelegate = generatedRowBindings.some((binding) => binding.kind === "event");
  const needsModel = bindings.some(hasModelBinding);
  const needsEvent = bindings.some((binding) => binding.kind === "event") || needsInjectedDelegate;
  const needsRef = bindings.some((binding) => binding.kind === "ref");
  // Every nested region carries the entry that mounts it, so the module that emits the descriptor imports it.
  const needsList =
    bindings.some((binding) => binding.kind === "list" && !isTextOnlyList(binding)) ||
    generatedRowBindings.some((binding) => binding.kind === "list");
  const needsTextList = bindings.some((binding) => binding.kind === "list" && isTextOnlyList(binding));
  const needsNestedConditional = generatedRowBindings.some((binding) => binding.kind === "if");
  const needsConditional = bindings.some((binding) => binding.kind === "if") || needsNestedConditional;
  const needsConditionalCore = bindings.some((binding) => binding.kind === "if" && usesConditionalCore(binding));
  // Every top-level branch needs its anchor reserved before it mounts against server output: SSR omits the
  // anchor comment, so a generic branch that looked for one on its own found the server element instead and
  // silently never bound. A mount-only module renders its own template, anchors included, so only the
  // lightweight branches keep paying for the preparation there.
  const needsConditionalPrepare =
    needsConditionalCore || (!mountOnly && bindings.some((binding) => binding.kind === "if"));
  const needsGenericConditional =
    bindings.some((binding) => binding.kind === "if" && !usesConditionalCore(binding)) || needsNestedConditional;
  // Boundaries are adopted through the runtime the region's descriptor carries, for the same reason.
  const needsRowHydration = [...bindings, ...generatedRowBindings].some(
    (binding) =>
      (binding.kind === "list" || (binding.kind === "if" && !usesConditionalCore(binding))) &&
      (binding.hydrationBoundaries?.length ?? 0) > 0,
  );
  const needsConditionalCoreAdoptionGuard =
    needsConditionalCore &&
    bindings.some(
      (binding) =>
        binding.kind === "if" &&
        usesConditionalCore(binding) &&
        bindings.some(
          (candidate) =>
            candidate.kind === "if" &&
            candidate.path.length === binding.path.length &&
            candidate.path.slice(0, -1).every((part, index) => part === binding.path[index]) &&
            (candidate.path.at(-1) ?? -1) > (binding.path.at(-1) ?? -1),
        ),
    );
  const needsConditionalCoreShapeMatcher =
    needsConditionalCore &&
    bindings.some(
      (binding) =>
        binding.kind === "if" &&
        usesConditionalCore(binding) &&
        (hasStaticConditionalRootAttribute(binding.templateHtml) ||
          hasStaticConditionalSiblingAttribute(template.root, binding) ||
          hasConditionalSiblingRootShape(template.root, binding)),
    );
  const needsSignal = reactive && bindings.some((binding) => binding.kind !== "event");
  const needsElementAt =
    needsElementClass || needsElementAttr || needsModel || needsTextList || (reactive && needsList);
  const needsNodeAt = reactive && needsGenericConditional && !needsConditionalPrepare;
  // Manual cleanup only pays for itself when something actually registers a disposer. A reactive template with
  // no reactive binding, store, or component boundary registers nothing, so it keeps the bare root disposer.
  // Reactive list, conditional, component, and value bindings wrap their work in an effect and register its
  // disposer; without reactivity they run once and register nothing. Events, models, refs, and text lists always
  // register one.
  const registersReactiveCleanup =
    reactive &&
    (needsList ||
      needsConditional ||
      needsStore ||
      template.client.components.length > 0 ||
      bindings.some(
        (binding) =>
          binding.kind === "text" || binding.kind === "class" || binding.kind === "attr" || binding.kind === "style",
      ));
  const needsManualCleanup =
    registersReactiveCleanup || needsEvent || needsModel || needsRef || needsTextList || hasDefaultScope;
  const lines: string[] = [];
  if (needsText) {
    lines.push(
      `import { setText as ${runtimeNames.setText}, textAt as ${runtimeNames.textAt} } from "tachyon-dom/runtime/text";`,
    );
  }
  const classImports = [
    ...(needsElementAt ? [`elementAt as ${runtimeNames.elementAt}`] : []),
    ...(needsClassPresence ? [`setClassPresence as ${runtimeNames.setClassPresence}`] : []),
    ...(needsClassValue ? [`setClassValue as ${runtimeNames.setClassValue}`] : []),
  ];
  if (classImports.length > 0) {
    lines.push(`import { ${classImports.join(", ")} } from "tachyon-dom/runtime/class";`);
  }
  const attrImports = [
    ...(bindingsNeedingRuntime.some((binding) => binding.kind === "attr" && !isKnownClassAttribute(binding))
      ? [`setAttributeValue as ${runtimeNames.setAttributeValue}`]
      : []),
    ...(needsRef ? [`bindRef as ${runtimeNames.bindRef}`] : []),
    ...(bindingsNeedingRuntime.some((binding) => binding.kind === "style")
      ? [`setStyleValue as ${runtimeNames.setStyleValue}`]
      : []),
  ];
  if (attrImports.length > 0) {
    lines.push(`import { ${attrImports.join(", ")} } from "tachyon-dom/runtime/attr";`);
  }
  if (needsModel) {
    lines.push(
      `import { bindControl as ${runtimeNames.bindControl}, setControlValue as ${runtimeNames.setControlValue}, writeModelValue as ${runtimeNames.writeModelValue} } from "tachyon-dom/runtime/form";`,
    );
  }
  if (needsEvent) {
    // Every listener this module registers resolves its target first and then delegates with an empty path, so
    // the target-only variant is never generated.
    lines.push(`import { delegate as ${runtimeNames.delegate} } from "tachyon-dom/runtime/event";`);
  }
  if (needsList) {
    lines.push(
      `import { mountGeneratedKeyedList as ${runtimeNames.mountGeneratedKeyedList} } from "tachyon-dom/runtime/list";`,
    );
  }
  if (needsTextList) {
    const textListImports = [
      `cleanupTextKeyedList as ${runtimeNames.cleanupTextKeyedList}`,
      `mountGeneratedTextKeyedList as ${runtimeNames.mountTextKeyedList}`,
    ];
    lines.push(`import { ${textListImports.join(", ")} } from "tachyon-dom/runtime/list-text";`);
  }
  if (needsConditional) {
    if (needsConditionalPrepare) {
      const conditionalCoreImports = [
        ...(needsConditionalCore
          ? [`mountGeneratedConditionalCore as ${runtimeNames.mountGeneratedConditionalCore}`]
          : []),
        `${
          mountOnly
            ? "prepareConditionalCoreForMount"
            : needsConditionalCoreShapeMatcher
              ? needsConditionalCoreAdoptionGuard
                ? "prepareConditionalCoreWithAdoptionGuardAndStaticAttributes"
                : "prepareConditionalCoreWithStaticAttributes"
              : needsConditionalCoreAdoptionGuard
                ? "prepareConditionalCoreWithAdoptionGuard"
                : "prepareConditionalCore"
        } as ${mountOnly ? runtimeNames.prepareConditionalCoreForMount : runtimeNames.prepareConditionalCore}`,
        `preparedNodeAt as ${runtimeNames.preparedNodeAt}`,
      ];
      lines.push(`import { ${conditionalCoreImports.join(", ")} } from "tachyon-dom/runtime/conditional-core";`);
    }
    if (needsGenericConditional) {
      const entry = needsRowHydration ? "mountGeneratedConditional" : "mountGeneratedConditionalWithoutHydration";
      lines.push(
        needsNodeAt
          ? `import { ${entry} as ${runtimeNames.mountGeneratedConditional}, nodeAt as ${runtimeNames.nodeAt} } from "tachyon-dom/runtime/conditional";`
          : `import { ${entry} as ${runtimeNames.mountGeneratedConditional} } from "tachyon-dom/runtime/conditional";`,
      );
    }
  }
  {
    const signalImports = [
      `createRoot as ${runtimeNames.createRoot}`,
      ...(needsConditionalPrepare && reactive ? [`createMemo as ${runtimeNames.createMemo}`] : []),
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
    lines.push(`import { createScopeStore as ${runtimeNames.createStore} } from "tachyon-dom/runtime/store";`);
  }
  const hydrateImports = [
    ...(hasHydrationChunks
      ? [
          `createLazyHydrationBoundary as __tachyonCreateLazyHydrationBoundary`,
          `diagnoseHydrationBoundaries as __tachyonDiagnoseHydrationBoundaries`,
        ]
      : []),
    ...(needsRowHydration ? [`createHydrationBoundary as ${runtimeNames.createHydrationBoundary}`] : []),
    ...(hasHydrationChunks || needsRowHydration ? [`scheduleHydration as ${runtimeNames.scheduleHydration}`] : []),
  ];
  if (hydrateImports.length > 0) {
    lines.push(`import { ${hydrateImports.join(", ")} } from "tachyon-dom/runtime/hydrate";`);
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
  if (mountOnly) {
    // Hydration metadata exists to validate server output; a mount-only module never sees any.
    lines.push(`export const mountOnly = true;`);
  } else {
    lines.push(`export const hydrationBoundaries = ${JSON.stringify(template.client.hydrationBoundaries)};`);
    lines.push(`export const hydrationDynamicAttributes = ${JSON.stringify(hydrationDynamicAttributes)};`);
    lines.push(`export const hydrationDynamicRegions = ${JSON.stringify(template.client.hydrationDynamicRegions)};`);
    if (template.client.hydrationDynamicRegionErrors.length > 0) {
      lines.push(`hydrationDynamicRegions.errors = ${JSON.stringify(template.client.hydrationDynamicRegionErrors)};`);
    }
    lines.push(`export const componentBoundaries = ${JSON.stringify(template.client.components)};`);
  }
  if (hasHydrationChunks) {
    const loaders = Object.entries(hydrationChunkImports)
      .map(([key, moduleId]) => `${JSON.stringify(key)}: () => import(${JSON.stringify(moduleId)})`)
      .join(", ");
    lines.push(`export const hydrationChunks = { ${loaders} };`);
  }
  if (hasDefaultScope) {
    lines.push(`import { mergeScopes as __tachyonMergeScopes } from "tachyon-dom/runtime/store";`);
  }
  if (hasDefaultScope) {
    lines.push(`const __tachyonCreateScope = (inputScope = {}) => {`);
    lines.push(
      `  const localScope = typeof ${options.defaultScopeName} === "function" ? ${options.defaultScopeName}(inputScope) : ${options.defaultScopeName};`,
    );
    lines.push(
      `  return localScope && typeof localScope === "object" ? __tachyonMergeScopes(localScope, inputScope) : inputScope;`,
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
    const createState = `${runtimeNames.createStore}(scope, { ${instanceStoreFields()} })`;
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
  const conditionalVisibilityNames = new Map<ConditionalBinding, string>();
  if (needsConditionalPrepare) {
    let visibilityIndex = 0;
    for (const binding of bindings) {
      if (binding.kind !== "if") continue;
      const visibilityName = `__tachyonConditionalVisibility${visibilityIndex++}`;
      conditionalVisibilityNames.set(binding, visibilityName);
      lines.push(
        reactive
          ? `  const ${visibilityName} = ${runtimeNames.createMemo}(() => ${runtimeValueExpression(binding.test, true, sourceName, aliasesForBinding(binding))});`
          : `  const ${visibilityName} = ${runtimeValueExpression(binding.test, false, sourceName, aliasesForBinding(binding))};`,
      );
    }
    if (mountOnly) {
      // A mount renders the template itself, so only the conditional positions are needed.
      lines.push(
        `  ${runtimeNames.prepareConditionalCoreForMount}(root, [${bindings
          .filter((binding) => binding.kind === "if")
          .map((binding) => `{ path: ${JSON.stringify(binding.path)} }`)
          .join(", ")}]);`,
      );
    } else {
      lines.push(`  ${runtimeNames.prepareConditionalCore}(root, [`);
      for (const binding of bindings) {
        if (binding.kind !== "if") continue;
        const parent = nodeAtElementPath(template.root, binding.path.slice(0, -1));
        const visibilityName = conditionalVisibilityNames.get(binding) as string;
        const visibility = reactive ? `${visibilityName}()` : visibilityName;
        const bindingIndex = binding.path.at(-1);
        const laterConditionals =
          bindingIndex === undefined
            ? []
            : bindings
                .filter(
                  (candidate): candidate is ConditionalBinding =>
                    candidate.kind === "if" &&
                    candidate.path.length === binding.path.length &&
                    candidate.path.slice(0, -1).every((part, index) => part === binding.path[index]) &&
                    (candidate.path.at(-1) ?? -1) > bindingIndex,
                )
                .map((candidate) => {
                  const candidateVisibilityName = conditionalVisibilityNames.get(candidate) as string;
                  const candidateVisibility = reactive ? `${candidateVisibilityName}()` : candidateVisibilityName;
                  const dynamicAttributes = conditionalDynamicAttributes(candidate);
                  const dynamicAttributeField =
                    needsConditionalCoreShapeMatcher && dynamicAttributes.length > 0
                      ? `, dynamicAttributes: ${JSON.stringify(dynamicAttributes)}`
                      : "";
                  return `{ visible: ${candidateVisibility}, templateHtml: ${JSON.stringify(candidate.templateHtml)}${dynamicAttributeField} }`;
                });
        const laterDescriptor =
          laterConditionals.length > 0 ? ` laterConditionals: [${laterConditionals.join(", ")}],` : "";
        const dynamicAttributes = conditionalDynamicAttributes(binding);
        const dynamicAttributeField =
          needsConditionalCoreShapeMatcher && dynamicAttributes.length > 0
            ? ` dynamicAttributes: ${JSON.stringify(dynamicAttributes)},`
            : "";
        lines.push(
          `    { path: ${JSON.stringify(binding.path)}, visible: ${visibility},${parent ? ` parentTagName: ${JSON.stringify(parent.tagName)},` : ""}${laterDescriptor}${dynamicAttributeField} templateHtml: ${JSON.stringify(binding.templateHtml)} },`,
        );
      }
      lines.push(`  ]);`);
    }
  }
  // Every path walker steps over list regions, so a path after a `<for>` needs no list offset.
  const preparedPathExpression = (path: readonly number[]): string =>
    `${runtimeNames.preparedNodeAt}(root, ${JSON.stringify(path)})`;
  const bindingNodeExpression = (path: readonly number[]): string =>
    needsConditionalPrepare && path.length > 0 ? preparedPathExpression(path) : nodeExpression(path);
  const bindingElementExpression = (path: readonly number[]): string =>
    needsConditionalPrepare && path.length > 0 ? preparedPathExpression(path) : elementExpression(path);
  const bindingTextExpression = (path: readonly number[]): string => {
    return needsConditionalPrepare
      ? `${runtimeNames.textAt}(${bindingNodeExpression(path)}, [])`
      : `${runtimeNames.textAt}(root, ${JSON.stringify(path)})`;
  };
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
      const target = bindingTextExpression(binding.path);
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
      const target = bindingElementExpression(binding.path);
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
      // Conditional anchors shift the live DOM, so the target is resolved through the prepared path first and
      // then delegated with an empty path of its own.
      const [eventRoot, eventPath] = needsConditionalPrepare
        ? [bindingNodeExpression(binding.path), "[]"]
        : ["root", JSON.stringify(binding.path)];
      const statement = `${runtimeNames.delegate}(${eventRoot}, ${JSON.stringify(binding.eventName)}, ${eventPath}, ${expressionToScopeAccess(binding.handler, new Set(), scopeName(needsStore), bindingAliases)})`;
      lines.push(`  cleanups.push(${statement});`);
    } else if (binding.kind === "attr") {
      const target = bindingElementExpression(binding.path);
      const value = runtimeValueExpression(binding.expression, reactive, sourceName, bindingAliases);
      const write = (element: string) =>
        isKnownClassAttribute(binding)
          ? `${runtimeNames.setClassValue}(${element}, ${value})`
          : `${runtimeNames.setAttributeValue}(${element}, ${JSON.stringify(binding.name)}, ${value})`;
      if (reactive) {
        const targetName = `__tachyonTarget${targetIndex++}`;
        lines.push(`  const ${targetName} = ${target};`);
        lines.push(`  cleanups.push(${runtimeNames.effect}(() => ${write(targetName)}));`);
      } else {
        lines.push(`  ${write(target)};`);
      }
    } else if (binding.kind === "style") {
      const target = bindingElementExpression(binding.path);
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
      const ref = refTargetExpressions(binding.expression, bindingAliases);
      lines.push(
        `  cleanups.push(${runtimeNames.bindRef}(${sourceName}, ${ref.owner}, ${JSON.stringify(ref.property)}, ${bindingElementExpression(binding.path)}));`,
      );
    } else if (binding.kind === "model") {
      const target = bindingElementExpression(binding.path);
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
      const targetName =
        needsConditionalPrepare || reactive || isTextOnlyList(binding) ? `__tachyonTarget${targetIndex++}` : undefined;
      lines.push(
        emitListBinding(
          binding,
          reactive,
          sourceName,
          listIndex++,
          instrumentBindings,
          targetName,
          bindingAliases,
          bindingElementExpression,
        ),
      );
    } else {
      const targetName =
        (needsConditionalPrepare || reactive) && !usesConditionalCore(binding)
          ? `__tachyonTarget${targetIndex++}`
          : undefined;
      lines.push(
        emitConditionalBinding(
          binding,
          reactive,
          sourceName,
          conditionalIndex++,
          instrumentBindings,
          targetName,
          bindingAliases,
          bindingNodeExpression,
          conditionalVisibilityNames.has(binding)
            ? reactive
              ? `${conditionalVisibilityNames.get(binding)}()`
              : conditionalVisibilityNames.get(binding)
            : undefined,
        ),
      );
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
  if (needsManualCleanup) {
    lines.push(`  return () => {`);
    lines.push(`    let __tachyonCleanupError;`);
    lines.push(`    let __tachyonCleanupFailed = false;`);
    lines.push(`    for (const cleanup of cleanups) {`);
    lines.push(`      try { cleanup(); } catch (error) {`);
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
    lines.push(`  } catch (error) {`);
    lines.push(`    for (const cleanup of cleanups.splice(0).reverse()) {`);
    lines.push(`      try { cleanup(); } catch {}`);
    lines.push(`    }`);
    lines.push(`    throw error;`);
    lines.push(`  }`);
  } else {
    // Nothing registered a disposer, so the module's disposer is the reactive root's own idempotent one.
    lines.push(`  return __tachyonDisposeRoot;`);
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
      lines.push(`  const state = ${runtimeNames.createStore}(scope, { ${instanceStoreFields()} });`);
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

/**
 * A generated region's identity. The runtime only compares it: two options objects with the same signature
 * describe the same list or branch, so a container already holding one can keep its DOM.
 *
 * The structure it is built from is a development diagnostic - it is what a duplicate-key warning points at -
 * so it is spelled out only in a module that carries the rest of the development instrumentation. Every other
 * build identifies the same shape by a digest of it, rather than shipping the template HTML and every
 * expression string a second time next to the readers that replaced them.
 */
const regionSignature = (prefix: string, structure: unknown, detailed: boolean): string => {
  const detail = JSON.stringify(structure);
  return `${prefix}:${detailed ? detail : hexDigest(sha256(utf8ToBytes(detail))).slice(0, 16)}`;
};

const listSignature = (binding: ListBinding, detailed: boolean): string =>
  regionSignature(
    "list",
    {
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
    },
    detailed,
  );

const conditionalSignature = (binding: ConditionalBinding, detailed: boolean): string =>
  regionSignature(
    "if",
    {
      path: binding.path,
      test: binding.test,
      templateHtml: binding.templateHtml,
      bindings: binding.bindings,
      stores: binding.stores ?? [],
      hydrationBoundaries: binding.hydrationBoundaries ?? [],
      components: binding.components ?? [],
    },
    detailed,
  );

const bindingReadExpression = (expression: string, aliases: ReadonlyMap<string, string> = new Map()): string =>
  expressionToScopeAccess(expression, new Set(), "scope", aliases);

/**
 * The container reader and property name for a ref. The runtime used to receive the path as a string and walk
 * it, which meant the generated module shipped a path parser for one assignment. Handing it the container
 * rather than a reader/writer pair keeps that parser out and lets the runtime capture the object it wrote into,
 * so the clear on dispose cannot land on whatever the path names by then.
 */
const refTargetExpressions = (
  expression: string,
  aliases: ReadonlyMap<string, string>,
): { owner: string; property: string } => {
  const parts = expression.split(".");
  const property = parts.length === 1 ? (aliases.get(expression) ?? expression) : (parts.at(-1) as string);
  // Every step to the object that holds the ref is optional, the way the path walker this replaces was: a ref
  // whose container is missing is left alone rather than thrown at.
  const owner = parts
    .slice(1, -1)
    .reduce(
      (access, part) => jsOptionalPropertyAccess(access, part),
      parts.length === 1 ? "scope" : bindingReadExpression(parts[0] as string, aliases),
    );
  return { owner: `(scope) => ${owner}`, property };
};

const serializeStoreDefinition = (store: StoreDefinition): string => {
  const key = declarationKeyFor(store, store.name);
  const keyField = key === store.name ? "" : `, key: ${JSON.stringify(key)}`;
  return `{ name: ${JSON.stringify(store.name)}${keyField}, read: (scope) => ${bindingReadExpression(store.initial, aliasesForDeclaration(store))} }`;
};

const serializeComponentBoundary = (component: NonNullable<ListBinding["components"]>[number]): string => {
  const props = component.props
    .map(
      (prop) =>
        `{ name: ${JSON.stringify(prop.name)}, ${declarationKeyFor(prop, prop.name) === prop.name ? "" : `key: ${JSON.stringify(declarationKeyFor(prop, prop.name))}, `}read: (scope) => ${bindingReadExpression(prop.expression, aliasesForDeclaration(prop))} }`,
    )
    .join(", ");
  const stores = component.stores.map(serializeStoreDefinition).join(", ");
  return `{ path: ${JSON.stringify(component.path)}, name: ${JSON.stringify(component.name)}, props: [${props}], stores: [${stores}] }`;
};

const serializeStoreDefinitions = (stores: readonly StoreDefinition[]): string =>
  `[${stores.map(serializeStoreDefinition).join(", ")}]`;

const serializeComponentBoundaries = (components: readonly NonNullable<ListBinding["components"]>[number][]): string =>
  `[${components.map(serializeComponentBoundary).join(", ")}]`;

/**
 * A boundary id written as an expression is compiled into a reader like every other value, so a concatenated
 * or aliased id resolves the way its author read it. The runtime keeps the string for diagnostics only.
 */
const serializeHydrationBoundaries = (boundaries: readonly HydrationBoundary[]): string =>
  `[${boundaries
    .map((boundary) =>
      boundary.idKind === "expression"
        ? `{ ...${JSON.stringify(boundary)}, idRead: (scope) => ${bindingReadExpression(boundary.id, aliasesForDeclaration(boundary))} }`
        : JSON.stringify(boundary),
    )
    .join(", ")}]`;

/** The hydration runtime a generated region adopts its boundaries through, when it declares any. */
const nestedHydrationRuntimeField = (binding: { hydrationBoundaries?: HydrationBoundary[] }): string[] =>
  (binding.hydrationBoundaries?.length ?? 0) > 0
    ? [`hydration: { create: ${runtimeNames.createHydrationBoundary}, schedule: ${runtimeNames.scheduleHydration} }`]
    : [];

/** The setter a generated row applies this value with. Rows and branches emit the same expressions. */
const rowValueSetter = (binding: ClassBinding | AttributeBinding | StyleBinding): string => {
  if (binding.kind === "class") {
    return `${runtimeNames.setClassPresence}(node, ${JSON.stringify(binding.className)}, value)`;
  }
  if (binding.kind === "style") {
    return `${runtimeNames.setStyleValue}(node, ${JSON.stringify(binding.name)}, value)`;
  }
  // A statically named class attribute is exactly what setClassValue does, so it skips the generic setter's
  // name validation and URL sanitization, neither of which ever applied to class.
  return binding.name.toLowerCase() === "class"
    ? `${runtimeNames.setClassValue}(node, value)`
    : `${runtimeNames.setAttributeValue}(node, ${JSON.stringify(binding.name)}, value)`;
};

/**
 * Generated bindings carry compiled readers, so the expression strings they were parsed from never ship. A ref
 * is the exception: the runtime writes back through the container reader and property name it carries.
 *
 * Everything here is driven by a generated runtime - the generated keyed list, or the generic branch runtime's
 * generated entry - and both take their setters from the descriptor. So each value binding carries the setter
 * that applies it, each control its binder, and each nested region the entry that mounts it. Neither runtime
 * imports one of its own.
 */
const serializeListRowBinding = (binding: ListBinding["bindings"][number], detailed: boolean): string => {
  const fields: string[] = [`kind: ${JSON.stringify(binding.kind)}`, `path: ${JSON.stringify(binding.path)}`];
  const aliases = aliasesForBinding(binding);
  if (binding.kind === "text") {
    fields.push(`read: (scope) => ${bindingReadExpression(binding.expression, aliases)}`);
  } else if (binding.kind === "class") {
    fields.push(`className: ${JSON.stringify(binding.className)}`);
    fields.push(`read: (scope) => ${bindingReadExpression(binding.expression, aliases)}`);
    fields.push(`apply: (node, value) => ${rowValueSetter(binding)}`);
  } else if (binding.kind === "event") {
    fields.push(`eventName: ${JSON.stringify(binding.eventName)}`);
    fields.push(`read: (scope) => ${bindingReadExpression(binding.handler, aliases)}`);
  } else if (binding.kind === "attr") {
    fields.push(`name: ${JSON.stringify(binding.name)}`);
    fields.push(`read: (scope) => ${bindingReadExpression(binding.expression, aliases)}`);
    fields.push(`apply: (node, value) => ${rowValueSetter(binding)}`);
  } else if (binding.kind === "style") {
    fields.push(`name: ${JSON.stringify(binding.name)}`);
    fields.push(`read: (scope) => ${bindingReadExpression(binding.expression, aliases)}`);
    fields.push(`apply: (node, value) => ${rowValueSetter(binding)}`);
  } else if (binding.kind === "ref") {
    const ref = refTargetExpressions(binding.expression, aliases);
    fields.push(`owner: ${ref.owner}`);
    fields.push(`property: ${JSON.stringify(ref.property)}`);
  } else if (binding.kind === "model") {
    const target = bindingReadExpression(binding.expression, aliases);
    const write = `${runtimeNames.writeModelValue}(${target}, value, () => { ${target} = value; })`;
    fields.push(`property: ${JSON.stringify(binding.property)}`);
    fields.push(`read: (scope) => ${target}`);
    fields.push(
      `apply: (node, value) => ${runtimeNames.setControlValue}(node, ${JSON.stringify(binding.property)}, value)`,
    );
    fields.push(
      `bind: (scope, element) => ${runtimeNames.bindControl}(element, ${JSON.stringify(binding.property)}, () => ${runtimeValueExpression(binding.expression, true, "scope", aliases)}, (value) => ${write})`,
    );
  } else if (binding.kind === "list") {
    const itemKeyExpression = simpleItemKeyExpression(binding.key, binding.itemName);
    fields.push(`signature: ${JSON.stringify(listSignature(binding, detailed))}`);
    fields.push(`mount: ${runtimeNames.mountGeneratedKeyedList}`);
    fields.push(`each: ${JSON.stringify(binding.each)}`);
    fields.push(`read: (scope) => ${bindingReadExpression(binding.each, aliases)}`);
    fields.push(`itemName: ${JSON.stringify(binding.itemName)}`);
    if (binding.indexName) fields.push(`indexName: ${JSON.stringify(binding.indexName)}`);
    fields.push(`key: ${JSON.stringify(binding.key)}`);
    if (binding.updatePolicy) fields.push(`updatePolicy: ${JSON.stringify(binding.updatePolicy)}`);
    if (binding.region) fields.push(`region: ${JSON.stringify(binding.region)}`);
    fields.push(`stores: ${serializeStoreDefinitions(binding.stores ?? [])}`);
    fields.push(`hydrationBoundaries: ${serializeHydrationBoundaries(binding.hydrationBoundaries ?? [])}`);
    fields.push(...nestedHydrationRuntimeField(binding));
    fields.push(`components: ${serializeComponentBoundaries(binding.components ?? [])}`);
    fields.push(
      itemKeyExpression
        ? `keyReadItem: (${binding.itemName}) => ${itemKeyExpression}`
        : `keyRead: (scope) => ${bindingReadExpression(binding.key, aliases)}`,
    );
    fields.push(`templateHtml: ${JSON.stringify(binding.templateHtml)}`);
    fields.push(`bindings: [${binding.bindings.map((child) => serializeListRowBinding(child, detailed)).join(", ")}]`);
  } else if (binding.kind === "if") {
    fields.push(`signature: ${JSON.stringify(conditionalSignature(binding, detailed))}`);
    fields.push(`test: ${JSON.stringify(binding.test)}`);
    fields.push(`read: (scope) => ${bindingReadExpression(binding.test, aliases)}`);
    fields.push(`mount: ${runtimeNames.mountGeneratedConditional}`);
    fields.push(`templateHtml: ${JSON.stringify(binding.templateHtml)}`);
    fields.push(`stores: ${serializeStoreDefinitions(binding.stores ?? [])}`);
    fields.push(`hydrationBoundaries: ${serializeHydrationBoundaries(binding.hydrationBoundaries ?? [])}`);
    fields.push(...nestedHydrationRuntimeField(binding));
    fields.push(`components: ${serializeComponentBoundaries(binding.components ?? [])}`);
    fields.push(`bindings: [${binding.bindings.map((child) => serializeListRowBinding(child, detailed)).join(", ")}]`);
  }
  return `{ ${fields.join(", ")} }`;
};

/**
 * Parent scope keys a keyed list's rows read, or `undefined` when the analysis cannot bound them.
 *
 * A row scope is the bounded parent snapshot plus the item, the index, and the row's own declarations, each
 * stored under the declaration key the generated readers use. So a name is a parent dependency exactly when the
 * key its reader resolves to - after the same alias mapping the reader applies - is not provided by this row or
 * by an enclosing row. Nested regions are walked with their own provided keys, so a nested list's item name
 * shadows only inside that list.
 *
 * Any call gives up the bound: a scope member invoked as a method receives the row scope as `this`, and any
 * function can close over names the expression never mentions.
 *
 * Every expression the row evaluates at runtime counts, not only the ones that put something on screen: a
 * hydration boundary's id is read from the row scope too, and a row that cannot resolve it silently loses the
 * boundary and binds its contents eagerly.
 */
const listParentScopeNames = (binding: ListBinding): ReadonlySet<string> | undefined => {
  const names = new Set<string>();
  let bounded = true;

  const add = (expression: string, aliases: ReadonlyMap<string, string>, provided: ReadonlySet<string>): void => {
    if (!bounded) return;
    if (expressionCallsSomething(expression)) {
      bounded = false;
      return;
    }
    const found = expressionScopeNames(expression);
    if (!found) {
      bounded = false;
      return;
    }
    for (const name of found) {
      const key = aliases.get(name) ?? name;
      if (!provided.has(key)) names.add(key);
    }
  };

  // A boundary id is read back through the reader compiled for it, so it is analyzed like any other expression.
  const addBoundaryIds = (
    boundaries: readonly HydrationBoundary[] | undefined,
    provided: ReadonlySet<string>,
  ): void => {
    for (const boundary of boundaries ?? []) {
      // The same condition the runtime resolves an id under: anything else is a literal it already holds.
      if (boundary.idKind !== "expression") continue;
      add(boundary.id, aliasesForDeclaration(boundary), provided);
    }
  };

  const visitDeclarations = (
    stores: readonly StoreDefinition[] | undefined,
    components: readonly ComponentBoundary[] | undefined,
    provided: Set<string>,
  ): void => {
    // Each initial expression is evaluated before its own name joins the row scope, so it can read a parent key
    // of the same name.
    for (const store of stores ?? []) {
      add(store.initial, aliasesForDeclaration(store), provided);
      provided.add(declarationKeyFor(store, store.name));
    }
    for (const component of components ?? []) {
      for (const prop of component.props) {
        add(prop.expression, aliasesForDeclaration(prop), provided);
        provided.add(declarationKeyFor(prop, prop.name));
      }
      for (const store of component.stores) {
        add(store.initial, aliasesForDeclaration(store), provided);
        provided.add(declarationKeyFor(store, store.name));
      }
    }
  };

  const visitList = (list: ListBinding, enclosing: ReadonlySet<string>): void => {
    const provided = new Set(enclosing);
    provided.add(list.itemName);
    if (list.indexName) provided.add(list.indexName);
    // The key reader runs against a scope that already binds the item.
    add(list.key, aliasesForBinding(list), provided);
    visitDeclarations(list.stores, list.components, provided);
    addBoundaryIds(list.hydrationBoundaries, provided);
    visitBindings(list.bindings, provided);
  };

  const visitBindings = (children: readonly ClientBinding[], provided: ReadonlySet<string>): void => {
    for (const child of children) {
      const aliases = aliasesForBinding(child);
      if (child.kind === "event") add(child.handler, aliases, provided);
      else if (child.kind === "if") {
        add(child.test, aliases, provided);
        const branch = new Set(provided);
        visitDeclarations(child.stores, child.components, branch);
        addBoundaryIds(child.hydrationBoundaries, branch);
        visitBindings(child.bindings, branch);
      } else if (child.kind === "list") {
        // `each` is read in the enclosing scope; the key and the rows are read in the nested one.
        add(child.each, aliases, provided);
        visitList(child, provided);
      } else add(child.expression, aliases, provided);
    }
  };

  visitList(binding, new Set<string>());
  return bounded ? names : undefined;
};

const parentScopeKeysField = (binding: ListBinding): string[] => {
  const names = listParentScopeNames(binding);
  return names ? [`    parentScopeKeys: ${JSON.stringify([...names].sort())},`] : [];
};

type GeneratedValueBinding = TextBinding | ClassBinding | AttributeBinding | StyleBinding;

const isGeneratedValueBinding = (binding: ClientBinding): binding is GeneratedValueBinding =>
  binding.kind === "text" || binding.kind === "class" || binding.kind === "attr" || binding.kind === "style";

const isGeneratedEventBinding = (binding: ClientBinding): binding is EventBinding => binding.kind === "event";

/**
 * One generated value binding: its reader, and unless it targets a text node, the setter that applies it. Rows
 * and branches share this shape, so neither runtime classifies a binding or imports a setter of its own.
 */
const generatedValueBindingField = (binding: GeneratedValueBinding): string => {
  const path = `path: ${JSON.stringify(binding.path)}`;
  const read = `read: (scope) => ${bindingReadExpression(binding.expression, aliasesForBinding(binding))}`;
  if (binding.kind === "class") {
    return `{ ${path}, ${read}, apply: (node, value) => ${runtimeNames.setClassPresence}(node, ${JSON.stringify(binding.className)}, value) }`;
  }
  if (binding.kind === "style") {
    return `{ ${path}, ${read}, apply: (node, value) => ${runtimeNames.setStyleValue}(node, ${JSON.stringify(binding.name)}, value) }`;
  }
  if (binding.kind === "attr") {
    // A statically named class attribute is exactly what setClassValue does, so it skips the generic setter's
    // name validation and URL sanitization, neither of which ever applied to class.
    const setter =
      binding.name.toLowerCase() === "class"
        ? `${runtimeNames.setClassValue}(node, value)`
        : `${runtimeNames.setAttributeValue}(node, ${JSON.stringify(binding.name)}, value)`;
    return `{ ${path}, ${read}, apply: (node, value) => ${setter} }`;
  }
  return `{ ${path}, ${read} }`;
};

const generatedBindingFields = (
  bindings: readonly ClientBinding[],
  serializeEvent: (binding: EventBinding) => string,
): string[] => {
  const events = bindings.filter(isGeneratedEventBinding);
  return [
    `    bindings: [${bindings.filter(isGeneratedValueBinding).map(generatedValueBindingField).join(", ")}],`,
    ...(events.length > 0 ? [`    events: [${events.map(serializeEvent).join(", ")}],`] : []),
  ];
};

/**
 * Value bindings and row listeners for the generated list adapter. Each binding carries the setter it needs, so
 * the adapter module never imports the class, attribute, or event runtimes itself.
 */
const generatedRowBindingFields = (binding: ListBinding): string[] =>
  // The handler is read when the event fires, not when the listener is registered, so replacing an item's
  // handler under the same key takes effect the way the generic runtime's rows already do.
  generatedBindingFields(
    binding.bindings,
    (child) =>
      `{ path: ${JSON.stringify(child.path)}, bind: (element, scope) => ${runtimeNames.delegate}(element, ${JSON.stringify(child.eventName)}, [], (event) => { const handler = ${bindingReadExpression(child.handler, aliasesForBinding(child))}; if (typeof handler === "function") handler(event); }) }`,
  );

/**
 * Value bindings and listeners for a generated conditional branch. The shape mirrors the generated rows: each
 * value carries its setter, so the branch runtime keeps only the text path.
 */
const generatedBranchBindingFields = (binding: ConditionalBinding): string[] =>
  // A branch kept across runs is rebound to the newest scope without rebinding its listeners, so the handler is
  // read from the scope the branch currently holds when the event fires.
  generatedBindingFields(
    binding.bindings,
    (child) =>
      `{ path: ${JSON.stringify(child.path)}, bind: (element, readScope) => ${runtimeNames.delegate}(element, ${JSON.stringify(child.eventName)}, [], (event) => { const scope = readScope(); const handler = ${bindingReadExpression(child.handler, aliasesForBinding(child))}; if (typeof handler === "function") handler(event); }) }`,
  );

const emitListBinding = (
  binding: ListBinding,
  reactive: boolean,
  sourceName: string,
  index: number,
  detailed: boolean,
  targetName?: string,
  aliases: ReadonlyMap<string, string> = new Map(),
  targetExpression: (path: readonly number[]) => string = elementExpression,
): string => {
  const optionsName = `listOptions${index}`;
  const itemKeyExpression = simpleItemKeyExpression(binding.key, binding.itemName);
  const listOptions = [
    `  const ${optionsName} = {`,
    `    signature: ${JSON.stringify(listSignature(binding, detailed))},`,
    `    key: ${JSON.stringify(binding.key)},`,
    itemKeyExpression
      ? `    keyReadItem: (${binding.itemName}) => ${itemKeyExpression},`
      : `    keyRead: (scope) => ${bindingReadExpression(binding.key, aliases)},`,
    `    itemName: ${JSON.stringify(binding.itemName)},`,
    ...(binding.indexName ? [`    indexName: ${JSON.stringify(binding.indexName)},`] : []),
    ...parentScopeKeysField(binding),
    ...(binding.updatePolicy ? [`    updatePolicy: ${JSON.stringify(binding.updatePolicy)},`] : []),
    ...(binding.region ? [`    region: ${JSON.stringify(binding.region)},`] : []),
    `    stores: ${serializeStoreDefinitions(binding.stores ?? [])},`,
    `    hydrationBoundaries: ${serializeHydrationBoundaries(binding.hydrationBoundaries ?? [])},`,
    ...(isTextOnlyList(binding) ? [] : nestedHydrationRuntimeField(binding).map((field) => `    ${field},`)),
    `    components: ${serializeComponentBoundaries(binding.components ?? [])},`,
    `    scope: ${sourceName},`,
    `    templateHtml: ${JSON.stringify(binding.templateHtml)},`,
    ...(isTextOnlyList(binding)
      ? generatedRowBindingFields(binding)
      : [`    bindings: [${binding.bindings.map((child) => serializeListRowBinding(child, detailed)).join(", ")}],`]),
    `  };`,
  ].join("\n");
  const target = targetName ?? "root";
  const path = targetName ? [] : binding.path;
  const mount = isTextOnlyList(binding) ? runtimeNames.mountTextKeyedList : runtimeNames.mountGeneratedKeyedList;
  const statement = `${mount}(${target}, ${JSON.stringify(path)}, ${runtimeValueExpression(binding.each, reactive, sourceName, aliases)}, ${optionsName})`;
  const targetDeclaration = targetName ? `  const ${targetName} = ${targetExpression(binding.path)};\n` : "";
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
  detailed: boolean,
  targetName?: string,
  aliases: ReadonlyMap<string, string> = new Map(),
  targetExpression: (path: readonly number[]) => string = nodeExpression,
  visibilityExpression?: string,
): string => {
  const optionsName = `conditionalOptions${index}`;
  const useCore = usesConditionalCore(binding);
  const conditionalOptions = [
    `  const ${optionsName} = {`,
    `    signature: ${JSON.stringify(conditionalSignature(binding, detailed))},`,
    `    templateHtml: ${JSON.stringify(binding.templateHtml)},`,
    ...(useCore
      ? generatedBranchBindingFields(binding)
      : [
          `    stores: ${serializeStoreDefinitions(binding.stores ?? [])},`,
          `    hydrationBoundaries: ${serializeHydrationBoundaries(binding.hydrationBoundaries ?? [])},`,
          ...nestedHydrationRuntimeField(binding).map((field) => `    ${field},`),
          `    components: ${serializeComponentBoundaries(binding.components ?? [])},`,
          `    bindings: [${binding.bindings.map((child) => serializeListRowBinding(child, detailed)).join(", ")}],`,
        ]),
    `  };`,
  ].join("\n");
  const target = targetName ?? "root";
  const path = targetName ? [] : binding.path;
  const visible = visibilityExpression ?? runtimeValueExpression(binding.test, reactive, sourceName, aliases);
  const statement = useCore
    ? `${runtimeNames.mountGeneratedConditionalCore}(root, ${JSON.stringify(binding.path)}, ${visible}, ${sourceName}, ${optionsName})`
    : `${runtimeNames.mountGeneratedConditional}(${target}, ${JSON.stringify(path)}, ${visible}, ${sourceName}, ${optionsName})`;
  const targetDeclaration =
    useCore || !targetName ? "" : `  const ${targetName} = ${targetExpression(binding.path)};\n`;
  if (!reactive) return `${targetDeclaration}${conditionalOptions}\n  ${statement};`;
  return `${targetDeclaration}${conditionalOptions}\n  cleanups.push(${runtimeNames.effect}(() => ${statement}));`;
};
