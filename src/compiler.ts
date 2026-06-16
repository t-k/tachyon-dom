import { err, ok, type Result } from "neverthrow";

export type CompilerError = {
  message: string;
  offset: number;
};

type Attribute = {
  name: string;
  value: string | true;
};

type ElementNode = {
  type: "element";
  tagName: string;
  attrs: Attribute[];
  children: TemplateNode[];
};

type TextNode = {
  type: "text";
  value: string;
};

type TemplateNode = ElementNode | TextNode;

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

export type ClientBinding = TextBinding | ClassBinding | EventBinding | ListBinding;

export type CompiledTemplate = {
  source: string;
  root: ElementNode;
  client: {
    templateHtml: string;
    bindings: ClientBinding[];
  };
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
    if (nameResult.isErr()) {
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
    if (valueResult.isErr()) {
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
  if (tagNameResult.isErr()) {
    return err(tagNameResult.error);
  }
  const attrsResult = parseAttributes(parser);
  if (attrsResult.isErr()) {
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
      if (childResult.isErr()) {
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
  if (rootResult.isErr()) {
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

const lowerTextNode = (node: TextNode, path: number[], bindings: ClientBinding[]): string => {
  let output = "";
  let cursor = 0;
  for (const match of node.value.matchAll(expressionPattern)) {
    const start = match.index ?? 0;
    output += node.value.slice(cursor, start);
    bindings.push({ kind: "text", path: [...path], expression: (match[1] as string).trim() });
    output += " ";
    cursor = start + match[0].length;
  }
  output += node.value.slice(cursor);
  return output;
};

const lowerElement = (node: ElementNode, path: number[], bindings: ClientBinding[]): string => {
  if (node.tagName === "for") {
    return "";
  }

  const attrs: string[] = [];
  const staticClassNames: string[] = [];

  for (const attr of node.attrs) {
    if (attr.name.startsWith("on:")) {
      const handler = readExpressionAttribute(attr.value);
      if (handler) {
        bindings.push({ kind: "event", path: [...path], eventName: attr.name.slice(3), handler });
      }
      continue;
    }
    if (attr.name.startsWith("class:")) {
      const expression = readExpressionAttribute(attr.value);
      if (expression) {
        bindings.push({ kind: "class", path: [...path], className: attr.name.slice(6), expression });
      }
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
      bindings.push(lowerList(child, path));
      continue;
    }
    children += lowerNode(child, [...path, domIndex], bindings);
    domIndex++;
  }
  return `<${node.tagName}${attrs.join("")}>${children}</${node.tagName}>`;
};

const lowerList = (node: ElementNode, containerPath: number[]): ListBinding => {
  const key = attrExpression(node, "key") ?? "item";
  const childBindings: ClientBinding[] = [];
  const renderableChildren = node.children.filter((child) => child.type !== "text" || child.value.length > 0);
  const templateHtml = renderableChildren
    .map((child, index) => lowerNode(child, renderableChildren.length === 1 ? [] : [index], childBindings))
    .join("");
  for (const child of node.children.filter(isForNode)) {
    if (isForNode(child)) {
      childBindings.push(lowerList(child, []));
    }
  }
  return {
    kind: "list",
    path: [...containerPath],
    each: attrExpression(node, "each") ?? "[]",
    itemName: itemNameFromKey(key),
    key,
    templateHtml,
    bindings: childBindings,
  };
};

const lowerNode = (node: TemplateNode, path: number[], bindings: ClientBinding[]): string => {
  if (node.type === "text") {
    return lowerTextNode(node, path, bindings);
  }
  return lowerElement(node, path, bindings);
};

export const compileTemplate = (source: string): Result<CompiledTemplate, CompilerError> => {
  const rootResult = parseTemplate(source);
  if (rootResult.isErr()) {
    return err(rootResult.error);
  }
  const bindings: ClientBinding[] = [];
  const templateHtml = lowerElement(rootResult.value, [], bindings);
  return ok({
    source,
    root: rootResult.value,
    client: {
      templateHtml,
      bindings,
    },
  });
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

  const attrs: string[] = [];
  const classes: string[] = [];
  for (const attr of node.attrs) {
    if (attr.name.startsWith("on:")) {
      continue;
    }
    if (attr.name.startsWith("class:")) {
      const expression = readExpressionAttribute(attr.value);
      if (expression && readPath(scope, expression)) {
        classes.push(attr.name.slice(6));
      }
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
  return `<${node.tagName}${attrs.join("")}>${children}</${node.tagName}>`;
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

type GenerateClientModuleOptions = {
  reactive?: boolean;
};

const elementExpression = (path: readonly number[]): string =>
  path.length === 0 ? "root" : `elementAt(root, ${JSON.stringify(path)})`;

const runtimeValueExpression = (expression: string, reactive: boolean): string => {
  const value = expressionToScopeAccess(expression);
  return reactive ? `read(${value})` : value;
};

export const generateClientModule = (template: CompiledTemplate, options: GenerateClientModuleOptions = {}): string => {
  const bindings = template.client.bindings;
  const reactive = options.reactive === true;
  const needsText = bindings.some((binding) => binding.kind === "text");
  const needsClass = bindings.some((binding) => binding.kind === "class");
  const needsEvent = bindings.some((binding) => binding.kind === "event");
  const needsList = bindings.some((binding) => binding.kind === "list");
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
  if (needsSignal) {
    lines.push(`import { effect, read } from "@local/tachyon-dom/runtime/signal";`);
  }
  lines.push(`export const templateHtml = ${JSON.stringify(template.client.templateHtml)};`);
  lines.push(`export const bind = (root, scope) => {`);
  if (reactive || needsEvent) {
    lines.push(`  const cleanups = [];`);
  }
  for (const binding of bindings) {
    if (binding.kind === "text") {
      const statement = `setText(textAt(root, ${JSON.stringify(binding.path)}), ${runtimeValueExpression(binding.expression, reactive)})`;
      lines.push(reactive ? `  cleanups.push(effect(() => ${statement}));` : `  ${statement};`);
    } else if (binding.kind === "class") {
      const statement = `setClassPresence(${elementExpression(binding.path)}, ${JSON.stringify(binding.className)}, ${runtimeValueExpression(binding.expression, reactive)})`;
      lines.push(reactive ? `  cleanups.push(effect(() => ${statement}));` : `  ${statement};`);
    } else if (binding.kind === "event") {
      const statement = `delegate(root, ${JSON.stringify(binding.eventName)}, ${JSON.stringify(binding.path)}, ${expressionToScopeAccess(binding.handler)})`;
      lines.push(`  cleanups.push(${statement});`);
    } else {
      const listOptions = [
        `{`,
        `    key: ${JSON.stringify(binding.key)},`,
        `    itemName: ${JSON.stringify(binding.itemName)},`,
        `    templateHtml: ${JSON.stringify(binding.templateHtml)},`,
        `    bindings: ${JSON.stringify(binding.bindings)},`,
        `  }`,
      ].join("\n");
      const statement = `mountKeyedList(root, ${JSON.stringify(binding.path)}, ${runtimeValueExpression(binding.each, reactive)}, ${listOptions})`;
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

  const parts: string[] = [renderOpenTagExpression(node, locals)];
  parts.push(...node.children.map((child) => renderNodeExpression(child, locals)));
  parts.push(jsString(`</${node.tagName}>`));
  return parts.join(" + ");
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
  const statements = [`${indent}yield ${renderOpenTagExpression(node, locals)};`];
  for (const child of node.children) {
    statements.push(...renderNodeYieldStatements(child, locals, indent));
  }
  statements.push(`${indent}yield ${jsString(`</${node.tagName}>`)};`);
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
    `export const stream = function* (scope) {`,
    ...renderNodeYieldStatements(template.root, new Set(), "  "),
    `};`,
  ];
  return `${lines.join("\n")}\n`;
};
