import { err, ok, type Result } from "./result";

export type CompilerError = {
  message: string;
  offset: number;
};

export type Attribute = {
  name: string;
  value: string | true;
};

export type ElementNode = {
  type: "element";
  tagName: string;
  attrs: Attribute[];
  children: TemplateNode[];
};

export type TextNode = {
  type: "text";
  value: string;
};

export type TemplateNode = ElementNode | TextNode;

export type TextBinding = {
  kind: "text";
  path: number[];
  expression: string;
};

export type ClassBinding = {
  kind: "class";
  path: number[];
  className: string;
  expression: string;
};

export type EventBinding = {
  kind: "event";
  path: number[];
  eventName: string;
  handler: string;
};

export type ListBinding = {
  kind: "list";
  path: number[];
  each: string;
  itemName: string;
  key: string;
  templateHtml: string;
  bindings: ClientBinding[];
};

export type ConditionalBinding = {
  kind: "if";
  path: number[];
  test: string;
  templateHtml: string;
  bindings: Array<TextBinding | ClassBinding | EventBinding>;
};

export type ClientBinding = TextBinding | ClassBinding | EventBinding | ListBinding | ConditionalBinding;

export type StoreDefinition = {
  name: string;
  initial: string;
};

export type HydrationBoundary = {
  path: number[];
  id: string;
};

export type TemplateDirective =
  | { kind: "for"; path: number[]; each: string; key: string; itemName: string }
  | { kind: "if"; path: number[]; test: string }
  | { kind: "store"; path: number[]; stores: StoreDefinition[] }
  | { kind: "event"; path: number[]; eventName: string; handler: string }
  | { kind: "component"; path: number[]; name: string }
  | { kind: "hydrate"; path: number[]; id: string };

export type TemplateIr = {
  kind: "template";
  root: ElementNode;
  directives: TemplateDirective[];
};

export type CompiledTemplate = {
  source: string;
  ir: TemplateIr;
  root: ElementNode;
  client: {
    templateHtml: string;
    bindings: ClientBinding[];
    stores: StoreDefinition[];
    hydrationBoundaries: HydrationBoundary[];
  };
};

type LoweringContext = {
  bindings: ClientBinding[];
  stores: StoreDefinition[];
  hydrationBoundaries: HydrationBoundary[];
};

type Parser = {
  source: string;
  offset: number;
};

const expressionPattern = /\{([^{}]+)\}/g;
const identifierPattern = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

const isWhitespace = (char: string | undefined): boolean =>
  char === " " || char === "\n" || char === "\t" || char === "\r";

const parserError = (parser: Parser, message: string): Result<never, CompilerError> =>
  err({ message, offset: parser.offset });

const peek = (parser: Parser): string | undefined => parser.source[parser.offset];

const startsWith = (parser: Parser, value: string): boolean => parser.source.startsWith(value, parser.offset);

const consumeWhitespace = (parser: Parser): void => {
  while (isWhitespace(peek(parser))) {
    parser.offset++;
  }
};

const readWhile = (parser: Parser, predicate: (char: string) => boolean): string => {
  const start = parser.offset;
  while (parser.offset < parser.source.length) {
    const char = parser.source[parser.offset] as string;
    if (!predicate(char)) {
      break;
    }
    parser.offset++;
  }
  return parser.source.slice(start, parser.offset);
};

const readName = (parser: Parser): Result<string, CompilerError> => {
  const name = readWhile(parser, (char) => /[A-Za-z0-9:_$.-]/.test(char));
  if (!name) {
    return parserError(parser, "Expected a name.");
  }
  return ok(name);
};

const readQuotedValue = (parser: Parser): Result<string, CompilerError> => {
  const quote = peek(parser);
  if (quote !== `"` && quote !== `'`) {
    return parserError(parser, "Expected a quoted attribute value.");
  }
  parser.offset++;
  const start = parser.offset;
  while (parser.offset < parser.source.length && peek(parser) !== quote) {
    parser.offset++;
  }
  if (peek(parser) !== quote) {
    return parserError(parser, "Unclosed attribute value.");
  }
  const value = parser.source.slice(start, parser.offset);
  parser.offset++;
  return ok(value);
};

const readAttributeValue = (parser: Parser): Result<string, CompilerError> => {
  if (peek(parser) === `"` || peek(parser) === `'`) {
    return readQuotedValue(parser);
  }
  return ok(readWhile(parser, (char) => !isWhitespace(char) && char !== ">" && char !== "/"));
};

const readExpressionAttribute = (value: string | true): string | undefined => {
  if (value === true) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return undefined;
  }
  return trimmed.slice(1, -1).trim();
};

const attrExpression = (node: ElementNode, name: string): string | undefined => {
  const attr = node.attrs.find((candidate) => candidate.name === name);
  return attr ? readExpressionAttribute(attr.value) : undefined;
};

const isForNode = (node: TemplateNode): node is ElementNode => node.type === "element" && node.tagName === "for";
const isStoreNode = (node: TemplateNode): node is ElementNode => node.type === "element" && node.tagName === "store";

const itemNameFromKey = (key: string): string => {
  const [itemName] = key.split(".");
  return itemName && identifierPattern.test(itemName) ? itemName : "item";
};

const parseAttributes = (parser: Parser): Result<Attribute[], CompilerError> => {
  const attrs: Attribute[] = [];
  while (parser.offset < parser.source.length) {
    consumeWhitespace(parser);
    const char = peek(parser);
    if (char === ">" || startsWith(parser, "/>")) {
      return ok(attrs);
    }
    const nameResult = readName(parser);
    if (!nameResult.ok) {
      return err(nameResult.error);
    }
    consumeWhitespace(parser);
    if (peek(parser) !== "=") {
      attrs.push({ name: nameResult.value, value: true });
      continue;
    }
    parser.offset++;
    consumeWhitespace(parser);
    const valueResult = readAttributeValue(parser);
    if (!valueResult.ok) {
      return err(valueResult.error);
    }
    attrs.push({ name: nameResult.value, value: valueResult.value });
  }
  return parserError(parser, "Unclosed attribute list.");
};

const parseText = (parser: Parser): TextNode => {
  const start = parser.offset;
  while (parser.offset < parser.source.length && peek(parser) !== "<") {
    parser.offset++;
  }
  return { type: "text", value: parser.source.slice(start, parser.offset) };
};

const parseElement = (parser: Parser): Result<ElementNode, CompilerError> => {
  if (peek(parser) !== "<") {
    return parserError(parser, "Expected an opening tag.");
  }
  parser.offset++;
  if (peek(parser) === "/") {
    return parserError(parser, "Unexpected closing tag.");
  }

  const tagNameResult = readName(parser);
  if (!tagNameResult.ok) {
    return err(tagNameResult.error);
  }
  const attrsResult = parseAttributes(parser);
  if (!attrsResult.ok) {
    return err(attrsResult.error);
  }
  if (startsWith(parser, "/>")) {
    parser.offset += 2;
    return ok({ type: "element", tagName: tagNameResult.value, attrs: attrsResult.value, children: [] });
  }
  if (peek(parser) !== ">") {
    return parserError(parser, "Expected end of opening tag.");
  }
  parser.offset++;

  const children: TemplateNode[] = [];
  while (parser.offset < parser.source.length && !startsWith(parser, `</${tagNameResult.value}`)) {
    if (peek(parser) === "<") {
      const childResult = parseElement(parser);
      if (!childResult.ok) {
        return err(childResult.error);
      }
      children.push(childResult.value);
    } else {
      children.push(parseText(parser));
    }
  }

  if (!startsWith(parser, `</${tagNameResult.value}`)) {
    return parserError(parser, `Missing closing tag for <${tagNameResult.value}>.`);
  }
  parser.offset += tagNameResult.value.length + 2;
  consumeWhitespace(parser);
  if (peek(parser) !== ">") {
    return parserError(parser, "Expected end of closing tag.");
  }
  parser.offset++;
  return ok({ type: "element", tagName: tagNameResult.value, attrs: attrsResult.value, children });
};

const parseTemplate = (source: string): Result<ElementNode, CompilerError> => {
  const parser: Parser = { source, offset: 0 };
  consumeWhitespace(parser);
  const rootResult = parseElement(parser);
  if (!rootResult.ok) {
    return err(rootResult.error);
  }
  consumeWhitespace(parser);
  if (parser.offset !== source.length) {
    return err({ message: "Only one root element is currently supported.", offset: parser.offset });
  }
  return rootResult;
};

const escapeHtml = (value: unknown): string =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll(`"`, "&quot;");

const escapeMarker = (value: unknown): string =>
  String(value ?? "")
    .replaceAll("--", "- -")
    .replaceAll(">", "&gt;");

const readPath = (scope: Record<string, unknown>, expression: string): unknown => {
  if (!identifierPattern.test(expression)) {
    return undefined;
  }
  const parts = expression.split(".");
  let current: unknown = scope;
  for (const part of parts) {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
};

const serializeStaticAttr = (attr: Attribute): string => {
  if (attr.value === true) {
    return ` ${attr.name}`;
  }
  return ` ${attr.name}="${attr.value}"`;
};

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
  for (const attr of node.attrs) {
    if (!identifierPattern.test(attr.name)) {
      continue;
    }
    const initial = readExpressionAttribute(attr.value);
    if (initial) {
      context.stores.push({ name: attr.name, initial });
    }
  }
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

const renderableChildren = (node: ElementNode): TemplateNode[] =>
  node.children.filter((child) => child.type !== "text" || child.value.length > 0);

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

const lowerNode = (node: TemplateNode, path: number[], context: LoweringContext): string => {
  if (node.type === "text") {
    return lowerTextNode(node, path, context);
  }
  return lowerElement(node, path, context);
};

export const compileTemplate = (source: string): Result<CompiledTemplate, CompilerError> => {
  const rootResult = parseTemplate(source);
  if (!rootResult.ok) {
    return err(rootResult.error);
  }
  const ir = createTemplateIr(rootResult.value);
  const context: LoweringContext = {
    bindings: [],
    stores: [],
    hydrationBoundaries: [],
  };
  const templateHtml = lowerElement(ir.root, [], context);
  return ok({
    source,
    ir,
    root: ir.root,
    client: {
      templateHtml,
      bindings: context.bindings,
      stores: context.stores,
      hydrationBoundaries: context.hydrationBoundaries,
    },
  });
};

const storeDefinitionsFor = (node: ElementNode): StoreDefinition[] => {
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

const componentName = (node: ElementNode): string => {
  const attr = node.attrs.find((candidate) => candidate.name === "name");
  return typeof attr?.value === "string" ? attr.value : "Anonymous";
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
    directives.push({ kind: "component", path: [...path], name: componentName(node) });
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

const createTemplateIr = (root: ElementNode): TemplateIr => {
  const directives: TemplateDirective[] = [];
  root.children.forEach((child, index) => collectDirectives(child, [index], directives));
  return { kind: "template", root, directives };
};

const renderText = (node: TextNode, scope: Record<string, unknown>): string => {
  let output = "";
  let cursor = 0;
  for (const match of node.value.matchAll(expressionPattern)) {
    const start = match.index ?? 0;
    output += node.value.slice(cursor, start);
    output += escapeHtml(readPath(scope, (match[1] as string).trim()));
    cursor = start + match[0].length;
  }
  output += node.value.slice(cursor);
  return output;
};

const renderElement = (node: ElementNode, scope: Record<string, unknown>): string => {
  if (node.tagName === "for") {
    return renderFor(node, scope);
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
    return node.children.map((child) => renderNode(child, scope)).join("");
  }

  const attrs: string[] = [];
  const classes: string[] = [];
  const hydrateId = attrExpression(node, "hydrate:id");
  for (const attr of node.attrs) {
    if (attr.name.startsWith("on:")) {
      continue;
    }
    if (attr.name === "hydrate:id") {
      continue;
    }
    if (attr.name.startsWith("class:")) {
      const expression = readExpressionAttribute(attr.value);
      if (expression && readPath(scope, expression)) {
        classes.push(attr.name.slice(6));
      }
      continue;
    }
    if (attr.name === "hydrate:id") {
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
  const children = node.children.map((child) => renderNode(child, scope)).join("");
  const html = `<${node.tagName}${attrs.join("")}>${children}</${node.tagName}>`;
  if (!hydrateId) {
    return html;
  }
  const marker = escapeMarker(readPath(scope, hydrateId));
  return `<!--tachyon-hydrate:${marker}:start-->${html}<!--tachyon-hydrate:${marker}:end-->`;
};

const renderFor = (node: ElementNode, scope: Record<string, unknown>): string => {
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
      return node.children.map((child) => renderNode(child, childScope)).join("");
    })
    .join("");
};

const renderNode = (node: TemplateNode, scope: Record<string, unknown>): string => {
  if (node.type === "text") {
    return renderText(node, scope);
  }
  return renderElement(node, scope);
};

export const renderServerTemplate = (template: CompiledTemplate, scope: Record<string, unknown>): string =>
  renderElement(template.root, scope);

const expressionToScopeAccess = (expression: string, locals: ReadonlySet<string> = new Set()): string => {
  if (!identifierPattern.test(expression)) {
    return "undefined";
  }
  const [head] = expression.split(".");
  if (head && locals.has(head)) {
    return expression;
  }
  return `scope.${expression}`;
};

const scopeName = (usesStore: boolean): string => (usesStore ? "state" : "scope");

type GenerateClientModuleOptions = {
  reactive?: boolean;
};

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
    lines.push(`import { setText, textAt } from "@local/tachyon-dom/runtime/text";`);
  }
  if (needsClass) {
    lines.push(`import { elementAt, setClassPresence } from "@local/tachyon-dom/runtime/class";`);
  }
  if (needsEvent) {
    lines.push(`import { delegate } from "@local/tachyon-dom/runtime/event";`);
  }
  if (needsList) {
    lines.push(`import { mountKeyedList } from "@local/tachyon-dom/runtime/list";`);
  }
  if (needsConditional) {
    lines.push(`import { mountConditional } from "@local/tachyon-dom/runtime/conditional";`);
  }
  if (needsSignal) {
    lines.push(`import { effect, read } from "@local/tachyon-dom/runtime/signal";`);
  }
  if (needsStore) {
    lines.push(`import { createStore } from "@local/tachyon-dom/runtime/store";`);
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
      const listOptions = [
        `{`,
        `    key: ${JSON.stringify(binding.key)},`,
        `    itemName: ${JSON.stringify(binding.itemName)},`,
        `    templateHtml: ${JSON.stringify(binding.templateHtml)},`,
        `    bindings: ${JSON.stringify(binding.bindings)},`,
        `  }`,
      ].join("\n");
      const statement = `mountKeyedList(root, ${JSON.stringify(binding.path)}, ${runtimeValueExpression(binding.each, reactive, sourceName)}, ${listOptions})`;
      lines.push(reactive ? `  cleanups.push(effect(() => ${statement}));` : `  ${statement};`);
    } else {
      const conditionalOptions = [
        `{`,
        `    templateHtml: ${JSON.stringify(binding.templateHtml)},`,
        `    bindings: ${JSON.stringify(binding.bindings)},`,
        `  }`,
      ].join("\n");
      const statement = `mountConditional(root, ${JSON.stringify(binding.path)}, ${runtimeValueExpression(binding.test, reactive, sourceName)}, ${sourceName}, ${conditionalOptions})`;
      lines.push(reactive ? `  cleanups.push(effect(() => ${statement}));` : `  ${statement};`);
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

const jsString = (value: string): string => JSON.stringify(value);

const renderTextExpression = (node: TextNode, locals: ReadonlySet<string> = new Set()): string => {
  const parts: string[] = [];
  let cursor = 0;
  for (const match of node.value.matchAll(expressionPattern)) {
    const start = match.index ?? 0;
    const staticText = node.value.slice(cursor, start);
    if (staticText) {
      parts.push(jsString(staticText));
    }
    parts.push(`escapeHtml(${expressionToScopeAccess((match[1] as string).trim(), locals)})`);
    cursor = start + match[0].length;
  }
  const trailing = node.value.slice(cursor);
  if (trailing) {
    parts.push(jsString(trailing));
  }
  return parts.length > 0 ? parts.join(" + ") : `""`;
};

const renderOpenTagExpression = (node: ElementNode, locals: ReadonlySet<string>): string => {
  const parts: string[] = [jsString(`<${node.tagName}`)];
  const staticClasses: string[] = [];
  const dynamicClasses: string[] = [];

  for (const attr of node.attrs) {
    if (attr.name.startsWith("on:")) {
      continue;
    }
    if (attr.name === "hydrate:id") {
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
    const classExpression = `${jsString(staticClasses.join(" "))}${dynamicClasses.length > 0 ? ` + ${dynamicClasses.join(" + ")}` : ""}`;
    parts.push(`(${classExpression} ? ${jsString(` class="`)} + (${classExpression}).trim() + ${jsString(`"`)} : "")`);
  }

  parts.push(jsString(">"));
  return parts.join(" + ");
};

const renderElementExpression = (node: ElementNode, locals: ReadonlySet<string> = new Set()): string => {
  if (node.tagName === "for") {
    return renderForExpression(node, locals);
  }
  if (node.tagName === "if") {
    const test = expressionToScopeAccess(attrExpression(node, "test") ?? "false", locals);
    const childExpression = node.children.map((child) => renderNodeExpression(child, locals)).join(" + ");
    return `(${test} ? ${childExpression || `""`} : "")`;
  }
  if (node.tagName === "store") {
    return `""`;
  }
  if (node.tagName === "component") {
    return node.children.map((child) => renderNodeExpression(child, locals)).join(" + ") || `""`;
  }

  const parts: string[] = [renderOpenTagExpression(node, locals)];
  parts.push(...node.children.map((child) => renderNodeExpression(child, locals)));
  parts.push(jsString(`</${node.tagName}>`));
  const expression = parts.join(" + ");
  const hydrateId = attrExpression(node, "hydrate:id");
  if (!hydrateId) {
    return expression;
  }
  const marker = expressionToScopeAccess(hydrateId, locals);
  return `${jsString("<!--tachyon-hydrate:")} + escapeMarker(${marker}) + ${jsString(":start-->")} + ${expression} + ${jsString("<!--tachyon-hydrate:")} + escapeMarker(${marker}) + ${jsString(":end-->")}`;
};

const renderNodeExpression = (node: TemplateNode, locals: ReadonlySet<string> = new Set()): string => {
  if (node.type === "text") {
    return renderTextExpression(node, locals);
  }
  return renderElementExpression(node, locals);
};

const renderForExpression = (node: ElementNode, locals: ReadonlySet<string>): string => {
  const each = attrExpression(node, "each") ?? "[]";
  const key = attrExpression(node, "key") ?? "item";
  const itemName = itemNameFromKey(key);
  const eachAccess = expressionToScopeAccess(each, locals);
  const childLocals = new Set(locals);
  childLocals.add(itemName);
  const childExpression = node.children.map((child) => renderNodeExpression(child, childLocals)).join(" + ");
  return `(Array.isArray(${eachAccess}) ? ${eachAccess}.map((${itemName}) => ${childExpression || `""`}).join("") : "")`;
};

export const generateServerModule = (template: CompiledTemplate): string => {
  const lines = [
    `const escapeHtml = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");`,
    `const escapeMarker = (value) => String(value ?? "").replaceAll("--", "- -").replaceAll(">", "&gt;");`,
    `export const render = (scope) => ${renderElementExpression(template.root)};`,
  ];
  return `${lines.join("\n")}\n`;
};

const renderTextYieldStatements = (node: TextNode, locals: ReadonlySet<string>, indent: string): string[] => {
  const statements: string[] = [];
  let cursor = 0;
  for (const match of node.value.matchAll(expressionPattern)) {
    const start = match.index ?? 0;
    const staticText = node.value.slice(cursor, start);
    if (staticText) {
      statements.push(`${indent}yield ${jsString(staticText)};`);
    }
    statements.push(`${indent}yield escapeHtml(${expressionToScopeAccess((match[1] as string).trim(), locals)});`);
    cursor = start + match[0].length;
  }
  const trailing = node.value.slice(cursor);
  if (trailing) {
    statements.push(`${indent}yield ${jsString(trailing)};`);
  }
  return statements;
};

const renderForYieldStatements = (node: ElementNode, locals: ReadonlySet<string>, indent: string): string[] => {
  const each = attrExpression(node, "each") ?? "[]";
  const key = attrExpression(node, "key") ?? "item";
  const itemName = itemNameFromKey(key);
  const eachAccess = expressionToScopeAccess(each, locals);
  const childLocals = new Set(locals);
  childLocals.add(itemName);
  const statements = [
    `${indent}if (Array.isArray(${eachAccess})) {`,
    `${indent}  for (const ${itemName} of ${eachAccess}) {`,
  ];
  for (const child of node.children) {
    statements.push(...renderNodeYieldStatements(child, childLocals, `${indent}    `));
  }
  statements.push(`${indent}  }`, `${indent}}`);
  return statements;
};

const renderElementYieldStatements = (node: ElementNode, locals: ReadonlySet<string>, indent: string): string[] => {
  if (node.tagName === "for") {
    return renderForYieldStatements(node, locals, indent);
  }
  if (node.tagName === "if") {
    const statements = [`${indent}if (${expressionToScopeAccess(attrExpression(node, "test") ?? "false", locals)}) {`];
    for (const child of node.children) {
      statements.push(...renderNodeYieldStatements(child, locals, `${indent}  `));
    }
    statements.push(`${indent}}`);
    return statements;
  }
  if (node.tagName === "store") {
    return [];
  }
  if (node.tagName === "component") {
    return node.children.flatMap((child) => renderNodeYieldStatements(child, locals, indent));
  }
  const hydrateId = attrExpression(node, "hydrate:id");
  const statements: string[] = [];
  if (hydrateId) {
    statements.push(
      `${indent}yield ${jsString("<!--tachyon-hydrate:")} + escapeMarker(${expressionToScopeAccess(hydrateId, locals)}) + ${jsString(":start-->")};`,
    );
  }
  statements.push(`${indent}yield ${renderOpenTagExpression(node, locals)};`);
  for (const child of node.children) {
    statements.push(...renderNodeYieldStatements(child, locals, indent));
  }
  statements.push(`${indent}yield ${jsString(`</${node.tagName}>`)};`);
  if (hydrateId) {
    statements.push(
      `${indent}yield ${jsString("<!--tachyon-hydrate:")} + escapeMarker(${expressionToScopeAccess(hydrateId, locals)}) + ${jsString(":end-->")};`,
    );
  }
  return statements;
};

const renderNodeYieldStatements = (node: TemplateNode, locals: ReadonlySet<string>, indent: string): string[] => {
  if (node.type === "text") {
    return renderTextYieldStatements(node, locals, indent);
  }
  return renderElementYieldStatements(node, locals, indent);
};

export const generateServerStreamModule = (template: CompiledTemplate): string => {
  const lines = [
    `const escapeHtml = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");`,
    `const escapeMarker = (value) => String(value ?? "").replaceAll("--", "- -").replaceAll(">", "&gt;");`,
    `export const stream = async function* (scope) {`,
    ...renderNodeYieldStatements(template.root, new Set(), "  "),
    `};`,
  ];
  return `${lines.join("\n")}\n`;
};
